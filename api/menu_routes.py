"""
menu_routes.py — Azure Functions v2 Blueprint for all /api/menu/* endpoints.

Endpoints:
  GET    /api/menu                                   → full menu tree + modifier groups
  POST   /api/menu/categories                        → create category
  PUT    /api/menu/categories/{id}                   → update category
  DELETE /api/menu/categories/{id}                   → delete category + all its items
  POST   /api/menu/modifier-groups                   → create modifier group
  PATCH  /api/menu/modifier-groups/{id}/items        → bulk assign/unassign items  ← more-specific, registered first
  PUT    /api/menu/modifier-groups/{id}              → update modifier group
  DELETE /api/menu/modifier-groups/{id}              → delete group + all its options
  POST   /api/menu/modifier-options                  → create modifier option
  PUT    /api/menu/modifier-options/{id}             → update modifier option
  DELETE /api/menu/modifier-options/{id}             → delete modifier option
  POST   /api/menu/items                             → create item
  PATCH  /api/menu/items/{id}/soldout                → toggle sold-out flag           ← more-specific, registered first
  PUT    /api/menu/items/{id}                        → update item
  DELETE /api/menu/items/{id}                        → delete item

Note on route params: extract via req.route_params, never via function signature.
"""

import json
import logging
from uuid import uuid4

import azure.functions as func
from azure.cosmos.exceptions import CosmosResourceNotFoundError

from cosmos_helper import get_menu_container

menu_bp = func.Blueprint()
logger = logging.getLogger(__name__)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _json_response(body: dict | list, status_code: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(body),
        status_code=status_code,
        mimetype="application/json",
    )


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


def _get_item(item_id: str, partition_key: str) -> dict | None:
    try:
        return get_menu_container().read_item(item=item_id, partition_key=partition_key)
    except CosmosResourceNotFoundError:
        return None


# ── GET /api/menu ──────────────────────────────────────────────────────────────

@menu_bp.route(route="menu", methods=["GET"])
def get_menu(req: func.HttpRequest) -> func.HttpResponse:
    """Return the full menu tree (categories + items) plus all modifier groups with options."""
    container = get_menu_container()

    # ── Categories + items ────────────────────────────────────────────────────
    categories: list[dict] = list(container.query_items(
        query="SELECT * FROM c ORDER BY c.sortOrder ASC",
        partition_key="category",
    ))
    items: list[dict] = list(container.query_items(
        query="SELECT * FROM c ORDER BY c.sortOrder ASC",
        partition_key="item",
    ))

    items_by_cat: dict[str, list[dict]] = {}
    for item in items:
        cat_id = item.get("categoryId", "")
        items_by_cat.setdefault(cat_id, []).append(item)

    tree = [{**cat, "items": items_by_cat.get(cat["id"], [])} for cat in categories]

    # ── Modifier groups + options ─────────────────────────────────────────────
    groups: list[dict] = list(container.query_items(
        query="SELECT * FROM c ORDER BY c.sortOrder ASC",
        partition_key="modifier_group",
    ))
    options: list[dict] = list(container.query_items(
        query="SELECT * FROM c ORDER BY c.sortOrder ASC",
        partition_key="modifier_option",
    ))

    opts_by_group: dict[str, list[dict]] = {}
    for opt in options:
        gid = opt.get("groupId", "")
        opts_by_group.setdefault(gid, []).append(opt)

    groups_with_options = [{**g, "options": opts_by_group.get(g["id"], [])} for g in groups]

    return _json_response({"categories": tree, "modifierGroups": groups_with_options})


# ── POST /api/menu/categories ──────────────────────────────────────────────────

