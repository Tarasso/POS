"""
order_routes.py — Azure Functions v2 Blueprint for /api/orders/* endpoints.

Phase 2 endpoints:
  GET  /api/orders?status=open   → list orders by status (partition-key query)
  POST /api/orders               → create new order

Phase 3 stub (registered here so the route exists; logic added in Phase 3):
  PATCH /api/orders/{id}/complete → mark order completed + SignalR broadcast
"""

import json
import logging
from datetime import datetime, timezone
from uuid import uuid4

import azure.functions as func

from cosmos_helper import get_orders_container

order_bp = func.Blueprint()
logger = logging.getLogger(__name__)


# ── Private helpers ────────────────────────────────────────────────────────────

def _json_response(body: dict | list, status_code: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(body),
        status_code=status_code,
        mimetype="application/json",
    )


def _error(message: str, status_code: int) -> func.HttpResponse:
    return _json_response({"error": message}, status_code)


def _parse_body(req: func.HttpRequest) -> tuple[dict | None, func.HttpResponse | None]:
    """Parse JSON body; return (data, None) on success or (None, error_response) on failure."""
    try:
        data = req.get_json()
        if not isinstance(data, dict):
            return None, _error("Request body must be a JSON object.", 400)
        return data, None
    except ValueError:
        return None, _error("Invalid JSON body.", 400)


# ── GET /api/orders ────────────────────────────────────────────────────────────

@order_bp.route(route="orders", methods=["GET"])
def list_orders(req: func.HttpRequest) -> func.HttpResponse:
    """Return all orders for a given status partition."""
    status: str = (req.params.get("status") or "").strip()
    if not status:
        return _error("Query param 'status' is required (e.g. ?status=open).", 400)
    if status not in ("open", "completed"):
        return _error("'status' must be 'open' or 'completed'.", 400)

    try:
        container = get_orders_container()
        # Sort newest-first. If Cosmos rejects ORDER BY due to a missing composite
        # index, fall back to the Python sort below.
        try:
            items = list(container.query_items(
                query="SELECT * FROM c ORDER BY c.createdAt DESC",
                partition_key=status,
            ))
        except Exception:
            logger.warning("ORDER BY query failed; falling back to Python sort.")
            items = sorted(
                list(container.query_items(query="SELECT * FROM c", partition_key=status)),
                key=lambda x: x.get("createdAt", ""),
                reverse=True,
            )
        return _json_response({"orders": items})
    except Exception:
        logger.exception("Failed to list orders with status=%s", status)
        return _error("Failed to retrieve orders.", 500)


# ── POST /api/orders ───────────────────────────────────────────────────────────

@order_bp.route(route="orders", methods=["POST"])
def create_order(req: func.HttpRequest) -> func.HttpResponse:
    """Create a new order document in the 'orders' container."""
    body, err = _parse_body(req)
    if err:
        return err

    # ── Validate customerName ─────────────────────────────────────────────────
    customer_name: str = (body.get("customerName") or "").strip()
    if not customer_name:
        return _error("'customerName' is required and cannot be empty.", 400)

    # ── Validate items ────────────────────────────────────────────────────────
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or len(raw_items) == 0:
        return _error("'items' must be a non-empty array.", 400)

    validated_items: list[dict] = []
    for idx, item in enumerate(raw_items):
        if not isinstance(item, dict):
            return _error(f"items[{idx}] must be an object.", 400)

        item_id: str = (item.get("itemId") or "").strip()
        if not item_id:
            return _error(f"items[{idx}].itemId is required.", 400)

        name: str = (item.get("name") or "").strip()
        if not name:
            return _error(f"items[{idx}].name is required.", 400)

        try:
            price = float(item.get("price", 0))
        except (TypeError, ValueError):
            return _error(f"items[{idx}].price must be a number.", 400)
        if price < 0:
            return _error(f"items[{idx}].price must be >= 0.", 400)

        try:
            qty = int(item.get("qty", 0))
        except (TypeError, ValueError):
            return _error(f"items[{idx}].qty must be an integer.", 400)
        if qty < 1:
            return _error(f"items[{idx}].qty must be at least 1.", 400)

        # Pass modifiers through as-is (trusted internal client).
        raw_mods = item.get("modifiers", [])
        modifiers = [m for m in raw_mods if isinstance(m, dict)]

        validated_items.append({
            "itemId": item_id,
            "name": name,
            "price": round(price, 2),
            "qty": qty,
            "modifiers": modifiers,
        })

    # ── Compute total ─────────────────────────────────────────────────────────
    total = round(sum(i["price"] * i["qty"] for i in validated_items), 2)

    # ── Build document ────────────────────────────────────────────────────────
    doc = {
        "id": "ord_" + uuid4().hex[:8],
        "status": "open",
        "customerName": customer_name,
        "items": validated_items,
        "total": total,
        "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "completedAt": None,
    }

    try:
        get_orders_container().create_item(body=doc)
        logger.info("Created order %s for '%s' (total=%.2f)", doc["id"], customer_name, total)
        return _json_response(doc, 201)
    except Exception:
        logger.exception("Failed to create order")
        return _error("Failed to save order.", 500)


# ── PATCH /api/orders/{id}/complete — Phase 3 stub ────────────────────────────

@order_bp.route(route="orders/{id}/complete", methods=["PATCH"])
def complete_order(req: func.HttpRequest) -> func.HttpResponse:
    """Phase 3 stub — delete+insert partition-key change + SignalR broadcast added in Phase 3."""
    return _error("Not implemented — Phase 3 feature.", 501)
