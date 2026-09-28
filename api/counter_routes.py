"""
counter_routes.py — "Ticket Counter": tally prepaid drink tickets per station.

Used at events where someone else takes payment and hands out drink tickets.
Each station taps a big button per drink as it redeems a ticket; counts are
kept per (event, station, drink).

Endpoints:
  GET    /api/counter/active                  → active event + all its tallies   (any role)
  POST   /api/counter/tap                     → { eventId, station, itemId, delta: 1|-1 } (any role)
  GET    /api/counter/events                  → all events with totals            (owner/staff)
  POST   /api/counter/events                  → create { name, stationCount?, items: [{name}] }
  PUT    /api/counter/events/{id}             → update { name?, stationCount?, items?, active? }
  DELETE /api/counter/events/{id}             → delete event + its tallies
  GET    /api/counter/events/{id}/results     → event + tallies (analytics)

Docs live in the `menu` container (partition key /type):

  counter_event: { "id": "cevt_ab12cd34", "type": "counter_event", "name": "Smith Wedding",
                   "stationCount": 2, "active": true, "createdAt": "...",
                   "items": [{ "id": "citem_1a2b3c4d", "name": "Old Fashioned" }, ...] }

  counter_tally: { "id": "ctally_<eventId>_<station>_<itemId>", "type": "counter_tally",
                   "eventId", "station", "itemId", "itemName", "count", "updatedAt" }

Concurrency: taps use Cosmos patch `incr`, which is atomic server-side, so two
stations (or rapid taps) never lose an update. Decrements carry a filter
predicate (count >= 1) so a count can never go below zero.
"""

import json
import logging
from datetime import datetime, timezone
from uuid import uuid4

import azure.functions as func
from azure.cosmos.exceptions import (
    CosmosAccessConditionFailedError,
    CosmosHttpResponseError,
    CosmosResourceExistsError,
    CosmosResourceNotFoundError,
)

from auth_helper import ANY_ROLE, OWNER_ROLES, authorize
from cosmos_helper import get_menu_container
from signalr_helper import broadcast_counter_changed, broadcast_counter_updated

counter_bp = func.Blueprint()
logger = logging.getLogger(__name__)

EVENT_TYPE = "counter_event"
TALLY_TYPE = "counter_tally"
_MAX_STATIONS = 6
_MAX_ITEMS = 12


# ── Helpers ────────────────────────────────────────────────────────────────────

def _json_response(body: dict | list, status_code: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(body), status_code=status_code, mimetype="application/json")


def _error(message: str, status_code: int) -> func.HttpResponse:
    return _json_response({"error": message}, status_code)


def _parse_body(req: func.HttpRequest) -> tuple[dict | None, func.HttpResponse | None]:
    try:
        data = req.get_json()
        if not isinstance(data, dict):
            return None, _error("Request body must be a JSON object.", 400)
        return data, None
    except ValueError:
        return None, _error("Invalid JSON body.", 400)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read(doc_id: str, partition: str) -> dict | None:
    try:
        return get_menu_container().read_item(item=doc_id, partition_key=partition)
    except CosmosResourceNotFoundError:
        return None


def _public_event(doc: dict) -> dict:
    return {
        "id": doc["id"],
        "name": doc.get("name", ""),
        "stationCount": doc.get("stationCount", 2),
        "active": bool(doc.get("active")),
        "createdAt": doc.get("createdAt"),
        "items": doc.get("items", []),
    }


def _public_tally(doc: dict) -> dict:
    return {
        "station": doc["station"],
        "itemId": doc["itemId"],
        "itemName": doc.get("itemName", ""),
        "count": doc.get("count", 0),
    }


def _tallies_for(event_id: str) -> list[dict]:
    return [_public_tally(t) for t in get_menu_container().query_items(
        query="SELECT * FROM c WHERE c.eventId = @eid",
        parameters=[{"name": "@eid", "value": event_id}],
        partition_key=TALLY_TYPE,
    )]


def _clean_station_count(raw: object) -> int | None:
    try:
        n = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= _MAX_STATIONS else None


