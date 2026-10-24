"""Warm-Up persistence: SQLite at data/warmup.db (created on first use).

  moments   every "I'm about to play" -- the unit of the experiment: arm (warmup /
            control), whether the user consented, when they went to play
  sessions  a warm-up that was run (plan + summary), linked to its moment
  events    one row per drill item: drill, item, band, time control, correct, response ms,
            difficulty -- everything Forked needs to learn what helps
  outcomes  the next game(s) after a moment, engine-reviewed (accuracy, blunders / 40 moves)
  routines  each user's saved pre-game routine
  consents  opt-in to the randomized comparison
Usernames stand in for user ids until auth exists.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid

from .config import STORE_DB

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS moments (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, platform TEXT, created_at REAL NOT NULL,
    time_control TEXT, band TEXT, rating INTEGER, arm TEXT NOT NULL, in_experiment INTEGER NOT NULL DEFAULT 0,
    session_id TEXT, play_at REAL, linked_at REAL);
CREATE INDEX IF NOT EXISTS ix_moments_user ON moments(username, created_at);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, moment_id TEXT, started_at REAL NOT NULL, ended_at REAL,
    band TEXT, rating INTEGER, rating_source TEXT, time_control TEXT, minutes INTEGER, plan TEXT, summary TEXT);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(username, started_at);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, username TEXT NOT NULL, drill_id TEXT NOT NULL,
    item_id TEXT, band TEXT, time_control TEXT, correct INTEGER, score REAL, response_ms INTEGER,
    difficulty INTEGER, ts REAL NOT NULL, extra TEXT);
CREATE INDEX IF NOT EXISTS ix_events_user ON events(username, drill_id, ts);
CREATE INDEX IF NOT EXISTS ix_events_session ON events(session_id);
CREATE TABLE IF NOT EXISTS outcomes (
    moment_id TEXT NOT NULL, game_id TEXT NOT NULL, username TEXT NOT NULL, platform TEXT, played_at REAL,
    time_class TEXT, url TEXT, result REAL, accuracy REAL, blunders INTEGER, mistakes INTEGER, moves INTEGER,
    blunders_per40 REAL, analysed_at REAL, PRIMARY KEY (moment_id, game_id));
CREATE TABLE IF NOT EXISTS routines (username TEXT PRIMARY KEY, steps TEXT NOT NULL, updated_at REAL);
CREATE TABLE IF NOT EXISTS consents (username TEXT PRIMARY KEY, granted INTEGER NOT NULL, updated_at REAL);
"""


def connect(path=None) -> sqlite3.Connection:
    con = sqlite3.connect(path or STORE_DB, timeout=10)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def now() -> float:
    return time.time()


def write(sql: str, args: tuple | dict = (), path=None) -> None:
    with _lock:
        con = connect(path)
        try:
            con.execute(sql, args)
            con.commit()
        finally:
            con.close()


def write_many(sql: str, rows: list, path=None) -> None:
    if not rows:
        return
    with _lock:
        con = connect(path)
        try:
            con.executemany(sql, rows)
            con.commit()
        finally:
            con.close()


def query(sql: str, args: tuple | dict = (), path=None) -> list[dict]:
    con = connect(path)
    try:
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


def one(sql: str, args: tuple | dict = (), path=None) -> dict | None:
    rows = query(sql, args, path)
    return rows[0] if rows else None


def dumps(o) -> str:
    return json.dumps(o, separators=(",", ":"))
