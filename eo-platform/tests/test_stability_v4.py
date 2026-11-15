"""V4 phase 13 — single instance locks, backup/restore, indexes, Windows-safe health, no real execution."""
import asyncio
import subprocess
import sys
import time
from pathlib import Path

from eoplatform.db import DB
from eoplatform.service.lock import FileLock

ROOT = Path(__file__).resolve().parents[1]


def test_file_lock_is_exclusive_and_released(tmp_path):
    a, b = FileLock(tmp_path / "x.lock"), FileLock(tmp_path / "x.lock")
    assert a.acquire() and not b.acquire()
    a.release()
    assert b.acquire()
    b.release()


def test_indexes_exist_on_hot_paths(settings):
    db = DB(settings.db_path)
    names = {r["name"] for r in db.all("SELECT name FROM sqlite_master WHERE type='index'")}
    assert {"ix_models_lookup", "ix_events_ts", "ix_strategy_md", "ix_signals_model"} <= names
    plan = " ".join(r["detail"] for r in db.all(
        "EXPLAIN QUERY PLAN SELECT * FROM models WHERE market='BTCUSD' AND duration=30 AND status='champion'"))
    assert "ix_models_lookup" in plan


def test_backup_is_consistent_and_restore_refuses_while_running(settings, tmp_path):
    db = DB(settings.db_path)
    db.event("info", "t", "before backup")
    out = db.backup(tmp_path / "b.db")
    copy = DB(out)
    assert copy.one("SELECT count(*) n FROM events WHERE message='before backup'")["n"] == 1
    env = {"EO_HOME": str(settings.home), "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}
    lock = FileLock(settings.home / "serve.lock")             # simulate a running `serve`
    assert lock.acquire()
    r = subprocess.run([sys.executable, "-m", "eoplatform", "--env", str(tmp_path / "none.env"), "restore", str(out)],
                       cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "stop `serve` first" in (r.stderr + r.stdout)
    lock.release()
    db.event("info", "t", "after backup")
    db.close()                                               # the platform is stopped before a restore
    copy.close()
    r = subprocess.run([sys.executable, "-m", "eoplatform", "--env", str(tmp_path / "none.env"), "restore", str(out)],
                       cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    restored = DB(settings.db_path)
    assert restored.one("SELECT count(*) n FROM events WHERE message='after backup'")["n"] == 0
    assert list(Path(settings.db_path).parent.glob("*.before-restore-*.db"))      # previous DB kept


def test_daily_backup_rotation(settings):
    from eoplatform.service.core import Core
    core = Core(settings)
    for _ in range(3):
        core.backup_now(keep=2)
        time.sleep(1.1)
    files = sorted((settings.home / "backups").glob("eoplatform-*.db"))
    assert len(files) == 2 and core.db.kv_get("last_backup")["file"] == files[-1].name


def test_second_bot_on_same_machine_is_blocked_by_lock(settings):
    from eoplatform.service.core import Core
    settings.telegram_token = "123456:TEST-token-not-real"
    first = FileLock(settings.home / "telegram_bot.lock")
    assert first.acquire()                                   # another `serve` already runs the bot
    core = Core(settings)

    async def go():
        t = asyncio.create_task(core.svc_telegram())
        await asyncio.sleep(0.3)
        t.cancel()
    asyncio.run(go())
    first.release()
    assert core.telegram is None and core.telegram_blocked
    assert core.health()["telegram"]["blocked_by_lock"] is True
    assert core.db.one("SELECT count(*) n FROM events WHERE level='critical' AND message LIKE '%telegram_bot.lock%'")["n"] == 1


def test_health_works_without_the_unix_resource_module(settings, monkeypatch):
    from eoplatform.service import core as core_mod
    monkeypatch.setattr(core_mod, "resource", None)           # what Windows looks like
    core = core_mod.Core(settings)
    h = core.health()
    assert "max_rss_mb" in h["resources"]                    # None or a psutil value — never a crash
