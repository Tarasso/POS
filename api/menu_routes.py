"""
menu_routes.py — Azure Functions v2 Blueprint for all /api/menu/* endpoints.

Endpoints:
  GET    /api/menu                       → full menu tree (categories + items)
  POST   /api/menu/categories            → create category
  PUT    /api/menu/categories/{id}       → update category
  POST   /api/menu/items                 → create item
  PUT    /api/menu/items/{id}            → update item (more-specific route registered first)
  PATCH  /api/menu/items/{id}/soldout    → toggle sold-out flag

Note on route params: the bundled Python 3.13 worker validates that every parameter in the
function signature is declared in the binding metadata. Route params from route templates
are NOT auto-registered by this worker version. We extract them via req.route_params
instead of declaring them in the function signature to stay compatible with all workers.
"""

import json
import logging
from uuid import uuid4

import azure.functions as func
from azure.cosmos.exceptions import CosmosResourceNotFoundError

from cosmos_helper import get_menu_container

menu_bp = func.Blueprint()

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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


def _get_item(item_id: str, partition_key: str) -> dict | None:
    """Read a single document; return None if not found."""
    try:
        return get_menu_container().read_item(item=item_id, partition_key=partition_key)
    except CosmosResourceNotFoundError:
        return None


# ---------------------------------------------------------------------------
# GET /api/menu
# ---------------------------------------------------------------------------

@menu_bp.route(route="menu", methods=["GET"])
def get_menu(req: func.HttpRequest) -> func.HttpResponse:
    """Return the full menu tree: categories with their items nested inside."""
    container = get_menu_container()

    categories: list[dict] = list(container.query_items(
        query="SELECT * FROM c WHERE c.type = 'category' ORDER BY c.sortOrder ASC",
        partition_key="category",
    ))

    items: list[dict] = list(container.query_items(
        query="SELECT * FROM c WHERE c.type = 'item' ORDER BY c.sortOrder ASC",
        partition_key="item",
    ))

    # Build lookup: categoryId → list of items
    items_by_cat: dict[str, list[dict]] = {}
    for item in items:
        cat_id = item.get("categoryId", "")
        items_by_cat.setdefault(cat_id, []).append(item)

    # Attach items to categories
    tree = []
    for cat in categories:
        tree.append({**cat, "items": items_by_cat.get(cat["id"], [])})

    return _json_response({"categories": tree})


# ---------------------------------------------------------------------------
# POST /api/menu/categories
# ---------------------------------------------------------------------------

@menu_bp.route(route="menu/categories", methods=["POST"])
def create_category(req: func.HttpRequest) -> func.HttpResponse:
    """Create a new menu category."""
    body, err = _parse_body(req)
    if err:
        return err

    name: str = (body.get("name") or "").strip()
    if not name:
        return _error("'name' is required.", 400)

    sort_order: int = int(body.get("sortOrder", 0))
    parent_id: str | None = body.get("parentId")

    doc = {
        "id": "cat_" + uuid4().hex[:8],
        "type": "category",
        "name": name,
        "parentId": parent_id,
        "sortOrder": sort_order,
    }

    get_menu_container().create_item(body=doc)
    logger.info("Created category %s", doc["id"])
    return _json_response(doc, 201)


# ---------------------------------------------------------------------------
# PUT /api/menu/categories/{id}
# ---------------------------------------------------------------------------

@menu_bp.route(route="menu/categories/{id}", methods=["PUT"])
def update_category(req: func.HttpRequest) -> func.HttpResponse:
    """Update an existing menu category."""
    cat_id: str = req.route_params.get("id", "")
    existing = _get_item(cat_id, "category")
    if existing is None:
        return _error(f"Category '{cat_id}' not found.", 404)

    body, err = _parse_body(req)
    if err:
        return err

    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            return _error("'name' cannot be empty.", 400)
        existing["name"] = name

    if "sortOrder" in body:
        existing["sortOrder"] = int(body["sortOrder"])

    if "parentId" in body:
        existing["parentId"] = body["parentId"]

    get_menu_container().upsert_item(body=existing)
    logger.info("Updated category %s", cat_id)
    return _json_response(existing)


# ---------------------------------------------------------------------------
# POST /api/menu/items
# ---------------------------------------------------------------------------

@menu_bp.route(route="menu/items", methods=["POST"])
def create_item(req: func.HttpRequest) -> func.HttpResponse:
    """Create a new menu item."""
    body, err = _parse_body(req)
    if err:
        return err

    name: str = (body.get("name") or "").strip()
    if not name:
        return _error("'name' is required.", 400)

    category_id: str = (body.get("categoryId") or "").strip()
    if not category_id:
        return _error("'categoryId' is required.", 400)

    try:
        price = float(body.get("price", 0))
    except (TypeError, ValueError):
        return _error("'price' must be a number.", 400)

    sort_order: int = int(body.get("sortOrder", 0))

    doc = {
        "id": "item_" + uuid4().hex[:8],
        "type": "item",
        "name": name,
        "categoryId": category_id,
        "price": price,
        "soldOut": False,
        "sortOrder": sort_order,
    }

    get_menu_container().create_item(body=doc)
    logger.info("Created item %s", doc["id"])
    return _json_response(doc, 201)


# ---------------------------------------------------------------------------
# PATCH /api/menu/items/{id}/soldout  — registered BEFORE the PUT so the
# more-specific route wins when the Functions runtime resolves the path.
# ---------------------------------------------------------------------------

@menu_bp.route(route="menu/items/{id}/soldout", methods=["PATCH"])
def toggle_soldout(req: func.HttpRequest) -> func.HttpResponse:
    """Set the soldOut flag on a menu item."""
    item_id: str = req.route_params.get("id", "")
    existing = _get_item(item_id, "item")
    if existing is None:
        return _error(f"Item '{item_id}' not found.", 404)

    body, err = _parse_body(req)
    if err:
        return err

    if "soldOut" not in body:
        return _error("'soldOut' (bool) is required.", 400)

    existing["soldOut"] = bool(body["soldOut"])
    get_menu_container().upsert_item(body=existing)
    logger.info("Toggled soldOut=%s on item %s", existing["soldOut"], item_id)
    return _json_response(existing)


# ---------------------------------------------------------------------------
# PUT /api/menu/items/{id}
# ---------------------------------------------------------------------------

@menu_bp.route(route="menu/items/{id}", methods=["PUT"])
def update_item(req: func.HttpRequest) -> func.HttpResponse:
    """Update an existing menu item."""
    item_id: str = req.route_params.get("id", "")
    existing = _get_item(item_id, "item")
    if existing is None:
        return _error(f"Item '{item_id}' not found.", 404)

    body, err = _parse_body(req)
    if err:
        return err

    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            return _error("'name' cannot be empty.", 400)
        existing["name"] = name

    if "categoryId" in body:
        cat_id = (body["categoryId"] or "").strip()
        if not cat_id:
            return _error("'categoryId' cannot be empty.", 400)
        existing["categoryId"] = cat_id

    if "price" in body:
        try:
            existing["price"] = float(body["price"])
        except (TypeError, ValueError):
            return _error("'price' must be a number.", 400)

    if "sortOrder" in body:
        existing["sortOrder"] = int(body["sortOrder"])

    get_menu_container().upsert_item(body=existing)
    logger.info("Updated item %s", item_id)
    return _json_response(existing)
