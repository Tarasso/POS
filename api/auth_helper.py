"""
auth_helper.py — Resolves who is calling the API and what they may do.

Two kinds of identity are accepted:

  1. Microsoft (SWA built-in auth) — for signed-in users SWA injects an
     `x-ms-client-principal` header (base64 JSON) into every request it forwards
     to the managed Functions app. Invitation roles ("owner", "staff") appear in
     `userRoles`. SWA sets this header itself; clients cannot forge it because
     managed Functions are only reachable through the SWA front door.

  2. Guest (4-digit PIN) — POST /api/auth/guest-login sets an HttpOnly cookie
     holding an HS256 JWT signed with GUEST_TOKEN_SECRET. Claims:
       sub — guest document id ("guest_...")
       ver — the guest's tokenVersion at sign-in; bumping it on the guest doc
             (PIN change / "sign out devices") invalidates every issued token
       iat — issued-at (used for sliding cookie refresh)

Every route calls `authorize(req, roles)` first:

    principal, denied = authorize(req, FULL_ACCESS)
    if denied:
        return denied

Environment variable required for guest login:
  GUEST_TOKEN_SECRET — long random string. Without it guest sign-in is disabled
  (Microsoft sign-in keeps working).
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from dataclasses import dataclass
from http.cookies import SimpleCookie

import azure.functions as func
import jwt  # PyJWT
from azure.cosmos.exceptions import CosmosResourceNotFoundError

from cosmos_helper import get_menu_container

logger = logging.getLogger(__name__)

# ── Roles ──────────────────────────────────────────────────────────────────────

OWNER_ROLES: frozenset[str] = frozenset({"owner", "staff"})
"""Full access — Microsoft users invited with the owner or staff role."""

ANY_ROLE: frozenset[str] = frozenset({"owner", "staff", "guest"})
"""Order taking + KDS — everyone who is signed in, including PIN guests."""

# ── Guest token / cookie settings ──────────────────────────────────────────────

GUEST_COOKIE = "pos_guest"
GUEST_DOC_TYPE = "guest"
_TOKEN_TTL_SECONDS = 400 * 24 * 3600      # 400 days — the maximum browsers honour
_TOKEN_REFRESH_AFTER_SECONDS = 7 * 24 * 3600  # reissue weekly → never expires while used
_GUEST_CACHE_SECONDS = 60                 # how long a guest doc lookup is reused

_PBKDF2_ITERATIONS = 50_000

# guest id → (fetched_at, doc or None)
_guest_cache: dict[str, tuple[float, dict | None]] = {}


@dataclass(frozen=True)
class Principal:
    kind: str   # "microsoft" | "guest"
    role: str   # "owner" | "staff" | "guest"
    name: str
    user_id: str
    token_iat: int | None = None  # guests only


# ── Helpers ────────────────────────────────────────────────────────────────────

def _json_error(message: str, status_code: int) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps({"error": message}),
        status_code=status_code,
        mimetype="application/json",
    )


def get_guest_secret() -> str | None:
    secret = os.environ.get("GUEST_TOKEN_SECRET", "").strip()
    return secret or None


def read_microsoft_principal(req: func.HttpRequest) -> dict | None:
    """Decode SWA's x-ms-client-principal header, or None when absent/invalid."""
    raw = req.headers.get("x-ms-client-principal")
    if not raw:
        return None
    try:
        data = json.loads(base64.b64decode(raw).decode("utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:  # noqa: BLE001
        logger.warning("Could not decode x-ms-client-principal header")
        return None


def _microsoft_principal(req: func.HttpRequest) -> Principal | None:
    data = read_microsoft_principal(req)
    if not data:
        return None
    roles = set(data.get("userRoles") or [])
    if "owner" in roles:
        role = "owner"
    elif "staff" in roles:
        role = "staff"
    else:
        return None  # signed in to Microsoft but never invited
    return Principal(
        kind="microsoft",
        role=role,
        name=str(data.get("userDetails") or "Owner"),
        user_id=str(data.get("userId") or ""),
    )


def _read_cookie(req: func.HttpRequest, name: str) -> str | None:
    header = req.headers.get("cookie")
    if not header:
        return None
    try:
        jar = SimpleCookie()
        jar.load(header)
    except Exception:  # noqa: BLE001
        return None
    morsel = jar.get(name)
    return morsel.value if morsel else None


def load_guest(guest_id: str, use_cache: bool = True) -> dict | None:
    """Point-read a guest doc (1 RU), cached briefly per worker instance."""
    now = time.monotonic()
    if use_cache:
        hit = _guest_cache.get(guest_id)
        if hit and now - hit[0] < _GUEST_CACHE_SECONDS:
            return hit[1]
    try:
        doc = get_menu_container().read_item(item=guest_id, partition_key=GUEST_DOC_TYPE)
    except CosmosResourceNotFoundError:
        doc = None
    _guest_cache[guest_id] = (now, doc)
    return doc


def forget_guest(guest_id: str) -> None:
    """Drop a cached guest doc so a PIN change / delete takes effect immediately here."""
    _guest_cache.pop(guest_id, None)


def _guest_principal(req: func.HttpRequest) -> Principal | None:
    token = _read_cookie(req, GUEST_COOKIE)
    secret = get_guest_secret()
    if not token or not secret:
        return None
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None

    guest_id = str(claims.get("sub") or "")
    if not guest_id.startswith("guest_"):
        return None
    try:
        guest = load_guest(guest_id)
    except Exception:  # noqa: BLE001
        logger.exception("Guest lookup failed for %s", guest_id)
        return None
    if not guest or guest.get("tokenVersion") != claims.get("ver"):
        return None  # deleted, PIN changed, or signed out remotely

    return Principal(
        kind="guest",
        role="guest",
        name=str(guest.get("name") or "Guest"),
        user_id=guest_id,
        token_iat=int(claims.get("iat") or 0),
    )


# ── Public API ─────────────────────────────────────────────────────────────────

def get_principal(req: func.HttpRequest) -> Principal | None:
    """Return the caller's identity, preferring a Microsoft session over a guest cookie."""
    return _microsoft_principal(req) or _guest_principal(req)


def authorize(
    req: func.HttpRequest, allowed_roles: frozenset[str]
) -> tuple[Principal | None, func.HttpResponse | None]:
    """Return (principal, None) when allowed, else (None, 401/403 response)."""
    principal = get_principal(req)
    if principal is None:
        return None, _json_error("Sign in required.", 401)
    if principal.role not in allowed_roles:
        return None, _json_error("You don't have access to this.", 403)
    return principal, None


# ── Guest tokens + cookies ─────────────────────────────────────────────────────

def issue_guest_token(guest: dict) -> str:
    secret = get_guest_secret()
    if not secret:
        raise RuntimeError("GUEST_TOKEN_SECRET is not configured")
    now = int(time.time())
    return jwt.encode(
        {"sub": guest["id"], "ver": guest.get("tokenVersion", 1), "iat": now,
         "exp": now + _TOKEN_TTL_SECONDS},
        secret,
        algorithm="HS256",
    )


def token_needs_refresh(principal: Principal) -> bool:
    return (
        principal.kind == "guest"
        and principal.token_iat is not None
        and time.time() - principal.token_iat > _TOKEN_REFRESH_AFTER_SECONDS
    )


def _is_local(req: func.HttpRequest) -> bool:
    host = (req.headers.get("x-forwarded-host") or req.headers.get("host") or "").lower()
    return host.startswith("localhost") or host.startswith("127.0.0.1")


def guest_cookie_header(req: func.HttpRequest, token: str | None) -> str:
    """Build the Set-Cookie value. token=None clears the cookie."""
    parts = [
        f"{GUEST_COOKIE}={token or ''}",
        "Path=/api",
        "HttpOnly",
        "SameSite=Lax",
        f"Max-Age={_TOKEN_TTL_SECONDS if token else 0}",
    ]
    # Safari refuses Secure cookies on http://localhost, so omit it for local dev.
    if not _is_local(req):
        parts.append("Secure")
    return "; ".join(parts)


# ── PIN hashing ────────────────────────────────────────────────────────────────

def hash_pin(pin: str, salt: str | None = None) -> tuple[str, str]:
    """Return (hash_hex, salt_hex). A fresh random salt is generated when none is given."""
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode("utf-8"), bytes.fromhex(salt), _PBKDF2_ITERATIONS)
    return digest.hex(), salt


def pin_matches(pin: str, guest: dict) -> bool:
    salt = guest.get("pinSalt")
    stored = guest.get("pinHash")
    if not salt or not stored:
        return False
    candidate, _ = hash_pin(pin, salt)
    return hmac.compare_digest(candidate, stored)


def is_valid_pin(pin: object) -> bool:
    return isinstance(pin, str) and len(pin) == 4 and pin.isascii() and pin.isdigit()
