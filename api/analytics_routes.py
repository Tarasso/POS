"""
analytics_routes.py — Azure Functions v2 Blueprint for /api/analytics/* endpoints.

Phase 4 endpoints:
  GET /api/analytics/summary  → aggregate stats over all completed orders
  GET /api/analytics/orders   → completed order history, newest-first
"""

import json
import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta

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


def _fetch_completed_orders() -> list[dict]:
    """Fetch all completed orders from Cosmos (partition_key='completed')."""
    container = get_orders_container()
    try:
        return list(container.query_items(
            query="SELECT * FROM c ORDER BY c.completedAt DESC",
            partition_key="completed",
        ))
    except Exception:
        logger.warning("ORDER BY completedAt failed; falling back to Python sort.")
        items = list(container.query_items(
            query="SELECT * FROM c",
            partition_key="completed",
        ))
        return sorted(items, key=lambda x: x.get("completedAt") or "", reverse=True)


# ── GET /api/analytics/summary ────────────────────────────────────────────────

@analytics_bp.route(route="analytics/summary", methods=["GET"])
def analytics_summary(req: func.HttpRequest) -> func.HttpResponse:
    """
    Return aggregate statistics over all completed orders.

    Aggregation is done in Python — simpler than Cosmos GROUP BY and more than
    fast enough for a low-volume personal POS.
    """
    try:
        orders = _fetch_completed_orders()
    except Exception:
        logger.exception("Failed to fetch completed orders for summary")
        return _error("Failed to retrieve analytics data.", 500)

    total_orders = len(orders)
    total_revenue = round(sum(float(o.get("total", 0)) for o in orders), 2)
    avg_order_value = round(total_revenue / total_orders, 2) if total_orders > 0 else 0.0

    # ── Top items ──────────────────────────────────────────────────────────────
    # Keyed by (itemId, name); accumulate qty sold and revenue.
    item_agg: dict[tuple[str, str], dict] = defaultdict(lambda: {"qtyTotal": 0, "revenue": 0.0})
    for order in orders:
        for line in order.get("items", []):
            item_id = line.get("itemId", "")
            name = line.get("name", "")
            qty = int(line.get("qty", 0))
            price = float(line.get("price", 0))
            key = (item_id, name)
            item_agg[key]["qtyTotal"] += qty
            item_agg[key]["revenue"] = round(item_agg[key]["revenue"] + price * qty, 2)

    top_items = sorted(
        [
            {
                "itemId": k[0],
                "name": k[1],
                "qtyTotal": v["qtyTotal"],
                "revenue": round(v["revenue"], 2),
            }
            for k, v in item_agg.items()
        ],
        key=lambda x: x["qtyTotal"],
        reverse=True,
    )[:5]

    # ── Revenue by day (last 30 days) ──────────────────────────────────────────
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).date()
    day_agg: dict[str, dict] = defaultdict(lambda: {"revenue": 0.0, "orders": 0})
    for order in orders:
        completed_at = order.get("completedAt") or ""
        if not completed_at:
            continue
        date_str = completed_at[:10]  # "YYYY-MM-DD"
        try:
            order_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            continue
        if order_date < cutoff:
            continue
        day_agg[date_str]["revenue"] = round(
            day_agg[date_str]["revenue"] + float(order.get("total", 0)), 2
        )
        day_agg[date_str]["orders"] += 1

    revenue_by_day = sorted(
        [
            {"date": d, "revenue": round(v["revenue"], 2), "orders": v["orders"]}
            for d, v in day_agg.items()
        ],
        key=lambda x: x["date"],
        reverse=True,
    )

    return _json_response({
        "totalOrders": total_orders,
        "totalRevenue": total_revenue,
        "avgOrderValue": avg_order_value,
        "topItems": top_items,
        "revenueByDay": revenue_by_day,
    })


# ── GET /api/analytics/orders ─────────────────────────────────────────────────

@analytics_bp.route(route="analytics/orders", methods=["GET"])
def analytics_orders(req: func.HttpRequest) -> func.HttpResponse:
    """
    Return all completed orders sorted newest-first, for the history table.
    """
    try:
        orders = _fetch_completed_orders()
        return _json_response({"orders": orders, "count": len(orders)})
    except Exception:
        logger.exception("Failed to fetch completed orders for history")
        return _error("Failed to retrieve order history.", 500)
