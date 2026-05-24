"""
cosmos_helper.py — Singleton Cosmos DB client and container accessors.

Reads COSMOS_CONNECTION_STRING from the environment (set via local.settings.json
when running locally, or via SWA app settings in production).
"""

import os
from azure.cosmos import CosmosClient, ContainerProxy

_client: CosmosClient | None = None
_DB_NAME = "pos_db"
_MENU_CONTAINER = "menu"
_ORDERS_CONTAINER = "orders"


def _get_client() -> CosmosClient:
    global _client
    if _client is None:
        conn_str = os.environ["COSMOS_CONNECTION_STRING"]
        _client = CosmosClient.from_connection_string(conn_str)
    return _client


def get_menu_container() -> ContainerProxy:
    """Return the 'menu' container client (partition key: /type)."""
    db = _get_client().get_database_client(_DB_NAME)
    return db.get_container_client(_MENU_CONTAINER)


def get_orders_container() -> ContainerProxy:
    """Return the 'orders' container client (partition key: /status). Used in Phase 3."""
    db = _get_client().get_database_client(_DB_NAME)
    return db.get_container_client(_ORDERS_CONTAINER)
