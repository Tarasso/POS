"""
signalr_helper.py — Azure SignalR Service helpers.

Implements two things without relying on Azure Functions bindings:
  1. Client negotiate — generates { url, accessToken } for the KDS WebSocket client.
  2. Management broadcast — posts messages to all connected KDS clients.

Both use JWT tokens signed with the service access key (PyJWT / HS256).
Avoiding bindings side-steps the known fragility of input/output bindings on
Blueprint-registered functions in the Python v2 runtime (local worker).

Environment variable required:
  SIGNALR_CONNECTION_STRING — "Endpoint=https://...;AccessKey=...;Version=1.0;"
"""

import json
import logging
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone

import jwt  # PyJWT

logger = logging.getLogger(__name__)

_HUB_NAME = "kds"

# ── Parse connection string ────────────────────────────────────────────────────

def _parse_connection_string() -> tuple[str, str]:
    """Return (endpoint, access_key) from SIGNALR_CONNECTION_STRING."""
    conn_str = os.environ.get("SIGNALR_CONNECTION_STRING", "")
    parts = {
        k.strip(): v.strip()
        for part in conn_str.split(";")
        if "=" in part
        for k, v in [part.split("=", 1)]
    }
    endpoint = parts.get("Endpoint", "").rstrip("/")
    access_key = parts.get("AccessKey", "")
    if not endpoint or not access_key:
        raise ValueError(
            "SIGNALR_CONNECTION_STRING is missing or malformed — "
            "expected 'Endpoint=https://...;AccessKey=...'"
        )
    return endpoint, access_key


# ── JWT generation ─────────────────────────────────────────────────────────────

def _make_token(url: str, access_key: str, ttl_seconds: int = 30) -> str:
    """Generate a signed JWT for the given audience URL.

    ttl_seconds defaults to 30 for short-lived management API calls.
    Use a longer TTL (e.g. 3600) for client connection tokens.
    """
    exp = int(datetime.now(timezone.utc).timestamp()) + ttl_seconds
    return jwt.encode({"aud": url, "exp": exp}, access_key, algorithm="HS256")


# ── REST broadcast ─────────────────────────────────────────────────────────────

def _broadcast(target: str, arguments: list) -> None:
    """
    POST a message to the Azure SignalR Management REST API.

    Logs INFO on success (202 Accepted), WARNING on any failure.
    Never raises — broadcast failure must never block the HTTP response.
    """
    try:
        endpoint, access_key = _parse_connection_string()
        url = f"{endpoint}/api/v1/hubs/{_HUB_NAME}"
        token = _make_token(url, access_key)

        payload = json.dumps({"target": target, "arguments": arguments}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            logger.info(
                "Broadcast '%s' to hub '%s' — HTTP %s", target, _HUB_NAME, resp.status
            )
    except urllib.error.URLError as exc:
        logger.warning(
            "SignalR broadcast '%s' failed (network/HTTP error): %s", target, exc
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "SignalR broadcast '%s' failed (unexpected error): %s", target, exc
        )


# ── Client negotiate ───────────────────────────────────────────────────────────

def get_client_connection_info() -> dict:
    """
    Return the negotiate payload the @microsoft/signalr client SDK expects:
      { "url": "https://<service>/client/?hub=kds", "accessToken": "<JWT>" }

    The client uses `url` to open the WebSocket and `accessToken` as the Bearer
    token on that upgrade request.  Token TTL is 1 hour — long enough for a
    kitchen shift; if the WebSocket drops, withAutomaticReconnect() will call
    /api/negotiate again to get a fresh token.
    """
    endpoint, access_key = _parse_connection_string()
    client_url = f"{endpoint}/client/?hub={_HUB_NAME}"
    token = _make_token(client_url, access_key, ttl_seconds=3600)
    return {"url": client_url, "accessToken": token}


# ── Public API ─────────────────────────────────────────────────────────────────

def broadcast_order_created(order_doc: dict) -> None:
    """Broadcast the full order document to all KDS subscribers."""
    _broadcast("orderCreated", [order_doc])


def broadcast_order_completed(order_id: str) -> None:
    """Broadcast an order-completed notification to all KDS subscribers."""
    _broadcast("orderCompleted", [{"orderId": order_id}])
