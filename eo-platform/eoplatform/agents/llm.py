"""Local LLM access through TradingAgents' own client factory (provider 'ollama').

No paid API is used or required: config.load_settings() refuses any provider other
than 'ollama' / 'openai_compatible' (local servers such as llama.cpp, LM Studio, vLLM).
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time

import httpx

from ..config import Settings

log = logging.getLogger("eo.llm")


class LocalLLM:
    def __init__(self, settings: Settings, metrics=None):
        self.s = settings
        self.metrics = metrics
        self._llm = None
        self.calls: list[dict] = []          # recent per-call measurements (dashboard)
        # Ollama serves one request at a time on CPU. Analysts run in parallel in the graph, so
        # without this lock requests queue inside Ollama while the HTTP timeout keeps running
        # (measured: calls finished at 27…233 s and one timed out in a real run).
        self._lock = threading.Lock()
        self.last_check: dict = {"ok": False, "detail": "not checked", "at": 0}

    @property
    def model(self) -> str:
        return self.s.llm_model

    def health(self, force: bool = False) -> dict:
        """Is the local server up AND is the configured model actually installed?"""
        if not self.s.llm_enabled:
            self.last_check = {"ok": False, "detail": "LLM disabled (EO_LLM_ENABLED=false)", "at": time.time()}
            return self.last_check
        if not force and time.time() - self.last_check["at"] < 30:
            return self.last_check
        base = self.s.llm_base_url.rstrip("/")
        try:
            r = httpx.get(f"{base}/models", timeout=5)
            r.raise_for_status()
            ids = [m.get("id") for m in r.json().get("data", [])]
            ok = self.s.llm_model in ids or any(i and i.split(":")[0] == self.s.llm_model for i in ids)
            detail = "ready" if ok else f"model '{self.s.llm_model}' not installed (have: {', '.join(map(str, ids[:8])) or 'none'}) — run: ollama pull {self.s.llm_model}"
            self.last_check = {"ok": ok, "detail": detail, "models": ids, "at": time.time()}
        except Exception as e:
            self.last_check = {"ok": False, "detail": f"local LLM server unreachable at {base}: {type(e).__name__}",
                               "at": time.time()}
        return self.last_check

    def _client(self):
        if self._llm is None:
            from tradingagents.llm_clients import create_llm_client
            self._llm = create_llm_client(
                provider=self.s.llm_provider, model=self.s.llm_model, base_url=self.s.llm_base_url,
                temperature=self.s.llm_temperature, timeout=self.s.llm_timeout, max_retries=1,
                max_tokens=700,
            ).get_llm()
        return self._llm

    def _body(self, max_tokens: int | None) -> dict:
        """Extra request fields, sent explicitly because the client renames/drops them:
        * reasoning_effort — Qwen 3.5 thinks by default: measured 264 s and an EMPTY answer;
          "think": false is ignored on /v1; reasoning_effort "none" → 14.9 s, correct answer.
          TradingAgents' client only forwards reasoning_effort for OpenAI models.
        * max_tokens — langchain sends max_completion_tokens, which Ollama 0.40.16 IGNORES
          (measured: limit 12 → 313 tokens generated); max_tokens is honoured (→ 12)."""
        body = {}
        if self.s.llm_reasoning:
            body["reasoning_effort"] = self.s.llm_reasoning
        body["max_tokens"] = int(max_tokens or 400)
        return body

    def ask(self, prompt: str, max_tokens: int | None = None, role: str = "") -> str:
        llm = self._client().bind(extra_body=self._body(max_tokens))
        t_wait = time.perf_counter()
        with self._lock:
            t0 = time.perf_counter()
            resp = llm.invoke(prompt)
            secs = time.perf_counter() - t0
        um = getattr(resp, "usage_metadata", None) or {}
        rec = {"role": role, "at": time.time(), "secs": round(secs, 2), "queued_s": round(t0 - t_wait, 2),
               "in_tokens": um.get("input_tokens"), "out_tokens": um.get("output_tokens"),
               "prompt_chars": len(prompt)}
        if rec["out_tokens"]:
            rec["out_tok_per_s"] = round(rec["out_tokens"] / secs, 2) if secs else None
        self.calls.append(rec)
        del self.calls[:-200]
        if self.metrics is not None:
            self.metrics.observe("llm_call_s", secs)
            if rec["in_tokens"]:
                self.metrics.observe("llm_in_tokens", rec["in_tokens"])
            if rec["out_tokens"]:
                self.metrics.observe("llm_out_tokens", rec["out_tokens"])
        content = resp.content
        if isinstance(content, list):
            content = "\n".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content)
        # Some local reasoning models inline their thinking; keep only the answer.
        return re.sub(r"<think>.*?</think>", "", str(content), flags=re.S).strip()

    def ask_json(self, prompt: str, max_tokens: int | None = None, role: str = "") -> dict:
        text = self.ask(prompt + "\n\nRespond with ONE JSON object only, no markdown.", max_tokens, role)
        return parse_json_answer(text)


def parse_json_answer(text: str) -> dict:
    """Parse the model's JSON, tolerating the one malformation seen in production with
    qwen3.5:9b: a complete object whose final closing brace is missing."""
    start = text.find("{")
    if start < 0:
        raise ValueError(f"no JSON in LLM answer: {text[:200]!r}")
    body = text[start:]
    end = body.rfind("}")
    candidates = ([body[:end + 1]] if end >= 0 else []) + [body.rstrip() + "}", body.rstrip() + '"}']
    for c in candidates:
        try:
            out = json.loads(c)
            if isinstance(out, dict):
                return out
        except ValueError:
            continue
    raise ValueError(f"unparseable JSON in LLM answer: {text[:200]!r}")
