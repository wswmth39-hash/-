"""TEST-ONLY stand-in for Ollama's OpenAI-compatible endpoint (/v1/models,
/v1/chat/completions). Lets the test-suite exercise the real network path through
TradingAgents' client without downloading a model. It answers with fixed JSON and
records every request so tests can assert what each agent sent."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REQUESTS: list[dict] = []


class H(BaseHTTPRequestHandler):
    model = "qwen3.5:9b"
    final_decision = "BUY"

    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._send({"object": "list", "data": [{"id": self.model, "object": "model"}]})
        self._send({"error": "nf"}, 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(n))
        REQUESTS.append(req)
        prompt = req["messages"][-1]["content"]
        if "final decision" in prompt or "final call" in prompt:
            ans = {"decision": H.final_decision, "reason": "قرار اختباري"}
        elif "judge" in prompt.split("---")[-1]:
            ans = {"lean": "BUY", "summary": "ملخص الحكم"}
        elif "risk manager" in prompt.split("---")[-1]:
            ans = {"summary": "تقييم المخاطر", "extra_veto": ""}
        elif "researcher" in prompt.split("---")[-1] or "risk analyst" in prompt.split("---")[-1]:
            ans = {"argument": "<think>hidden</think>حجة اختبارية", "strength": 0.5}
        else:
            ans = {"stance": "bullish", "summary": "ملخص المحلل", "key_risk": "لا شيء"}
        self._send({"id": "x", "object": "chat.completion", "created": 0, "model": req.get("model"),
                    "choices": [{"index": 0, "finish_reason": "stop",
                                 "message": {"role": "assistant", "content": json.dumps(ans, ensure_ascii=False)}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})


def start() -> tuple[ThreadingHTTPServer, str]:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/v1"
