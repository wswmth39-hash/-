"""Website authentication: scrypt password hashes, signed HttpOnly session cookies,
double-submit CSRF tokens and login throttling. No secret ever reaches the frontend
except the per-session CSRF token, which is useless without the HttpOnly cookie."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from collections import defaultdict

from itsdangerous import BadSignature, URLSafeTimedSerializer

from ..db import DB

COOKIE = "eo_session"
SESSION_MAX_AGE = 12 * 3600
_N, _R, _P = 2**14, 8, 1


def hash_password(pw: str) -> str:
    if len(pw) < 10:
        raise ValueError("password must be at least 10 characters")
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, dk = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, base64.b64decode(dk))
    except Exception:
        return False


def create_user(db: DB, username: str, password: str) -> None:
    db.execute("INSERT INTO users(username,pw_hash,created_at) VALUES(?,?,?) "
               "ON CONFLICT(username) DO UPDATE SET pw_hash=excluded.pw_hash",
               (username, hash_password(password), time.time()))


class Auth:
    def __init__(self, db: DB, secret: str):
        self.db = db
        self.ser = URLSafeTimedSerializer(secret, salt="eo-session")
        self.fails: dict[str, list[float]] = defaultdict(list)

    def has_users(self) -> bool:
        return bool(self.db.one("SELECT 1 FROM users LIMIT 1"))

    def throttled(self, key: str) -> bool:
        now = time.time()
        self.fails[key] = [t for t in self.fails[key] if now - t < 600]
        return len(self.fails[key]) >= 5

    def login(self, username: str, password: str, key: str) -> str | None:
        if self.throttled(key):
            return None
        u = self.db.one("SELECT id, pw_hash FROM users WHERE username=?", (username,))
        # constant-ish time even for unknown users
        ok = verify_password(password, u["pw_hash"] if u else hash_password("x" * 12))
        if not (u and ok):
            self.fails[key].append(time.time())
            return None
        self.fails.pop(key, None)
        return self.ser.dumps({"uid": u["id"], "u": username, "csrf": secrets.token_urlsafe(24)})

    def session(self, cookie: str | None) -> dict | None:
        if not cookie:
            return None
        try:
            data = self.ser.loads(cookie, max_age=SESSION_MAX_AGE)
        except BadSignature:
            return None
        if not self.db.one("SELECT 1 FROM users WHERE id=?", (data.get("uid"),)):
            return None
        return data
