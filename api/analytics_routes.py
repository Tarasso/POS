"""
analytics_routes.py — Azure Functions v2 Blueprint for /api/analytics/* endpoints.

Endpoints:
  GET /api/analytics/summary?startDate=&endDate=&eventName=
      → aggregate operational stats (orders, items, modifier breakdown)
        optionally filtered by date range and/or event name
  GET /api/analytics/orders
      → completed order history, newest-first
  GET /api/analytics/events
      → distinct event names stored on completed orders (for filter dropdown)
"""

import json
import logging
from collections import defaultdict

import azure.functions as func

from cosmos_helper import get_orders_container

analytics_bp = func.Blueprint()
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


def _fetch_filtered_orders(
    start_date: str | None,
    end_date: str | None,
    event_name: str | None,
) -> list[dict]:
    """
    Fetch completed orders from Cosmos, applying optional filters.

    start_date / end_date: "YYYY-MM-DD" strings (inclusive).
    event_name: exact match on the order's eventName field.

    Uses parameterised Cosmos queries where filters are present.
    Falls back to Python sort / filter if the ORDER BY index is missing.
    """
    container = get_orders_container()

    # Build WHERE clause and parameter list dynamically.
    where_parts: list[str] = []
    params: list[dict] = []

    if start_date:
        where_parts.append("c.completedAt >= @startDate")
        params.append({"name": "@startDate", "value": start_date + "T00:00:00Z"})

    if end_date:
        where_parts.append("c.completedAt <= @endDate")
        params.append({"name": "@endDate", "value": end_date + "T23:59:59.999Z"})

    if event_name:
        where_parts.append("c.eventName = @eventName")
        params.append({"name": "@eventName", "value": event_name})

    where_clause = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
    query = f"SELECT * FROM c {where_clause} ORDER BY c.completedAt DESC"

    try:
        return list(container.query_items(
            query=query,
            parameters=params if params else None,
            partition_key="completed",
        ))
    except Exception:
        logger.warning("Filtered ORDER BY query failed; falling back to Python sort/filter.")
        # Fetch all and filter in Python.
        all_orders = list(container.query_items(
            query="SELECT * FROM c",
            partition_key="completed",
        ))
        filtered = all_orders

        if start_date:
            start_ts = start_date + "T00:00:00Z"
            filtered = [o for o in filtered if (o.get("completedAt") or "") >= start_ts]

        if end_date:
            end_ts = end_date + "T23:59:59.999Z"
            filtered = [o for o in filtered if (o.get("completedAt") or "") <= end_ts]

        if event_name:
            filtered = [o for o in filtered if o.get("eventName") == event_name]

        return sorted(filtered, key=lambda x: x.get("completedAt") or "", reverse=True)


# ── GET /api/analytics/summary ────────────────────────────────────────────────

