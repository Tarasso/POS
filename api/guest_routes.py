"""
guest_routes.py — Session + guest (PIN) sign-in endpoints, and guest management.

Session endpoints (anonymous — they are how you *become* authenticated):
  GET  /api/auth/session       → who am I? { authenticated, kind, role, name }
  POST /api/auth/guest-login   → { pin } → sets the guest cookie
  POST /api/auth/logout        → clears the guest cookie

Guest management (owner/staff only):
  GET    /api/guests                → list guests (never returns PIN hashes)
  POST   /api/guests                → create { name, pin }
  PUT    /api/guests/{id}           → update { name?, pin? } — a PIN change signs the guest out everywhere
  POST   /api/guests/{id}/revoke    → sign the guest out of every device, PIN unchanged
  DELETE /api/guests/{id}           → delete (existing sessions stop working immediately)

Guest docs live in the `menu` container under partition "guest":
  { "id": "guest_ab12cd34", "type": "guest", "name": "Sarah",
    "pinHash": "...", "pinSalt": "...", "tokenVersion": 1,
    "createdAt": "...", "lastLoginAt": "..." | null }

Brute-force protection: a 4-digit PIN has only 10,000 combinations, so failed
guest logins are counted globally in a single "guest_throttle" doc. After
_MAX_FAILURES failures inside _FAILURE_WINDOW_SECONDS, guest sign-in is refused
until the oldest failure ages out. Microsoft sign-in is unaffected.
"""

import json
import logging
import time
from datetime import datetime, timezone
from uuid import uuid4

import azure.functions as func

from auth_helper import (
    GUEST_DOC_TYPE,
    OWNER_ROLES,
    Principal,
    authorize,
    forget_guest,
    get_guest_secret,
    get_principal,
    guest_cookie_header,
    hash_pin,
    is_valid_pin,
    issue_guest_token,
    load_guest,
    pin_matches,
    read_microsoft_principal,
    token_needs_refresh,
)
from cosmos_helper import get_menu_container

guest_bp = func.Blueprint()
logger = logging.getLogger(__name__)

_THROTTLE_TYPE = "guest_throttle"
_THROTTLE_ID = "guest_login_throttle"
_MAX_FAILURES = 10
_FAILURE_WINDOW_SECONDS = 30 * 60


# ── Private helpers ────────────────────────────────────────────────────────────

def _json_response(
    body: dict | list, status_code: int = 200, headers: dict[str, str] | None = None
) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(body),
        status_code=status_code,
        mimetype="application/json",
        headers=headers,
    )


def _error(message: str, status_code: int, **extra: object) -> func.HttpResponse:
    return _json_response({"error": message, **extra}, status_code)


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


def _public_guest(doc: dict) -> dict:
    return {
        "id": doc["id"],
        "name": doc.get("name", ""),
        "createdAt": doc.get("createdAt"),
        "lastLoginAt": doc.get("lastLoginAt"),
    }


def _session_body(principal: Principal) -> dict:
    return {
        "authenticated": True,
        "kind": principal.kind,
        "role": principal.role,
        "name": principal.name,
    }


def _all_guests() -> list[dict]:
    return list(get_menu_container().query_items(
        query="SELECT * FROM c", partition_key=GUEST_DOC_TYPE,
    ))


def _pin_taken(pin: str, except_id: str | None = None) -> bool:
    return any(g["id"] != except_id and pin_matches(pin, g) for g in _all_guests())


def _recent_failures() -> tuple[dict, list[float]]:
    container = get_menu_container()
    try:
        doc = container.read_item(item=_THROTTLE_ID, partition_key=_THROTTLE_TYPE)
    except Exception:  # noqa: BLE001 — missing doc is the normal case
        doc = {"id": _THROTTLE_ID, "type": _THROTTLE_TYPE, "failures": []}
    cutoff = time.time() - _FAILURE_WINDOW_SECONDS
    recent = [t for t in doc.get("failures", []) if isinstance(t, (int, float)) and t > cutoff]
    return doc, recent


# ── GET /api/auth/session ──────────────────────────────────────────────────────

@guest_bp.route(route="auth/session", methods=["GET"])
def auth_session(req: func.HttpRequest) -> func.HttpResponse:
    """Describe the caller. Always 200 so the SPA can branch without error handling."""
    principal = get_principal(req)
    if principal is None:
        ms = read_microsoft_principal(req)
        return _json_response({
            "authenticated": False,
            # Signed in with Microsoft but not invited → the UI explains why.
            "microsoftUser": (ms or {}).get("userDetails") if ms else None,
        })

    headers = None
    if token_needs_refresh(principal):
        # Sliding expiry: an active guest's cookie never runs out.
        guest = load_guest(principal.user_id)
        if guest:
            headers = {"Set-Cookie": guest_cookie_header(req, issue_guest_token(guest))}
    return _json_response(_session_body(principal), headers=headers)


# ── POST /api/auth/guest-login ─────────────────────────────────────────────────

