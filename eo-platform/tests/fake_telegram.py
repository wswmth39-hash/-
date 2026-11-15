"""TEST-ONLY local stand-in for the Telegram Bot API (https://core.telegram.org/bots/api).

python-telegram-bot is pointed at it with ``base_url``; it then exercises its real HTTP code
path (form-encoded requests, JSON responses, long polling) without internet access.
Supports getMe, deleteWebhook, setMyCommands, getUpdates, sendMessage, editMessageText,
answerCallbackQuery, leaveChat. Records everything the bot sends.
Can simulate a 409 Conflict on getUpdates (``conflict = True``), as Telegram returns when a
second process polls with the same token, and group / supergroup / channel chats."""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

BOT = {"id": 999, "is_bot": True, "first_name": "EO AI", "username": "eo_ai_test_bot"}


class FakeTelegram:
    def __init__(self, token: str, username: str = BOT["username"]):
        self.token = token
        self.me = {**BOT, "username": username}
        self.updates: list[dict] = []
        self.sent: list[dict] = []           # every sendMessage / editMessageText call
        self.answers: list[dict] = []
        self.calls: list[str] = []
        self.left: list[int] = []            # chat ids passed to leaveChat
        self.conflict = False                # True → getUpdates answers 409 Conflict
        self.conflicts_served = 0
        self.cond = threading.Condition()
        self._uid = 0
        self._mid = 100
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(n).decode()
                ctype = self.headers.get("Content-Type", "")
                if "json" in ctype:
                    params = json.loads(raw or "{}")
                else:
                    params = {k: v[0] for k, v in parse_qs(raw).items()}
                path = self.path.split("/")
                if len(path) < 3 or path[1] != f"bot{fake.token}":
                    return self._send({"ok": False, "error_code": 401, "description": "Unauthorized"}, 401)
                method = path[2]
                fake.calls.append(method)
                if method == "getUpdates" and fake.conflict:
                    fake.conflicts_served += 1
                    return self._send({"ok": False, "error_code": 409, "description":
                                       "Conflict: terminated by other getUpdates request; make sure that only one "
                                       "bot instance is running"}, 409)
                self._send({"ok": True, "result": fake.handle(method, params)})

            def _send(self, obj, code=200):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass   # the bot closed a long poll while shutting down

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.base_url = f"http://127.0.0.1:{self.srv.server_address[1]}/bot"

    def handle(self, method: str, p: dict):
        if method == "getMe":
            return self.me
        if method in ("deleteWebhook", "setMyCommands", "close"):
            return True
        if method == "leaveChat":
            self.left.append(int(p.get("chat_id", 0) or 0))
            return True
        if method == "answerCallbackQuery":
            self.answers.append(p)
            return True
        if method == "getUpdates":
            offset = int(p.get("offset", 0) or 0)
            deadline = time.time() + min(float(p.get("timeout", 0) or 0), 1.0)
            with self.cond:
                while True:
                    out = [u for u in self.updates if u["update_id"] >= offset]
                    if out or time.time() >= deadline:
                        return out
                    self.cond.wait(0.05)
        if method in ("sendMessage", "editMessageText"):
            with self.cond:
                self._mid += 1
                rec = {"method": method, "chat_id": int(p.get("chat_id", 0) or 0), "text": p.get("text", ""),
                       "reply_markup": json.loads(p["reply_markup"]) if p.get("reply_markup") else None,
                       "parse_mode": p.get("parse_mode")}
                self.sent.append(rec)
                self.cond.notify_all()
            return {"message_id": self._mid, "date": int(time.time()), "text": rec["text"],
                    "chat": {"id": rec["chat_id"] or 1, "type": "private"}, "from": BOT}
        return True

    # ---------------------------------------------------------------- driving the bot
    def _push(self, upd: dict) -> None:
        with self.cond:
            self._uid += 1
            upd["update_id"] = self._uid
            self.updates.append(upd)
            self.cond.notify_all()

    def user(self, uid: int) -> dict:
        return {"id": uid, "is_bot": False, "first_name": f"U{uid}"}

    @staticmethod
    def chat(uid: int, chat: dict | None) -> dict:
        return chat or {"id": uid, "type": "private"}

    def command(self, uid: int, text: str, chat: dict | None = None) -> None:
        cmd = text.split()[0]
        self._push({"message": {"message_id": self._uid + 1, "date": int(time.time()), "text": text,
                                "chat": self.chat(uid, chat), "from": self.user(uid),
                                "entities": [{"type": "bot_command", "offset": 0, "length": len(cmd)}]}})

    def text(self, uid: int, text: str, chat: dict | None = None) -> None:
        self._push({"message": {"message_id": self._uid + 1, "date": int(time.time()), "text": text,
                                "chat": self.chat(uid, chat), "from": self.user(uid)}})

    def press(self, uid: int, data: str, chat: dict | None = None) -> None:
        self._push({"callback_query": {"id": f"cq{self._uid + 1}", "from": self.user(uid), "chat_instance": "x",
                                       "data": data, "message": {"message_id": 50, "date": int(time.time()),
                                                                 "text": "old", "chat": self.chat(uid, chat),
                                                                 "from": BOT}}})

    def added_to(self, uid: int, chat: dict, status: str = "member") -> None:
        """``my_chat_member`` update: user ``uid`` added the bot to ``chat``."""
        self._push({"my_chat_member": {"chat": chat, "from": self.user(uid), "date": int(time.time()),
                                       "old_chat_member": {"status": "left", "user": BOT},
                                       "new_chat_member": {"status": status, "user": BOT,
                                                           **({"can_be_edited": False, "can_manage_chat": True,
                                                               "can_change_info": True, "can_delete_messages": True,
                                                               "can_invite_users": True, "can_restrict_members": True,
                                                               "can_pin_messages": True, "can_promote_members": False,
                                                               "is_anonymous": False, "can_manage_video_chats": True,
                                                               "can_post_stories": False, "can_edit_stories": False,
                                                               "can_delete_stories": False}
                                                              if status == "administrator" else {})}}})

    def wait_for(self, pred, timeout: float = 10.0) -> dict:
        end = time.time() + timeout
        with self.cond:
            while time.time() < end:
                for m in self.sent:
                    if pred(m):
                        return m
                self.cond.wait(0.05)
        raise AssertionError(f"no matching message; got {[m['text'][:60] for m in self.sent]}")

    def buttons(self, msg: dict) -> list[tuple[str, str]]:
        return [(b["text"], b.get("callback_data")) for row in (msg.get("reply_markup") or {}).get("inline_keyboard", [])
                for b in row]

    def close(self):
        self.srv.shutdown()