def _clean_items(raw: object, existing: list[dict]) -> tuple[list[dict] | None, str | None]:
    """Validate an items list. Items with a known id keep it (so counts follow a rename)."""
    if not isinstance(raw, list) or not raw:
        return None, "Add at least one drink."
    if len(raw) > _MAX_ITEMS:
        return None, f"At most {_MAX_ITEMS} drinks."
    known = {i["id"] for i in existing}
    items: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            return None, "Each drink must be an object."
        name = (entry.get("name") or "").strip()
        if not name:
            return None, "Drink names can't be empty."
        item_id = entry.get("id")
        if item_id not in known:
            item_id = "citem_" + uuid4().hex[:8]
        items.append({"id": item_id, "name": name})
    return items, None


def _deactivate_others(keep_id: str) -> None:
    container = get_menu_container()
    for ev in container.query_items(
        query="SELECT * FROM c WHERE c.active = true", partition_key=EVENT_TYPE,
    ):
        if ev["id"] != keep_id:
            ev["active"] = False
            container.upsert_item(body=ev)


# ── GET /api/counter/active ────────────────────────────────────────────────────

@counter_bp.route(route="counter/active", methods=["GET"])
def counter_active(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, ANY_ROLE)
    if denied:
        return denied
    events = list(get_menu_container().query_items(
        query="SELECT * FROM c WHERE c.active = true", partition_key=EVENT_TYPE,
    ))
    if not events:
        return _json_response({"event": None, "tallies": []})
    event = events[0]
    return _json_response({"event": _public_event(event), "tallies": _tallies_for(event["id"])})


# ── POST /api/counter/tap ──────────────────────────────────────────────────────

@counter_bp.route(route="counter/tap", methods=["POST"])
def counter_tap(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, ANY_ROLE)
    if denied:
        return denied
    body, err = _parse_body(req)
    if err:
        return err

    event_id = str(body.get("eventId") or "")
    item_id = str(body.get("itemId") or "")
    delta = body.get("delta")
    if delta not in (1, -1):
        return _error("'delta' must be 1 or -1.", 400)

    event = _read(event_id, EVENT_TYPE)
    if event is None or not event.get("active"):
        return _error("This counter event isn't active any more.", 409)
    try:
        station = int(body.get("station"))
    except (TypeError, ValueError):
        return _error("'station' is required.", 400)
    if not 1 <= station <= int(event.get("stationCount", 2)):
        return _error("Unknown station.", 400)
    item = next((i for i in event.get("items", []) if i["id"] == item_id), None)
    if item is None:
        return _error("Unknown drink.", 400)

    container = get_menu_container()
    tally_id = f"ctally_{event_id}_{station}_{item_id}"
    ops = [
        {"op": "incr", "path": "/count", "value": delta},
        {"op": "set", "path": "/itemName", "value": item["name"]},
        {"op": "set", "path": "/updatedAt", "value": _now_iso()},
    ]
    # Decrement only when there's something to take away — never below zero.
    predicate = 'FROM c WHERE c["count"] >= 1' if delta < 0 else None

    def _patch() -> int:
        doc = container.patch_item(
            item=tally_id, partition_key=TALLY_TYPE,
            patch_operations=ops, filter_predicate=predicate,
        )
        return int(doc["count"])

    try:
        try:
            count = _patch()
        except CosmosResourceNotFoundError:
            if delta < 0:
                count = 0
            else:
                try:
                    container.create_item(body={
                        "id": tally_id, "type": TALLY_TYPE, "eventId": event_id,
                        "station": station, "itemId": item_id, "itemName": item["name"],
                        "count": 1, "updatedAt": _now_iso(),
                    })
                    count = 1
                except CosmosResourceExistsError:
                    count = _patch()  # the other tap created it first — increment that
        except CosmosAccessConditionFailedError:
            count = 0  # decrement at zero
    except CosmosHttpResponseError as exc:
        if exc.status_code == 412:
            count = 0
        else:
            logger.exception("Counter tap failed for %s", tally_id)
            return _error("Couldn't save that tap. Try again.", 500)
    except Exception:
        logger.exception("Counter tap failed for %s", tally_id)
        return _error("Couldn't save that tap. Try again.", 500)

    result = {"eventId": event_id, "station": station, "itemId": item_id, "count": count}
    broadcast_counter_updated(result)
    return _json_response(result)


# ── GET /api/counter/events ────────────────────────────────────────────────────

