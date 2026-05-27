"""
seed_menu.py — Idempotent seed script for the 'menu' Cosmos container.

Run once (or re-run safely) to populate initial categories and items:
  python seed_menu.py

Must be run from the /api directory with the Python 3.11 venv active:
  $env:PATH = "C:\\Users\\kylem\\OneDrive\\Desktop\\POS\\api\\.venv\\Scripts;" + $env:PATH
  cd api
  python seed_menu.py

Reads COSMOS_CONNECTION_STRING from local.settings.json so you don't need
to set env vars manually.
"""

import json
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Bootstrap: read connection string from local.settings.json
# ---------------------------------------------------------------------------

settings_path = Path(__file__).parent / "local.settings.json"
if not settings_path.exists():
    print("ERROR: local.settings.json not found. Run from the /api directory.", file=sys.stderr)
    sys.exit(1)

with settings_path.open() as f:
    settings = json.load(f)

conn_str: str = settings["Values"]["COSMOS_CONNECTION_STRING"]
os.environ.setdefault("COSMOS_CONNECTION_STRING", conn_str)

# Now import the helper (which reads from env)
from azure.cosmos import CosmosClient  # noqa: E402 — must be after env var is set

client = CosmosClient.from_connection_string(conn_str)
container = client.get_database_client("pos_db").get_container_client("menu")

# ---------------------------------------------------------------------------
# Seed data
# ---------------------------------------------------------------------------

CATEGORIES: list[dict] = [
    {"id": "cat_coffee",  "type": "category", "name": "Coffee",  "parentId": None, "sortOrder": 1},
    {"id": "cat_food",    "type": "category", "name": "Food",    "parentId": None, "sortOrder": 2},
    {"id": "cat_drinks",  "type": "category", "name": "Drinks",  "parentId": None, "sortOrder": 3},
]

ITEMS: list[dict] = [
    # Coffee
    {"id": "item_latte",      "type": "item", "name": "Latte",         "categoryId": "cat_coffee", "price": 5.50, "soldOut": False, "sortOrder": 1},
    {"id": "item_cappuccino", "type": "item", "name": "Cappuccino",    "categoryId": "cat_coffee", "price": 5.00, "soldOut": False, "sortOrder": 2},
    {"id": "item_espresso",   "type": "item", "name": "Espresso",      "categoryId": "cat_coffee", "price": 3.50, "soldOut": False, "sortOrder": 3},
    # Food
    {"id": "item_croissant",  "type": "item", "name": "Croissant",     "categoryId": "cat_food",   "price": 4.00, "soldOut": False, "sortOrder": 1},
    {"id": "item_muffin",     "type": "item", "name": "Muffin",        "categoryId": "cat_food",   "price": 3.50, "soldOut": False, "sortOrder": 2},
    # Drinks
    {"id": "item_water",      "type": "item", "name": "Water",         "categoryId": "cat_drinks", "price": 1.50, "soldOut": False, "sortOrder": 1},
    {"id": "item_oj",         "type": "item", "name": "Orange Juice",  "categoryId": "cat_drinks", "price": 3.00, "soldOut": False, "sortOrder": 2},
]

# ---------------------------------------------------------------------------
# Upsert all documents (idempotent)
# ---------------------------------------------------------------------------

print("Seeding menu container...")

for cat in CATEGORIES:
    container.upsert_item(body=cat)
    print(f"  [ok] category: {cat['name']}")

for item in ITEMS:
    container.upsert_item(body=item)
    print(f"  [ok] item:     {item['name']} (${item['price']:.2f})")

print(f"\nDone — {len(CATEGORIES)} categories, {len(ITEMS)} items seeded.")