@guest_bp.route(route="auth/guest-login", methods=["POST"])
def guest_login(req: func.HttpRequest) -> func.HttpResponse:
    if not get_guest_secret():
        return _error("Guest sign-in isn't set up yet.", 503)

    body, err = _parse_body(req)
    if err:
        return err
    pin = body.get("pin")
    if not is_valid_pin(pin):
        return _error("Enter a 4-digit PIN.", 400)

    try:
        throttle, recent = _recent_failures()
        if len(recent) >= _MAX_FAILURES:
            retry_after = int(min(recent) + _FAILURE_WINDOW_SECONDS - time.time()) + 1
            logger.warning("Guest login locked: %d recent failures", len(recent))
            return _error(
                "Too many incorrect PINs. Try again later.", 429,
                retryAfterSeconds=max(retry_after, 1),
            )

        match = next((g for g in _all_guests() if pin_matches(pin, g)), None)
        container = get_menu_container()

        if match is None:
            throttle["failures"] = recent + [time.time()]
            container.upsert_item(body=throttle)
            logger.info("Guest login failed (%d recent failures)", len(throttle["failures"]))
            return _error("Incorrect PIN.", 401)

        match["lastLoginAt"] = _now_iso()
        try:
            container.upsert_item(body=match)
        except Exception:  # noqa: BLE001 — lastLoginAt is informational only
            logger.warning("Could not record lastLoginAt for %s", match["id"])

        token = issue_guest_token(match)
    except Exception:
        logger.exception("Guest login failed unexpectedly")
        return _error("Sign-in failed. Please try again.", 500)

    logger.info("Guest %s signed in", match["id"])
    principal = Principal(kind="guest", role="guest", name=match.get("name", "Guest"), user_id=match["id"])
    return _json_response(
        _session_body(principal),
        headers={"Set-Cookie": guest_cookie_header(req, token)},
    )


# ── POST /api/auth/logout ──────────────────────────────────────────────────────

@guest_bp.route(route="auth/logout", methods=["POST"])
def auth_logout(req: func.HttpRequest) -> func.HttpResponse:
    """Clear the guest cookie on this device. (Microsoft sign-out is /.auth/logout.)"""
    return _json_response({"ok": True}, headers={"Set-Cookie": guest_cookie_header(req, None)})


# ── GET /api/guests ────────────────────────────────────────────────────────────

@guest_bp.route(route="guests", methods=["GET"])
def list_guests(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    guests = sorted(_all_guests(), key=lambda g: (g.get("name") or "").lower())
    return _json_response({
        "guests": [_public_guest(g) for g in guests],
        "guestLoginEnabled": get_guest_secret() is not None,
    })


# ── POST /api/guests ───────────────────────────────────────────────────────────

@guest_bp.route(route="guests", methods=["POST"])
def create_guest(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    body, err = _parse_body(req)
    if err:
        return err

    name: str = (body.get("name") or "").strip()
    if not name:
        return _error("'name' is required.", 400)
    pin = body.get("pin")
    if not is_valid_pin(pin):
        return _error("PIN must be exactly 4 digits.", 400)
    if _pin_taken(pin):
        return _error("Another guest already uses that PIN.", 409)

    pin_hash, pin_salt = hash_pin(pin)
    doc = {
        "id": "guest_" + uuid4().hex[:8],
        "type": GUEST_DOC_TYPE,
        "name": name,
        "pinHash": pin_hash,
        "pinSalt": pin_salt,
        "tokenVersion": 1,
        "createdAt": _now_iso(),
        "lastLoginAt": None,
    }
    get_menu_container().create_item(body=doc)
    logger.info("Created guest %s", doc["id"])
    return _json_response(_public_guest(doc), 201)


# ── POST /api/guests/{id}/revoke  — more-specific, registered first ───────────

@guest_bp.route(route="guests/{id}/revoke", methods=["POST"])
def revoke_guest(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    guest_id: str = req.route_params.get("id", "")
    guest = load_guest(guest_id, use_cache=False)
    if guest is None:
        return _error(f"Guest '{guest_id}' not found.", 404)

    guest["tokenVersion"] = int(guest.get("tokenVersion", 1)) + 1
    get_menu_container().upsert_item(body=guest)
    forget_guest(guest_id)
    logger.info("Revoked sessions for guest %s", guest_id)
    return _json_response(_public_guest(guest))


# ── PUT /api/guests/{id} ───────────────────────────────────────────────────────

@guest_bp.route(route="guests/{id}", methods=["PUT"])
def update_guest(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    guest_id: str = req.route_params.get("id", "")
    guest = load_guest(guest_id, use_cache=False)
    if guest is None:
        return _error(f"Guest '{guest_id}' not found.", 404)

    body, err = _parse_body(req)
    if err:
        return err

    if "name" in body:
        name = (body["name"] or "").strip()
        if not name:
            return _error("'name' cannot be empty.", 400)
        guest["name"] = name
    if body.get("pin") not in (None, ""):
        pin = body["pin"]
        if not is_valid_pin(pin):
            return _error("PIN must be exactly 4 digits.", 400)
        if _pin_taken(pin, except_id=guest_id):
            return _error("Another guest already uses that PIN.", 409)
        guest["pinHash"], guest["pinSalt"] = hash_pin(pin)
        # New PIN → devices signed in with the old one must sign in again.
        guest["tokenVersion"] = int(guest.get("tokenVersion", 1)) + 1

    get_menu_container().upsert_item(body=guest)
    forget_guest(guest_id)
    logger.info("Updated guest %s", guest_id)
    return _json_response(_public_guest(guest))


# ── DELETE /api/guests/{id} ────────────────────────────────────────────────────

@guest_bp.route(route="guests/{id}", methods=["DELETE"])
def delete_guest(req: func.HttpRequest) -> func.HttpResponse:
    _, denied = authorize(req, OWNER_ROLES)
    if denied:
        return denied
    guest_id: str = req.route_params.get("id", "")
    if load_guest(guest_id, use_cache=False) is None:
        return _error(f"Guest '{guest_id}' not found.", 404)

    get_menu_container().delete_item(item=guest_id, partition_key=GUEST_DOC_TYPE)
    forget_guest(guest_id)
    logger.info("Deleted guest %s", guest_id)
    return _json_response({"ok": True})