@menu_bp.route(route="menu/categories", methods=["POST"])
def create_category(req: func.HttpRequest) -> func.HttpResponse:
    body, err = _parse_body(req)
    if err:
        return err

    name: str = (body.get("name") or "").strip()
    if not name:
        return _error("'name' is required.", 400)

    doc = {
        "id": "cat_" + uuid4().hex[:8],
        "type": "category",
        "name": name,
        "parentId": body.get("parentId"),
        "sortOrder": int(body.get("sortOrder", 0)),
        "color": body.get("color") or None,
    }
    get_menu_container().create_item(body=doc)
    logger.info("Created category %s", doc["id"])
    return _json_response(doc, 201)


# ── PUT /api/menu/categories/{id} ─────────────────────────────────────────────

@menu_bp.route(route="menu/categories/{id}", methods=["PUT"])
def update_category(req: func.HttpRequest) -> func.HttpResponse:
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
    if "color" in body:
        # Empty string → clear any existing color (store None)
        existing["color"] = body["color"] or None

    get_menu_container().upsert_item(body=existing)
    logger.info("Updated category %s", cat_id)
    return _json_response(existing)


# ── DELETE /api/menu/categories/{id} ─────────────────────────────────────────

@menu_bp.route(route="menu/categories/{id}", methods=["DELETE"])
def delete_category(req: func.HttpRequest) -> func.HttpResponse:
    """Delete a category and all items belonging to it."""
    cat_id: str = req.route_params.get("id", "")
    if not _get_item(cat_id, "category"):
        return _error(f"Category '{cat_id}' not found.", 404)

    container = get_menu_container()

    # Delete all items in this category
    items = list(container.query_items(
        query="SELECT * FROM c WHERE c.categoryId = @cat_id",
        parameters=[{"name": "@cat_id", "value": cat_id}],
        partition_key="item",
    ))
    for item in items:
        container.delete_item(item=item["id"], partition_key="item")

    # Delete the category itself
    container.delete_item(item=cat_id, partition_key="category")
    logger.info("Deleted category %s and %d items", cat_id, len(items))
    return _json_response({"ok": True})


# ── POST /api/menu/modifier-groups ────────────────────────────────────────────

@menu_bp.route(route="menu/modifier-groups", methods=["POST"])
def create_modifier_group(req: func.HttpRequest) -> func.HttpResponse:
    body, err = _parse_body(req)
    if err:
        return err

    name: str = (body.get("name") or "").strip()
    if not name:
        return _error("'name' is required.", 400)

    min_sel: int = int(body.get("minSelections", 0))
    max_sel_raw = body.get("maxSelections")  # None / null → unlimited
    max_sel: int | None = None if max_sel_raw is None else int(max_sel_raw)

    doc = {
        "id": "mgrp_" + uuid4().hex[:8],
        "type": "modifier_group",
        "name": name,
        "minSelections": min_sel,
        "maxSelections": max_sel,
        "sortOrder": int(body.get("sortOrder", 0)),
    }
    get_menu_container().create_item(body=doc)
    logger.info("Created modifier group %s", doc["id"])
    return _json_response(doc, 201)


# ── PATCH /api/menu/modifier-groups/{id}/items  — more-specific, registered first ──

@menu_bp.route(route="menu/modifier-groups/{id}/items", methods=["PATCH"])
def assign_modifier_group_items(req: func.HttpRequest) -> func.HttpResponse:
    """Bulk-assign or unassign menu items to/from a modifier group.
    Body: { "add": ["item_abc", ...], "remove": ["item_def", ...] }
    """
    group_id: str = req.route_params.get("id", "")
    if not _get_item(group_id, "modifier_group"):
        return _error(f"Modifier group '{group_id}' not found.", 404)

    body, err = _parse_body(req)
    if err:
        return err

    add_ids: list[str] = body.get("add", [])
    remove_ids: list[str] = body.get("remove", [])
    container = get_menu_container()

    for item_id in add_ids:
        item = _get_item(item_id, "item")
        if item is None:
            continue
        existing_ids: list[str] = item.get("modifierGroupIds", [])
        if group_id not in existing_ids:
            item["modifierGroupIds"] = existing_ids + [group_id]
            container.upsert_item(body=item)

    for item_id in remove_ids:
        item = _get_item(item_id, "item")
        if item is None:
            continue
        existing_ids = item.get("modifierGroupIds", [])
        if group_id in existing_ids:
            item["modifierGroupIds"] = [i for i in existing_ids if i != group_id]
            container.upsert_item(body=item)

    logger.info("Assigned modifier group %s: +%d -%d items", group_id, len(add_ids), len(remove_ids))
    return _json_response({"ok": True})


