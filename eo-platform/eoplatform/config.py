"""Runtime configuration, read from environment variables (and an optional .env file).

Secrets (session secret, bridge token, admin password) are never hard-coded and
never sent to the browser. See .env.example for every variable.
"""
from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

DURATIONS = (30, 60, 120, 300)  # seconds: 30s, 1m, 2m, 5m

# Analysis candle period for each trade duration (seconds).
# Short trades need sub-minute candles, which we build from 1-second bars.
ANALYSIS_PERIOD = {30: 5, 60: 10, 120: 20, 300: 60}


def _load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _b(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _i(name: str, default: int) -> int:
    v = os.environ.get(name)
    return int(v) if v not in (None, "") else default


def _f(name: str, default: float) -> float:
    v = os.environ.get(name)
    return float(v) if v not in (None, "") else default


@dataclass
class Settings:
    home: Path
    db_path: Path
    log_dir: Path
    model_dir: Path
    host: str = "127.0.0.1"
    port: int = 8000
    session_secret: str = ""
    cookie_secure: bool = False
    # --- data sources
    enable_binance: bool = True
    binance_rest: str = "https://data-api.binance.vision"
    binance_ws: str = "wss://data-stream.binance.vision/ws"
    bridge_enabled: bool = False   # opt-in: see ExpertOption T&C §6.2 warning in bridge/README.md
    binance_backfill_hours: float = 24.0
    news_enabled: bool = True
    news_url: str = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
    news_window_min: int = 30
    alert_webhook: str = ""         # optional POST target for alerts (ntfy, Slack-compatible, your own)
    retention_days: int = 30
    # --- freshness thresholds (seconds since last genuine update)
    live_max_age: float = 3.0
    delayed_max_age: float = 10.0
    stale_max_age: float = 60.0
    # --- decision policy
    payout: float = 0.80          # payout ratio used for the break-even accuracy
    require_validated_model: bool = True
    min_validation_samples: int = 200
    # --- local LLM (Ollama, via TradingAgents' own client)
    llm_enabled: bool = True
    llm_provider: str = "ollama"
    llm_model: str = "qwen3.5:9b"
    llm_base_url: str = "http://127.0.0.1:11434/v1"
    llm_timeout: float = 120.0
    llm_debate_rounds: int = 1
    llm_risk_rounds: int = 1
    llm_temperature: float = 0.2
    llm_reasoning: str = "none"     # reasoning_effort sent to the local server ("" = model default)
    # --- monitoring
    monitor_interval: int = 15
    retrain_interval_min: int = 360
    extra: dict = field(default_factory=dict)

    @property
    def breakeven(self) -> float:
        """Accuracy needed to break even on a binary option with this payout."""
        return 1.0 / (1.0 + self.payout)


def load_settings(env_file: str | None = None) -> Settings:
    root = Path(__file__).resolve().parent.parent
    _load_dotenv(Path(env_file) if env_file else root / ".env")
    home = Path(os.environ.get("EO_HOME", root / "var")).resolve()
    home.mkdir(parents=True, exist_ok=True)
    s = Settings(
        home=home,
        db_path=Path(os.environ.get("EO_DB_PATH", home / "eoplatform.db")),
        log_dir=Path(os.environ.get("EO_LOG_DIR", home / "logs")),
        model_dir=Path(os.environ.get("EO_MODEL_DIR", home / "models")),
        host=os.environ.get("EO_HOST", "127.0.0.1"),
        port=_i("EO_PORT", 8000),
        session_secret=os.environ.get("EO_SESSION_SECRET", ""),
        cookie_secure=_b("EO_COOKIE_SECURE", False),
        enable_binance=_b("EO_ENABLE_BINANCE", True),
        binance_rest=os.environ.get("EO_BINANCE_REST", "https://data-api.binance.vision"),
        binance_ws=os.environ.get("EO_BINANCE_WS", "wss://data-stream.binance.vision/ws"),
        bridge_enabled=_b("EO_BRIDGE_ENABLED", False),
        binance_backfill_hours=_f("EO_BINANCE_BACKFILL_HOURS", 24.0),
        news_enabled=_b("EO_NEWS_ENABLED", True),
        news_url=os.environ.get("EO_NEWS_URL", "https://nfs.faireconomy.media/ff_calendar_thisweek.json"),
        news_window_min=_i("EO_NEWS_WINDOW_MIN", 30),
        alert_webhook=os.environ.get("EO_ALERT_WEBHOOK", ""),
        retention_days=_i("EO_RETENTION_DAYS", 30),
        live_max_age=_f("EO_LIVE_MAX_AGE", 3.0),
        delayed_max_age=_f("EO_DELAYED_MAX_AGE", 10.0),
        stale_max_age=_f("EO_STALE_MAX_AGE", 60.0),
        payout=_f("EO_PAYOUT", 0.80),
        require_validated_model=_b("EO_REQUIRE_VALIDATED_MODEL", True),
        min_validation_samples=_i("EO_MIN_VALIDATION_SAMPLES", 200),
        llm_enabled=_b("EO_LLM_ENABLED", True),
        llm_provider=os.environ.get("EO_LLM_PROVIDER", "ollama"),
        llm_model=os.environ.get("EO_LLM_MODEL", "qwen3.5:9b"),
        llm_base_url=os.environ.get("EO_LLM_BASE_URL", "http://127.0.0.1:11434/v1"),
        llm_timeout=_f("EO_LLM_TIMEOUT", 120.0),
        llm_debate_rounds=_i("EO_LLM_DEBATE_ROUNDS", 1),
        llm_risk_rounds=_i("EO_LLM_RISK_ROUNDS", 1),
        llm_temperature=_f("EO_LLM_TEMPERATURE", 0.2),
        llm_reasoning=os.environ.get("EO_LLM_REASONING", "none"),
        monitor_interval=_i("EO_MONITOR_INTERVAL", 15),
        retrain_interval_min=_i("EO_RETRAIN_INTERVAL_MIN", 360),
    )
    if s.llm_provider.lower() not in ("ollama", "openai_compatible"):
        # Local-first policy: paid cloud providers are not wired in by default.
        raise ValueError("EO_LLM_PROVIDER must be 'ollama' or 'openai_compatible' (local servers only)")
    for d in (s.log_dir, s.model_dir, s.db_path.parent):
        d.mkdir(parents=True, exist_ok=True)
    if not s.session_secret:
        # Persist a random secret in the data dir (0600) so sessions survive restarts
        # without ever committing a secret to git.
        p = home / ".session_secret"
        if not p.exists():
            p.write_text(secrets.token_urlsafe(48))
            p.chmod(0o600)
        s.session_secret = p.read_text().strip()
    return s
