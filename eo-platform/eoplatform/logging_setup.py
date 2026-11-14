"""Structured JSON logging to a size-rotated file plus readable console output."""
from __future__ import annotations

import json
import logging
import logging.handlers
import time
from pathlib import Path


class JsonFormatter(logging.Formatter):
    def format(self, r: logging.LogRecord) -> str:
        d = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(r.created)) + f".{int(r.msecs):03d}Z",
             "level": r.levelname, "logger": r.name, "msg": r.getMessage()}
        for k in ("health", "market", "duration", "signal_id"):
            if hasattr(r, k):
                d[k] = getattr(r, k)
        if r.exc_info:
            d["exc"] = self.formatException(r.exc_info)
        return json.dumps(d, ensure_ascii=False, default=str)


def setup(log_dir: Path, level: str = "INFO") -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    root.setLevel(level)
    for h in list(root.handlers):
        root.removeHandler(h)
    fh = logging.handlers.RotatingFileHandler(log_dir / "eoplatform.jsonl", maxBytes=20 * 2**20, backupCount=5,
                                              encoding="utf-8")
    fh.setFormatter(JsonFormatter())
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root.addHandler(fh)
    root.addHandler(ch)
    for noisy in ("httpx", "httpcore", "websockets", "uvicorn.access", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
