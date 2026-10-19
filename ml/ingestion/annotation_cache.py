"""
SQLite cache of per-game Stockfish annotations (data/annotation_cache.db).

Stockfish is ~95% of Stage-1 time. Caching the raw per-position engine output
(eval, mate, PV, depth) per game means re-runs, reclassification, threshold
changes and evaluations never re-analyse a game. Keyed by game id + an
ANNOTATION_VERSION that encodes the depths/engine settings, so changing those
invalidates old rows automatically. Auto-creates on import, like the other caches.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import zlib
from typing import Optional

from ml.config import DATA_DIR, ANNOTATION_DEPTH_FAST, ANNOTATION_DEPTH_FULL

DB_PATH = DATA_DIR / "annotation_cache.db"
ANNOTATION_VERSION = f"v2-d{ANNOTATION_DEPTH_FAST}-{ANNOTATION_DEPTH_FULL}-pv"
_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    c.execute("CREATE TABLE IF NOT EXISTS annotations (key TEXT PRIMARY KEY, data BLOB, created INTEGER)")
    return c


def _init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        c = _conn(); c.commit(); c.close()


def _key(game_id: str, extra: str = "") -> str:
    return f"{ANNOTATION_VERSION}:{extra}:{game_id}"


def get(game_id: str, extra: str = "") -> Optional[dict]:
    if not game_id:
        return None
    with _lock:
        c = _conn()
        row = c.execute("SELECT data FROM annotations WHERE key=?", (_key(game_id, extra),)).fetchone()
        c.close()
    if not row:
        return None
    try:
        return json.loads(zlib.decompress(row[0]).decode("utf-8"))
    except Exception:
        return None


def put(game_id: str, data: dict, extra: str = "") -> None:
    if not game_id:
        return
    blob = zlib.compress(json.dumps(data, separators=(",", ":")).encode("utf-8"), 6)
    with _lock:
        c = _conn()
        c.execute("INSERT OR REPLACE INTO annotations VALUES (?,?,?)",
                  (_key(game_id, extra), blob, int(time.time())))
        c.commit(); c.close()


_init_db()
