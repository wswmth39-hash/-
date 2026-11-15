"""Access control for the Telegram bot (strict secret-code gate).

Rules:
* No user may use ANY command, button, message or feature before unlocking with the correct code.
* The code is stored only as a salted hash (session secret as salt); it is never kept in plain
  text, never shown in a message, and never logged.
* Owner IDs (EO_TELEGRAM_ALLOWED_USERS) always pass without a code — they run the bot.
* A user who enters the correct code is granted access (persisted). The owner can change the code,
  ban a user, or revoke access from the dashboard; a banned/revoked user is blocked immediately.

Storage (owner's local DB only; never sent anywhere): one row per Telegram user id with the time
granted, banned flag and last-seen time. The code hash lives in the kv table.
"""
from __future__ import annotations

import hashlib
import hmac
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS telegram_access (
  uid INTEGER PRIMARY KEY, granted_at REAL, banned INTEGER NOT NULL DEFAULT 0, last_seen REAL
);
"""
KV_CODE = "tg_access_code_hash"


class AccessControl:
    def __init__(self, core):
        self.core = core
        with core.db._lock:
            core.db.conn.executescript(SCHEMA)
        # one-time seed from the environment if the owner hasn't set a code yet
        env_code = (getattr(core.s, "telegram_access_code", "") or "").strip()
        if env_code and not self.code_required():
            self.set_code(env_code)

    # ---------------------------------------------------------------- code
    def _hash(self, code: str) -> str:
        return hashlib.sha256(f"{self.core.s.session_secret}:{code}".encode()).hexdigest()

    def set_code(self, code: str) -> None:
        code = (code or "").strip()
        if len(code) < 4:
            raise ValueError("code too short")
        self.core.db.kv_set(KV_CODE, self._hash(code))   # only the hash is stored
        self.core.db.event("info", "telegram", "تم تحديث رمز الدخول السري للبوت")

    def clear_code(self) -> None:
        self.core.db.kv_set(KV_CODE, None)

    def code_required(self) -> bool:
        return bool(self.core.db.kv_get(KV_CODE))

    def check_code(self, code: str) -> bool:
        stored = self.core.db.kv_get(KV_CODE)
        if not stored:
            return False
        return hmac.compare_digest(str(stored), self._hash((code or "").strip()))   # constant-time

    # ---------------------------------------------------------------- users
    def is_owner(self, uid: int) -> bool:
        return uid in set(self.core.s.telegram_allowed)

    def _row(self, uid: int) -> dict | None:
        return self.core.db.one("SELECT * FROM telegram_access WHERE uid=?", (uid,))

    def is_banned(self, uid: int) -> bool:
        r = self._row(uid)
        return bool(r and r["banned"])

    def is_granted(self, uid: int) -> bool:
        r = self._row(uid)
        return bool(r and r["granted_at"] and not r["banned"])

    def status(self, uid: int) -> str:
        if self.is_banned(uid):
            return "banned"
        if self.is_owner(uid):
            return "owner"
        if self.is_granted(uid):
            return "granted"
        return "locked"

    def grant(self, uid: int) -> None:
        self.core.db.execute(
            "INSERT INTO telegram_access(uid,granted_at,banned,last_seen) VALUES(?,?,0,?) "
            "ON CONFLICT(uid) DO UPDATE SET granted_at=excluded.granted_at, banned=0, last_seen=excluded.last_seen",
            (uid, time.time(), time.time()))

    def touch(self, uid: int) -> None:
        self.core.db.execute("UPDATE telegram_access SET last_seen=? WHERE uid=?", (time.time(), uid))

    def ban(self, uid: int) -> None:
        self.core.db.execute(
            "INSERT INTO telegram_access(uid,granted_at,banned,last_seen) VALUES(?,?,1,?) "
            "ON CONFLICT(uid) DO UPDATE SET banned=1", (uid, None, time.time()))

    def unban(self, uid: int) -> None:
        self.core.db.execute("UPDATE telegram_access SET banned=0 WHERE uid=?", (uid,))

    def revoke(self, uid: int) -> None:
        """Remove granted access (the user must re-enter the code); does not ban."""
        self.core.db.execute("DELETE FROM telegram_access WHERE uid=?", (uid,))

    def users(self) -> list[dict]:
        return self.core.db.all("SELECT uid, granted_at, banned, last_seen FROM telegram_access ORDER BY last_seen DESC")

    def summary(self) -> dict:
        rows = self.users()
        return {"code_required": self.code_required(),
                "granted": sum(1 for r in rows if r["granted_at"] and not r["banned"]),
                "banned": sum(1 for r in rows if r["banned"]),
                "owners": len(set(self.core.s.telegram_allowed)), "users": rows}