@analytics_bp.route(route="analytics/summary", methods=["GET"])
def analytics_summary(req: func.HttpRequest) -> func.HttpResponse:
    """
    Return aggregate operational statistics over completed orders.

    Optional query params:
      startDate  — "YYYY-MM-DD" (inclusive lower bound on completedAt)
      endDate    — "YYYY-MM-DD" (inclusive upper bound on completedAt)
      eventName  — exact event name to filter by

    Aggregation is done in Python — simpler than Cosmos GROUP BY and more than
    fast enough for a low-volume personal POS.
    """
    start_date = (req.params.get("startDate") or "").strip() or None
    end_date   = (req.params.get("endDate")   or "").strip() or None
    event_name = (req.params.get("eventName") or "").strip() or None

    try:
        orders = _fetch_filtered_orders(start_date, end_date, event_name)
    except Exception:
        logger.exception("Failed to fetch completed orders for summary")
        return _error("Failed to retrieve analytics data.", 500)

    total_orders = len(orders)

    # ── Totals ─────────────────────────────────────────────────────────────────
    total_items = sum(
        int(line.get("qty", 0))
        for order in orders
        for line in order.get("items", [])
    )
    avg_items_per_order = round(total_items / total_orders, 2) if total_orders > 0 else 0.0
    total_revenue = round(sum(float(o.get("total", 0)) for o in orders), 2)

    # ── Top items (by qty, up to 10) ───────────────────────────────────────────
    item_agg: dict[tuple[str, str], dict] = defaultdict(lambda: {"qtyTotal": 0, "revenue": 0.0})
    for order in orders:
        for line in order.get("items", []):
            item_id = line.get("itemId", "")
            name    = line.get("name", "")
            qty     = int(line.get("qty", 0))
            price   = float(line.get("price", 0))
            key = (item_id, name)
            item_agg[key]["qtyTotal"] += qty
            item_agg[key]["revenue"] = round(item_agg[key]["revenue"] + price * qty, 2)

    top_items = sorted(
        [
            {
                "itemId":   k[0],
                "name":     k[1],
                "qtyTotal": v["qtyTotal"],
                "revenue":  round(v["revenue"], 2),
            }
            for k, v in item_agg.items()
        ],
        key=lambda x: x["qtyTotal"],
        reverse=True,
    )[:10]

    # ── Modifier breakdown ─────────────────────────────────────────────────────
    # Group by modifier group name → option name, weighted by item qty so that
    # "2× Latte with Oat Milk" counts Oat Milk twice.
    mod_agg: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for order in orders:
        for line in order.get("items", []):
            qty = int(line.get("qty", 1))
            for mod in line.get("modifiers", []):
                group_name  = mod.get("groupName", "Other")
                option_name = mod.get("optionName", "Unknown")
                mod_agg[group_name][option_name] += qty

    modifier_breakdown = sorted(
        [
            {
                "groupName": group_name,
                "options": sorted(
                    [{"optionName": opt, "count": cnt} for opt, cnt in options.items()],
                    key=lambda x: x["count"],
                    reverse=True,
                ),
            }
            for group_name, options in mod_agg.items()
        ],
        key=lambda x: x["groupName"],
    )

    return _json_response({
        "totalOrders":      total_orders,
        "totalItems":       total_items,
        "avgItemsPerOrder": avg_items_per_order,
        "topItems":         top_items,
        "modifierBreakdown": modifier_breakdown,
        "totalRevenue":     total_revenue,
    })


# ── GET /api/analytics/orders ─────────────────────────────────────────────────

@analytics_bp.route(route="analytics/orders", methods=["GET"])
def analytics_orders(req: func.HttpRequest) -> func.HttpResponse:
    """
    Return all completed orders sorted newest-first, for the history table.
    Accepts the same startDate / endDate / eventName filter params as /summary.
    """
    start_date = (req.params.get("startDate") or "").strip() or None
    end_date   = (req.params.get("endDate")   or "").strip() or None
    event_name = (req.params.get("eventName") or "").strip() or None

    try:
        orders = _fetch_filtered_orders(start_date, end_date, event_name)
        return _json_response({"orders": orders, "count": len(orders)})
    except Exception:
        logger.exception("Failed to fetch completed orders for history")
        return _error("Failed to retrieve order history.", 500)


# ── GET /api/analytics/events ─────────────────────────────────────────────────

@analytics_bp.route(route="analytics/events", methods=["GET"])
def analytics_events(req: func.HttpRequest) -> func.HttpResponse:
    """
    Return distinct event names found on completed orders, sorted newest-first
    by the most recent order in each event.  Used to populate the event filter
    dropdown on the analytics page.
    """
    container = get_orders_container()
    try:
        # Fetch only the fields we need to keep the payload small.
        rows = list(container.query_items(
            query="SELECT c.eventName, c.completedAt FROM c WHERE IS_DEFINED(c.eventName) AND c.eventName != null",
            partition_key="completed",
        ))
    except Exception:
        logger.exception("Failed to fetch event names")
        return _error("Failed to retrieve events.", 500)

    # Deduplicate in Python: build one entry per event name.
    events: dict[str, dict] = {}
    for row in rows:
        name = row.get("eventName")
        if not name:
            continue
        completed_at = row.get("completedAt") or ""
        if name not in events:
            events[name] = {
                "name":       name,
                "orderCount": 0,
                "firstOrder": completed_at,
                "lastOrder":  completed_at,
            }
        events[name]["orderCount"] += 1
        if completed_at < events[name]["firstOrder"]:
            events[name]["firstOrder"] = completed_at
        if completed_at > events[name]["lastOrder"]:
            events[name]["lastOrder"] = completed_at

    result = sorted(events.values(), key=lambda x: x["lastOrder"], reverse=True)
    return _json_response({"events": result})
