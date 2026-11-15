"""Shared fixtures. All price data generated here is SYNTHETIC and exists only inside
temporary test databases; it is used to test mechanics, never to claim accuracy."""
import os
import sys
import time
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))


@pytest.fixture
def settings(tmp_path, monkeypatch):
    monkeypatch.setenv("EO_HOME", str(tmp_path))
    monkeypatch.setenv("EO_LLM_BASE_URL", "http://127.0.0.1:9/v1")  # nothing listens: LLM unavailable
    monkeypatch.setenv("EO_ENABLE_BINANCE", "false")
    monkeypatch.setenv("EO_MIN_VALIDATION_SAMPLES", "150")
    from eoplatform.config import load_settings
    return load_settings(env_file=str(tmp_path / "none.env"))


@pytest.fixture
def env(settings):
    from eoplatform.data.hub import DataHub
    from eoplatform.db import DB
    from eoplatform.engine.model import Registry
    from eoplatform.markets import ensure_catalog
    db = DB(settings.db_path)
    ensure_catalog(db)
    hub = DataHub(db, settings.live_max_age, settings.delayed_max_age, settings.stale_max_age)
    return settings, db, hub, Registry(db, settings.model_dir)


def random_walk_bars(n: int, end: float | None = None, seed: int = 0, vol: float = 1e-4, p0: float = 1.1):
    rng = np.random.default_rng(seed)
    end = int(end or time.time())
    closes = p0 * np.exp(np.cumsum(rng.normal(0, vol, n)))
    opens = np.concatenate([[p0], closes[:-1]])
    hi = np.maximum(opens, closes) * (1 + np.abs(rng.normal(0, vol / 3, n)))
    lo = np.minimum(opens, closes) * (1 - np.abs(rng.normal(0, vol / 3, n)))
    ts = np.arange(end - n, end)
    return [(int(t), float(o), float(h), float(l), float(c), 1) for t, o, h, l, c in zip(ts, opens, hi, lo, closes)]


def trending_regime_bars(n: int, end: float | None = None, seed: int = 0, vol: float = 1e-4):
    """Planted, learnable structure: persistent drift regimes (momentum)."""
    rng = np.random.default_rng(seed)
    drift = np.empty(n)
    i = 0
    while i < n:
        L = int(rng.integers(300, 900))
        drift[i:i + L] = rng.choice([-1, 1]) * 0.6 * vol
        i += L
    end = int(end or time.time())
    closes = 1.1 * np.exp(np.cumsum(drift + rng.normal(0, vol, n)))
    opens = np.concatenate([[1.1], closes[:-1]])
    hi, lo = np.maximum(opens, closes) * (1 + 2e-6), np.minimum(opens, closes) * (1 - 2e-6)
    ts = np.arange(end - n, end)
    return [(int(t), float(o), float(h), float(l), float(c), 1) for t, o, h, l, c in zip(ts, opens, hi, lo, closes)]