# ── PUT /api/menu/modifier-groups/{id} ────────────────────────────────────────

@menu_bp.route(route="menu/modifier-groups/{id}", methods=["PUT"])
def update_modifier_group(req: func.HttpRequest) -> func.HttpResponse:
    group_id: str = req.route_params.get("id", "")
    existing = _get_item(group_id, "modifier_group")
    if existing is None:
        return _error(f"Modifier group '{group_id}' not found.", 404)

    body, err = _parse_body(req)
    if err:
        return err

    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            return _error("'name' cannot be empty.", 400)
        existing["name"] = name
    if "minSelections" in body:
        existing["minSelections"] = int(body["minSelections"])
    if "maxSelections" in body:
        raw = body["maxSelections"]
        existing["maxSelections"] = None if raw is None else int(raw)
    if "sortOrder" in body:
        existing["sortOrder"] = int(body["sortOrder"])

    get_menu_container().upsert_item(body=existing)
    logger.info("Updated modifier group %s", group_id)
    return _json_response(existing)


# ── DELETE /api/menu/modifier-groups/{id} ─────────────────────────────────────

@menu_bp.route(route="menu/modifier-groups/{id}", methods=["DELETE"])
def delete_modifier_group(req: func.HttpRequest) -> func.HttpResponse:
    """Delete a modifier group and all its options. Also removes the group id
    from any items that reference it."""
    group_id: str = req.route_params.get("id", "")
    if not _get_item(group_id, "modifier_group"):
        return _error(f"Modifier group '{group_id}' not found.", 404)

    container = get_menu_container()

    # Delete all options belonging to this group
    options = list(container.query_items(
        query="SELECT * FROM c WHERE c.groupId = @gid",
        parameters=[{"name": "@gid", "value": group_id}],
        partition_key="modifier_option",
    ))
    for opt in options:
        container.delete_item(item=opt["id"], partition_key="modifier_option")

    # Remove groupId from all items that reference it
    referencing_items = list(container.query_items(
        query="SELECT * FROM c WHERE ARRAY_CONTAINS(c.modifierGroupIds, @gid)",
        parameters=[{"name": "@gid", "value": group_id}],
        partition_key="item",
    ))
    for item in referencing_items:
        item["modifierGroupIds"] = [i for i in item.get("modifierGroupIds", []) if i != group_id]
        container.upsert_item(body=item)

    # Delete the group itself
    container.delete_item(item=group_id, partition_key="modifier_group")
    logger.info("Deleted modifier group %s (removed %d options, updated %d items)",
                group_id, len(options), len(referencing_items))
    return _json_response({"ok": True})


# ── POST /api/menu/modifier-options ───────────────────────────────────────────

@menu_bp.route(route="menu/modifier-options", methods=["POST"])
def create_modifier_option(req: func.HttpRequest) -> func.HttpResponse:
    body, err = _parse_body(req)
    if err:
        return err

    name: str = (body.get("name") or "").strip()
    if not name:
        return _error("'name' is required.", 400)

    group_id: str = (body.get("groupId") or "").strip()
    if not group_id:
        return _error("'groupId' is required.", 400)
    if not _get_item(group_id, "modifier_group"):
        return _error(f"Modifier group '{group_id}' not found.", 404)

    doc = {
        "id": "mopt_" + uuid4().hex[:8],
        "type": "modifier_option",
        "groupId": group_id,
        "name": name,
        "isDefault": bool(body.get("isDefault", False)),
        "allowsCustomText": bool(body.get("allowsCustomText", False)),
        "sortOrder": int(body.get("sortOrder", 0)),
        "color": body.get("color") or None,
    }
    get_menu_container().create_item(body=doc)
    logger.info("Created modifier option %s in group %s", doc["id"], group_id)
    return _json_response(doc, 201)


