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
    def __init__(self, settings: Settings):
        self.s = settings
        self._llm = None
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
            if self.s.llm_reasoning:
                # Qwen 3.5 is a reasoning model. Measured on qwen3.5:9b / Ollama 0.40.16 / 4 CPUs:
                # default → 264 s and an EMPTY answer (all tokens spent thinking); "think": false is
                # ignored on /v1; reasoning_effort "none" → 14.9 s with the correct answer.
                # TradingAgents' client only forwards reasoning_effort for OpenAI models, so bind it here.
                self._llm = self._llm.bind(extra_body={"reasoning_effort": self.s.llm_reasoning})
        return self._llm

    def ask(self, prompt: str) -> str:
        with self._lock:
            resp = self._client().invoke(prompt)
        content = resp.content
        if isinstance(content, list):
            content = "\n".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content)
        # Some local reasoning models inline their thinking; keep only the answer.
        return re.sub(r"<think>.*?</think>", "", str(content), flags=re.S).strip()

    def ask_json(self, prompt: str) -> dict:
        text = self.ask(prompt + "\n\nRespond with ONE JSON object only, no markdown.")
        m = re.search(r"\{.*\}", text, flags=re.S)
        if not m:
            raise ValueError(f"no JSON in LLM answer: {text[:200]!r}")
        return json.loads(m.group(0))
