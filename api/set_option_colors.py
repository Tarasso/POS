"""
set_option_colors.py — One-shot script to apply KDS pill colors to specific
modifier options already in Cosmos.

Targets (case-insensitive name match):
  "Hot"      → #ef4444  (red,    white text on KDS)
  "Oat Milk" → #f59e0b  (amber,  dark text on KDS)

Run from the /api directory:
  cd api
  & "C:\\Program Files\\Python313\\python.exe" set_option_colors.py

Reads the connection string from local.settings.json — no extra env vars needed.
Safe to re-run; it only modifies options whose names match.
"""

import json
import sys
from pathlib import Path

# ── Bootstrap ─────────────────────────────────────────────────────────────────

settings_path = Path(__file__).parent / "local.settings.json"
if not settings_path.exists():
    print("ERROR: local.settings.json not found. Run from the /api directory.", file=sys.stderr)
    sys.exit(1)

with settings_path.open() as f:
    settings = json.load(f)

conn_str: str = settings["Values"]["COSMOS_CONNECTION_STRING"]

from azure.cosmos import CosmosClient  # noqa: E402

client = CosmosClient.from_connection_string(conn_str)
container = client.get_database_client("pos_db").get_container_client("menu")

# ── Color map: lowercase name → hex color ─────────────────────────────────────

COLOR_MAP: dict[str, str] = {
    "hot":      "#ef4444",   # red   — white text (luminance 0.47 < 0.55)
    "oat milk": "#f59e0b",   # amber — dark text  (luminance 0.66 > 0.55)
}

# ── Query all modifier options ────────────────────────────────────────────────

print("Querying modifier options…")
options = list(container.query_items(
    query="SELECT * FROM c",
    partition_key="modifier_option",
))
print(f"  Found {len(options)} option(s) total.")

# ── Apply colors ──────────────────────────────────────────────────────────────

updated = 0
for opt in options:
    name_lower = opt.get("name", "").strip().lower()
    if name_lower in COLOR_MAP:
        new_color = COLOR_MAP[name_lower]
        old_color = opt.get("color")
        if old_color == new_color:
            print(f"  [skip] '{opt['name']}' already has color {new_color}")
            continue
        opt["color"] = new_color
        container.upsert_item(body=opt)
        print(f"  [ok]   '{opt['name']}' => {new_color}  (was: {old_color!r})")
        updated += 1

print(f"\nDone — {updated} option(s) updated.")
if updated == 0 and any(name_lower in COLOR_MAP for opt in options
                        for name_lower in [opt.get("name", "").strip().lower()]):
    print("(All targets were already up to date.)")
elif updated < len(COLOR_MAP):
    missing = [name for name in COLOR_MAP if not any(
        o.get("name", "").strip().lower() == name for o in options
    )]
    if missing:
        print(f"WARNING: No options found with name(s): {missing}")
        print("  Check spelling in the Admin → Modifiers tab.")