# ── PUT /api/menu/modifier-options/{id} ───────────────────────────────────────

@menu_bp.route(route="menu/modifier-options/{id}", methods=["PUT"])
def update_modifier_option(req: func.HttpRequest) -> func.HttpResponse:
    opt_id: str = req.route_params.get("id", "")
    existing = _get_item(opt_id, "modifier_option")
    if existing is None:
        return _error(f"Modifier option '{opt_id}' not found.", 404)

    body, err = _parse_body(req)
    if err:
        return err

    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            return _error("'name' cannot be empty.", 400)
        existing["name"] = name
    if "isDefault" in body:
        existing["isDefault"] = bool(body["isDefault"])
    if "allowsCustomText" in body:
        existing["allowsCustomText"] = bool(body["allowsCustomText"])
    if "sortOrder" in body:
        existing["sortOrder"] = int(body["sortOrder"])
    if "color" in body:
        # Empty string → clear color (store None)
        existing["color"] = body["color"] or None

    get_menu_container().upsert_item(body=existing)
    logger.info("Updated modifier option %s", opt_id)
    return _json_response(existing)


# ── DELETE /api/menu/modifier-options/{id} ────────────────────────────────────

@menu_bp.route(route="menu/modifier-options/{id}", methods=["DELETE"])
def delete_modifier_option(req: func.HttpRequest) -> func.HttpResponse:
    opt_id: str = req.route_params.get("id", "")
    if not _get_item(opt_id, "modifier_option"):
        return _error(f"Modifier option '{opt_id}' not found.", 404)

    get_menu_container().delete_item(item=opt_id, partition_key="modifier_option")
    logger.info("Deleted modifier option %s", opt_id)
    return _json_response({"ok": True})


# ── POST /api/menu/items ───────────────────────────────────────────────────────

@menu_bp.route(route="menu/items", methods=["POST"])
def create_item(req: func.HttpRequest) -> func.HttpResponse:
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

    doc = {
        "id": "item_" + uuid4().hex[:8],
        "type": "item",
        "name": name,
        "categoryId": category_id,
        "price": price,
        "soldOut": False,
        "sortOrder": int(body.get("sortOrder", 0)),
        "modifierGroupIds": [],
        "color": body.get("color") or None,
    }
    get_menu_container().create_item(body=doc)
    logger.info("Created item %s", doc["id"])
    return _json_response(doc, 201)


# ── PATCH /api/menu/items/{id}/soldout  — more-specific, registered first ─────

@menu_bp.route(route="menu/items/{id}/soldout", methods=["PATCH"])
def toggle_soldout(req: func.HttpRequest) -> func.HttpResponse:
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


# ── DELETE /api/menu/items/{id} ──────────────────────────────────────────────

@menu_bp.route(route="menu/items/{id}", methods=["DELETE"])
def delete_item(req: func.HttpRequest) -> func.HttpResponse:
    """Delete a single menu item."""
    item_id: str = req.route_params.get("id", "")
    if not _get_item(item_id, "item"):
        return _error(f"Item '{item_id}' not found.", 404)

    get_menu_container().delete_item(item=item_id, partition_key="item")
    logger.info("Deleted item %s", item_id)
    return _json_response({"ok": True})


# ── PUT /api/menu/items/{id} ──────────────────────────────────────────────────

@menu_bp.route(route="menu/items/{id}", methods=["PUT"])
def update_item(req: func.HttpRequest) -> func.HttpResponse:
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
    if "color" in body:
        # Empty string → clear any existing color (store None)
        existing["color"] = body["color"] or None

    get_menu_container().upsert_item(body=existing)
    logger.info("Updated item %s", item_id)
    return _json_response(existing)
