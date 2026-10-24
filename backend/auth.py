"""
Forked accounts — a small, file-backed auth service (no database by design).

Storage (data/users/, gitignored):
  users.json     {"users": {<user_id lower>: {...profile, "password": {...scrypt}}}}
  sessions.json  {<sha256(token)>: {"user_id", "created_at", "expires_at", "last_seen"}}

Security choices:
  * passwords: hashlib.scrypt (n=2**14, r=8, p=1, 16-byte salt) — memory-hard,
    constant-time comparison with hmac.compare_digest;
  * sessions: 256-bit random bearer tokens; only their SHA-256 is stored, so a
    leaked sessions.json can't be replayed; 30-day expiry, sliding last_seen;
  * login throttling: 8 failed attempts per identifier / 15 minutes (in memory);
  * the developer shortcut (/dev-login) signs into the maintainer's demo account
    and is on by default for local use — set FORKED_DEV_LOGIN=0 to disable it.

Identity model: an account has a Forked `user_id` (its handle) and a linked
chess account (`platform` + `chess_username`). Every per-user data file under
data/output/ is keyed by the chess username, exactly as before, so existing
profiles keep working after sign-up.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import logging
import os
import re
import secrets
import threading
import time
from typing import Literal, Optional

import requests
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from backend.storage import locked_update, read_json
from ml.config import DATA_DIR, REQUEST_HEADERS

log = logging.getLogger("forked.auth")
router = APIRouter(prefix="/api/auth")

USERS_DIR = DATA_DIR / "users"
USERS_PATH = USERS_DIR / "users.json"
SESSIONS_PATH = USERS_DIR / "sessions.json"
SESSION_DAYS = 30

DEV_USER_ID = "ShahuPatil27"
DEV_PLATFORM = "chesscom"
DEV_CHESS_USERNAME = "ShahuPatil27"

USER_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{3,30}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[A-Za-z]{2,}$")
CHESS_USER_RE = re.compile(r"^[A-Za-z0-9_\-]{2,40}$")
PHONE_RE = re.compile(r"^\+?[0-9 ()\-]{7,20}$")

Platform = Literal["chesscom", "lichess"]


def dev_login_enabled() -> bool:
    return os.environ.get("FORKED_DEV_LOGIN", "1").strip().lower() not in ("0", "false", "no", "off")


# ── password hashing ─────────────────────────────────────────────────────────

_SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1, "dklen": 32}


def hash_password(password: str) -> dict:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, maxmem=64 * 1024 * 1024, **_SCRYPT)
    return {"algo": "scrypt", **{k: v for k, v in _SCRYPT.items() if k != "dklen"},
            "salt": base64.b64encode(salt).decode(), "hash": base64.b64encode(digest).decode()}


def verify_password(password: str, record: dict | None) -> bool:
    if not record or record.get("algo") != "scrypt":
        return False
    try:
        salt = base64.b64decode(record["salt"])
        expected = base64.b64decode(record["hash"])
        digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=int(record["n"]), r=int(record["r"]),
                                p=int(record["p"]), dklen=len(expected), maxmem=64 * 1024 * 1024)
    except Exception:
        return False
    return hmac.compare_digest(digest, expected)


def password_problem(password: str) -> Optional[str]:
    if len(password) < 8:
        return "Use at least 8 characters for your password."
    if len(password) > 128:
        return "That password is too long (128 characters max)."
    if not re.search(r"[A-Za-z]", password) or not re.search(r"[0-9]", password):
        return "Use at least one letter and one number in your password."
    return None


# ── storage ──────────────────────────────────────────────────────────────────

def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _users() -> dict:
    return (read_json(USERS_PATH, {"users": {}}) or {"users": {}}).get("users", {})


def public_user(rec: dict) -> dict:
    return {k: rec.get(k) for k in ("user_id", "name", "email", "phone", "platform", "chess_username",
                                     "created_at", "updated_at", "is_dev", "chess_verified")}


def find_user(identifier: str) -> Optional[dict]:
    ident = (identifier or "").strip().lower()
    if not ident:
        return None
    users = _users()
    if ident in users:
        return users[ident]
    for rec in users.values():
        if (rec.get("email") or "").lower() == ident:
            return rec
    return None


def _token_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = dt.datetime.now(dt.timezone.utc)

    def add(sessions: dict):
        # prune expired sessions while we're here
        for key in [k for k, s in sessions.items() if s.get("expires_at", "") < now.isoformat()]:
            sessions.pop(key, None)
        sessions[_token_key(token)] = {"user_id": user_id.lower(), "created_at": now.isoformat(),
                                       "expires_at": (now + dt.timedelta(days=SESSION_DAYS)).isoformat(),
                                       "last_seen": now.isoformat()}
    locked_update(SESSIONS_PATH, {}, add)
    return token


def user_for_token(token: Optional[str]) -> Optional[dict]:
    if not token:
        return None
    sessions = read_json(SESSIONS_PATH, {}) or {}
    s = sessions.get(_token_key(token))
    if not s or s.get("expires_at", "") < _now():
        return None
    return _users().get(s.get("user_id", ""))


def bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip() or None
    return None


def current_user(request: Request) -> Optional[dict]:
    """The signed-in account for this request, or None (anonymous)."""
    return user_for_token(bearer(request.headers.get("authorization")))


def require_user(authorization: Optional[str]) -> dict:
    user = user_for_token(bearer(authorization))
    if user is None:
        raise HTTPException(401, "Please sign in again.")
    return user


def assert_owner(request: Request, username: str) -> None:
    """If the request is signed in, the chess username in the path must be the
    account's own. Anonymous requests are allowed (local/legacy tools)."""
    user = current_user(request)
    if user is not None and (user.get("chess_username") or "").lower() != (username or "").lower() \
            and (user.get("user_id") or "").lower() != (username or "").lower():
        raise HTTPException(403, "That data belongs to another account.")