@counter_bp.route(route="counter/events", methods=["GET"])
def list_counter_events(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    container = get_menu_container()
    events = list(container.query_items(query="SELECT * FROM c", partition_key=EVENT_TYPE))
    totals: dict[str, int] = {}
    for t in container.query_items(
        query="SELECT c.eventId, c['count'] FROM c", partition_key=TALLY_TYPE,
    ):
        totals[t["eventId"]] = totals.get(t["eventId"], 0) + int(t.get("count", 0))
    events.sort(key=lambda e: e.get("createdAt") or "", reverse=True)
    return _json_response({"events": [
        {**_public_event(e), "totalCount": totals.get(e["id"], 0)} for e in events
    ]})


# ── POST /api/counter/events ───────────────────────────────────────────────────

@counter_bp.route(route="counter/events", methods=["POST"])
def create_counter_event(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    body, err = _parse_body(req)
    if err:
        return err

    name = (body.get("name") or "").strip()
    if not name:
        return _error("Event name is required.", 400)
    stations = _clean_station_count(body.get("stationCount", 2))
    if stations is None:
        return _error(f"Stations must be 1–{_MAX_STATIONS}.", 400)
    items, item_err = _clean_items(body.get("items"), [])
    if item_err:
        return _error(item_err, 400)

    doc = {
        "id": "cevt_" + uuid4().hex[:8],
        "type": EVENT_TYPE,
        "name": name,
        "stationCount": stations,
        "active": bool(body.get("active", False)),
        "createdAt": _now_iso(),
        "items": items,
    }
    get_menu_container().create_item(body=doc)
    if doc["active"]:
        _deactivate_others(doc["id"])
        broadcast_counter_changed()
    logger.info("Created counter event %s", doc["id"])
    return _json_response(_public_event(doc), 201)


# ── GET /api/counter/events/{id}/results  — more-specific, registered first ───

@counter_bp.route(route="counter/events/{id}/results", methods=["GET"])
def counter_event_results(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    event_id: str = req.route_params.get("id", "")
    event = _read(event_id, EVENT_TYPE)
    if event is None:
        return _error("Counter event not found.", 404)
    return _json_response({"event": _public_event(event), "tallies": _tallies_for(event_id)})


# ── PUT /api/counter/events/{id} ───────────────────────────────────────────────

@counter_bp.route(route="counter/events/{id}", methods=["PUT"])
def update_counter_event(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    event_id: str = req.route_params.get("id", "")
    event = _read(event_id, EVENT_TYPE)
    if event is None:
        return _error("Counter event not found.", 404)
    body, err = _parse_body(req)
    if err:
        return err

    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            return _error("Event name can't be empty.", 400)
        event["name"] = name
    if "stationCount" in body:
        stations = _clean_station_count(body["stationCount"])
        if stations is None:
            return _error(f"Stations must be 1–{_MAX_STATIONS}.", 400)
        event["stationCount"] = stations
    if "items" in body:
        items, item_err = _clean_items(body["items"], event.get("items", []))
        if item_err:
            return _error(item_err, 400)
        event["items"] = items
    if "active" in body:
        event["active"] = bool(body["active"])

    get_menu_container().upsert_item(body=event)
    if event["active"]:
        _deactivate_others(event_id)
    broadcast_counter_changed()  # counter screens reload names/items/active event
    logger.info("Updated counter event %s", event_id)
    return _json_response(_public_event(event))


# ── DELETE /api/counter/events/{id} ────────────────────────────────────────────

@counter_bp.route(route="counter/events/{id}", methods=["DELETE"])
def delete_counter_event(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    event_id: str = req.route_params.get("id", "")
    event = _read(event_id, EVENT_TYPE)
    if event is None:
        return _error("Counter event not found.", 404)

    container = get_menu_container()
    tallies = list(container.query_items(
        query="SELECT c.id FROM c WHERE c.eventId = @eid",
        parameters=[{"name": "@eid", "value": event_id}],
        partition_key=TALLY_TYPE,
    ))
    for t in tallies:
        container.delete_item(item=t["id"], partition_key=TALLY_TYPE)
    container.delete_item(item=event_id, partition_key=EVENT_TYPE)
    if event.get("active"):
        broadcast_counter_changed()
    logger.info("Deleted counter event %s and %d tallies", event_id, len(tallies))
    return _json_response({"ok": True})