# ── chess account check ──────────────────────────────────────────────────────

def chess_account_exists(platform: str, username: str) -> Optional[bool]:
    """True / False when the platform answers; None if it can't be reached."""
    try:
        if platform == "chesscom":
            r = requests.get(f"https://api.chess.com/pub/player/{username.lower()}", headers=REQUEST_HEADERS, timeout=6)
        else:
            r = requests.get(f"https://lichess.org/api/user/{username}", headers=REQUEST_HEADERS, timeout=6)
    except Exception:
        return None
    if r.status_code == 404:
        return False
    if r.status_code == 200:
        if platform == "lichess":
            try:
                return not r.json().get("disabled", False)
            except Exception:
                return True
        return True
    return None


# ── login throttle ───────────────────────────────────────────────────────────

_fail_lock = threading.Lock()
_failures: dict[str, list[float]] = {}
FAIL_WINDOW_S = 15 * 60
MAX_FAILS = 8


def _throttled(ident: str) -> bool:
    now = time.time()
    with _fail_lock:
        hits = [t for t in _failures.get(ident, []) if now - t < FAIL_WINDOW_S]
        _failures[ident] = hits
        return len(hits) >= MAX_FAILS


def _record_failure(ident: str) -> None:
    with _fail_lock:
        _failures.setdefault(ident, []).append(time.time())


# ── API ──────────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    user_id: str = Field(min_length=3, max_length=30)
    email: str = Field(min_length=3, max_length=254)
    phone: Optional[str] = Field(default=None, max_length=24)
    password: str = Field(min_length=1, max_length=128)
    platform: Platform = "chesscom"
    chess_username: str = Field(min_length=2, max_length=40)


class LoginRequest(BaseModel):
    identifier: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=128)


class ProfileUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=80)
    email: Optional[str] = Field(default=None, max_length=254)
    phone: Optional[str] = Field(default=None, max_length=24)
    platform: Optional[Platform] = None
    chess_username: Optional[str] = Field(default=None, max_length=40)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=128)


def _validate_profile(name: Optional[str], email: Optional[str], phone: Optional[str],
                      chess_username: Optional[str]) -> None:
    if name is not None and not name.strip():
        raise HTTPException(422, "Please enter your name.")
    if email is not None and not EMAIL_RE.match(email.strip()):
        raise HTTPException(422, "That email address doesn't look right.")
    if phone and not PHONE_RE.match(phone.strip()):
        raise HTTPException(422, "Use digits for the phone number (a leading + is fine).")
    if chess_username is not None and not CHESS_USER_RE.match(chess_username.strip()):
        raise HTTPException(422, "That chess username doesn't look right.")


@router.get("/config")
def auth_config():
    return {"dev_login": dev_login_enabled(), "dev_user": DEV_USER_ID if dev_login_enabled() else None}


@router.post("/register")
def register(req: RegisterRequest):
    user_id = req.user_id.strip()
    if not USER_ID_RE.match(user_id):
        raise HTTPException(422, "User ID: 3–30 letters, numbers, _ or -.")
    _validate_profile(req.name, req.email, req.phone, req.chess_username)
    problem = password_problem(req.password)
    if problem:
        raise HTTPException(422, problem)

    exists = chess_account_exists(req.platform, req.chess_username.strip())
    if exists is False:
        site = "Chess.com" if req.platform == "chesscom" else "Lichess"
        raise HTTPException(422, f"We couldn't find “{req.chess_username}” on {site}. Check the spelling.")

    now = _now()
    record = {
        "user_id": user_id, "name": req.name.strip(), "email": req.email.strip().lower(),
        "phone": (req.phone or "").strip() or None, "platform": req.platform,
        "chess_username": req.chess_username.strip(), "chess_verified": exists is True,
        "created_at": now, "updated_at": now, "is_dev": False, "password": hash_password(req.password),
    }

    def add(store: dict):
        users = store.setdefault("users", {})
        if user_id.lower() in users:
            raise HTTPException(409, "That user ID is taken. Try another.")
        if any((u.get("email") or "").lower() == record["email"] for u in users.values()):
            raise HTTPException(409, "An account with that email already exists. Sign in instead.")
        users[user_id.lower()] = record
    locked_update(USERS_PATH, {"users": {}}, add, indent=2)
    token = create_session(user_id)
    log.info("Registered account %s (%s:%s)", user_id, req.platform, req.chess_username)
    return {"token": token, "user": public_user(record)}


@router.post("/login")
def login(req: LoginRequest):
    ident = req.identifier.strip().lower()
    if _throttled(ident):
        raise HTTPException(429, "Too many attempts. Wait a few minutes and try again.")
    rec = find_user(ident)
    if rec is None or not verify_password(req.password, rec.get("password")):
        _record_failure(ident)
        raise HTTPException(401, "That user ID / email and password don't match.")
    return {"token": create_session(rec["user_id"]), "user": public_user(rec)}


@router.post("/dev-login")
def dev_login():
    """Developer shortcut: sign straight into the maintainer's demo account."""
    if not dev_login_enabled():
        raise HTTPException(404, "Not found")

    def ensure(store: dict):
        users = store.setdefault("users", {})
        if DEV_USER_ID.lower() not in users:
            now = _now()
            users[DEV_USER_ID.lower()] = {
                "user_id": DEV_USER_ID, "name": "Shahu Patil (developer)", "email": "developer@forked.local",
                "phone": None, "platform": DEV_PLATFORM, "chess_username": DEV_CHESS_USERNAME,
                "chess_verified": True, "created_at": now, "updated_at": now, "is_dev": True,
                # random password: the dev account is reachable only through this shortcut
                "password": hash_password(secrets.token_urlsafe(24)),
            }
    store = locked_update(USERS_PATH, {"users": {}}, ensure, indent=2)
    rec = store["users"][DEV_USER_ID.lower()]
    return {"token": create_session(rec["user_id"]), "user": public_user(rec)}


@router.get("/me")
def me(authorization: Optional[str] = Header(default=None)):
    return {"user": public_user(require_user(authorization))}


@router.patch("/me")
def update_me(req: ProfileUpdate, authorization: Optional[str] = Header(default=None)):
    user = require_user(authorization)
    _validate_profile(req.name, req.email, req.phone, req.chess_username)
    platform = req.platform or user.get("platform")
    if req.chess_username is not None or req.platform is not None:
        name = (req.chess_username or user.get("chess_username") or "").strip()
        if chess_account_exists(platform, name) is False:
            raise HTTPException(422, f"We couldn't find “{name}” on {'Chess.com' if platform == 'chesscom' else 'Lichess'}.")

    def edit(store: dict):
        users = store.setdefault("users", {})
        rec = users.get(user["user_id"].lower())
        if rec is None:
            raise HTTPException(404, "Account not found.")
        if req.email is not None:
            email = req.email.strip().lower()
            if any(k != user["user_id"].lower() and (u.get("email") or "").lower() == email for k, u in users.items()):
                raise HTTPException(409, "Another account already uses that email.")
            rec["email"] = email
        if req.name is not None:
            rec["name"] = req.name.strip()
        if req.phone is not None:
            rec["phone"] = req.phone.strip() or None
        if req.platform is not None:
            rec["platform"] = req.platform
        if req.chess_username is not None:
            rec["chess_username"] = req.chess_username.strip()
        rec["updated_at"] = _now()
    store = locked_update(USERS_PATH, {"users": {}}, edit, indent=2)
    return {"user": public_user(store["users"][user["user_id"].lower()])}


@router.post("/change-password")
def change_password(req: PasswordChange, authorization: Optional[str] = Header(default=None)):
    user = require_user(authorization)
    if not verify_password(req.current_password, user.get("password")):
        raise HTTPException(401, "Your current password isn't right.")
    problem = password_problem(req.new_password)
    if problem:
        raise HTTPException(422, problem)

    def edit(store: dict):
        rec = store["users"][user["user_id"].lower()]
        rec["password"] = hash_password(req.new_password)
        rec["updated_at"] = _now()
    locked_update(USERS_PATH, {"users": {}}, edit, indent=2)
    return {"ok": True}


@router.post("/logout")
def logout(authorization: Optional[str] = Header(default=None)):
    token = bearer(authorization)
    if token:
        locked_update(SESSIONS_PATH, {}, lambda s: s.pop(_token_key(token), None) and None)
    return {"ok": True}
