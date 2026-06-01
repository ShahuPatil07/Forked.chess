"""
Feature 1 — Live game sync with blindspot alerts.

A per-user background loop polls for new games, runs Stage 1 on each, and
checks every new mistake against the user's existing blindspot cluster
centroids (cosine > 0.72). A confident repeat creates a BlindspotAlert,
resets that cluster's mastery, and re-queues it for drilling.

Cluster identity = cluster_id + centroid only. Labels are never used here.

State files (data/output/):
  {username}_alerts.json   — list of alert dicts (newest last)
  {username}_sync.json     — { last_synced_at, last_active, processed_game_ids, is_syncing }
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import sys
import threading
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from ml.config import DATA_DIR, STOCKFISH_PATH, MISTAKE_THRESHOLD_CP
from ml.matching import load_match_context, match_events

log = logging.getLogger("forked.live_sync")

OUTPUT_DIR = DATA_DIR / "output"

SYNC_INTERVAL_SEC   = 15 * 60      # min seconds between auto-syncs per user
ACTIVE_WINDOW_SEC   = 7 * 24 * 3600
SCHEDULER_TICK_SEC  = 60
FETCH_GAMES         = 15           # how many recent games to pull per sync
MAX_NEW_PER_SYNC    = 5            # cap annotation work per sync
RESET_MASTERY       = 0.20         # mastery a cluster drops to on a confirmed repeat

_user_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


# ── Paths ─────────────────────────────────────────────────────────────────────

def _alerts_path(u: str) -> Path:    return OUTPUT_DIR / f"{u}_alerts.json"
def _sync_path(u: str)  -> Path:     return OUTPUT_DIR / f"{u}_sync.json"
def _mistakes_path(u: str) -> Path:  return OUTPUT_DIR / f"{u}_mistakes.json"
def _clusters_path(u: str) -> Path:  return OUTPUT_DIR / f"{u}_clusters.json"
def _settings_path(u: str) -> Path:  return OUTPUT_DIR / f"{u}_settings.json"
def _game_meta_path(u: str) -> Path: return OUTPUT_DIR / f"{u}_game_meta.json"


def _user_lock(u: str) -> threading.Lock:
    with _locks_guard:
        if u not in _user_locks:
            _user_locks[u] = threading.Lock()
        return _user_locks[u]


# ── JSON helpers ──────────────────────────────────────────────────────────────

def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _write_json(path: Path, data) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, default=str)
    tmp.replace(path)


def _now_iso() -> str:
    return dt.datetime.utcnow().isoformat()


# ── Sync state ────────────────────────────────────────────────────────────────

def read_sync_state(username: str) -> dict:
    return _read_json(_sync_path(username), {
        "last_synced_at": None, "last_active": None,
        "processed_game_ids": [], "is_syncing": False,
    })


def write_sync_state(username: str, state: dict) -> None:
    _write_json(_sync_path(username), state)


def mark_active(username: str) -> None:
    """Record that the user is active now (called on login / dashboard load)."""
    state = read_sync_state(username)
    state["last_active"] = _now_iso()
    write_sync_state(username, state)


# ── Alerts ────────────────────────────────────────────────────────────────────

def read_alerts(username: str) -> list[dict]:
    return _read_json(_alerts_path(username), [])


def unseen_alerts(username: str) -> list[dict]:
    alerts = [a for a in read_alerts(username) if not a.get("seen")]
    alerts.sort(key=lambda a: a.get("timestamp", ""), reverse=True)
    return alerts


def mark_alerts_seen(username: str, alert_ids: list[str]) -> int:
    alerts = read_alerts(username)
    ids = set(alert_ids)
    n = 0
    for a in alerts:
        if a.get("id") in ids and not a.get("seen"):
            a["seen"] = True
            n += 1
    if n:
        _write_json(_alerts_path(username), alerts)
    return n


# ── Mastery reset + drill re-queue ────────────────────────────────────────────

def reset_cluster_mastery(username: str, cluster_id) -> Optional[tuple[float, float]]:
    """
    Drop the matched cluster's mastery to RESET_MASTERY and mark it due now so
    the session builder prioritises it. Returns (before, after) or None.
    """
    clusters = _read_json(_clusters_path(username), [])
    changed = None
    now = int(time.time())
    for c in clusters:
        if str(c.get("cluster_id")) == str(cluster_id):
            before = float(c.get("mastery", 0.0) or 0.0)
            after  = min(before, RESET_MASTERY)
            c["mastery"] = after
            c["next_review_unix"] = now
            changed = (before, after)
            break
    if changed is not None:
        _write_json(_clusters_path(username), clusters)
    return changed


# ── Stage 1 on freshly fetched games (reuses ml.pipeline helpers) ─────────────

def _process_new_games(username: str, platform: str, existing_game_ids: set):
    """
    Fetch recent games, keep only unseen ones, annotate + extract mistakes.
    Returns (events, games_by_id). Reuses the real pipeline helpers so the
    Stage 1 logic stays identical to a full analysis run.
    """
    import chess.engine
    from ml.pipeline import _fetch_and_parse, _annotate_batch

    if not STOCKFISH_PATH.exists():
        log.warning("Sync %s: Stockfish not found at %s — cannot annotate", username, STOCKFISH_PATH)
        return [], {}

    games = _fetch_and_parse(username, platform, FETCH_GAMES)
    new_games = [g for g in games if g.get("game_id") not in existing_game_ids][:MAX_NEW_PER_SYNC]
    if not new_games:
        return [], {}

    with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as engine:
        engine.configure({"Threads": 1, "Hash": 128})
        events = _annotate_batch(
            new_games, engine,
            exclude_opening=False,
            progress_callback=lambda *_: None,   # silence tqdm in the sync thread
            classifier=None,                      # rule-based threat labels (matcher-tolerant)
        )

    # Persist game meta so the History view can show opponents
    meta = _read_json(_game_meta_path(username), {})
    for g in new_games:
        gid = g.get("game_id", "")
        if not gid:
            continue
        white = g.get("white_username", ""); black = g.get("black_username", "")
        uc = g.get("user_color", "white")
        meta[gid] = {
            "white": white, "black": black, "user_color": uc,
            "opponent": black if uc == "white" else white,
            "url": g.get("url", ""), "time_control": g.get("time_control", ""),
        }
    _write_json(_game_meta_path(username), meta)

    return events, {g["game_id"]: g for g in new_games}


def _opponent_for(game: dict) -> str:
    uc = game.get("user_color", "white")
    return game.get("black_username", "") if uc == "white" else game.get("white_username", "")


# ── Core sync ─────────────────────────────────────────────────────────────────

def sync_user(username: str, platform: str = "lichess") -> list[dict]:
    """
    Run one sync pass. Returns the list of NEW alerts created (may be empty).
    Safe to call directly (manual trigger) or from the scheduler.
    """
    lock = _user_lock(username)
    if not lock.acquire(blocking=False):
        return []   # a sync is already running for this user

    # Windows: chess.engine needs the Proactor loop in this thread
    if sys.platform == "win32":
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
            asyncio.set_event_loop(asyncio.new_event_loop())
        except Exception:
            pass

    state = read_sync_state(username)
    state["is_syncing"] = True
    write_sync_state(username, state)

    new_alerts: list[dict] = []
    try:
        ctx = load_match_context(username, OUTPUT_DIR)
        if ctx is None:
            log.info("Sync %s: no clusters/profile yet — skipping", username)
            return []

        existing = _read_json(_mistakes_path(username), [])
        existing_game_ids = {m.get("game_id") for m in existing}

        events, game_map = _process_new_games(username, platform, existing_game_ids)
        if not events:
            log.info("Sync %s: no new mistakes", username)
            return []

        results = match_events(events, ctx)

        appended: list[dict] = []
        for ev, res in zip(events, results):
            ev_dict = asdict(ev)
            ev_dict["cluster_id"] = res.cluster_id if res.matched else None
            appended.append(ev_dict)

            if not res.matched:
                continue   # genuine non-match — logged to history, no alert

            game = game_map.get(ev.game_id, {})
            reset = reset_cluster_mastery(username, res.cluster_id)
            new_alerts.append({
                "id":             str(uuid.uuid4()),
                "game_id":        ev.game_id,
                "opponent":       _opponent_for(game),
                "move_number":    ev.move_number,
                "cluster_id":     res.cluster_id,
                "cluster_rank":   res.cluster_rank,
                "similarity":     round(res.similarity, 4),
                "eval_drop":      ev.eval_drop_cp,
                "fen":            ev.fen,
                "best_move":      ev.best_move_uci,
                "played_move":    ev.move_played_uci,
                "mastery_before": reset[0] if reset else None,
                "mastery_after":  reset[1] if reset else None,
                "timestamp":      _now_iso(),
                "seen":           False,
            })

        if appended:
            existing.extend(appended)
            _write_json(_mistakes_path(username), existing)
        if new_alerts:
            alerts = read_alerts(username)
            alerts.extend(new_alerts)
            _write_json(_alerts_path(username), alerts)

        log.info("Sync %s: %d new mistakes, %d alerts", username, len(events), len(new_alerts))
        return new_alerts

    except Exception as exc:
        log.error("Sync %s failed: %s", username, exc, exc_info=True)
        return []
    finally:
        state = read_sync_state(username)
        state["is_syncing"]     = False
        state["last_synced_at"] = _now_iso()
        write_sync_state(username, state)
        lock.release()


def trigger_sync_async(username: str, platform: str = "lichess") -> None:
    """Fire-and-forget sync in a daemon thread."""
    mark_active(username)
    threading.Thread(target=sync_user, args=(username, platform), daemon=True).start()


# ── Background scheduler ──────────────────────────────────────────────────────

_scheduler_started = False


def _platform_for(username: str) -> str:
    return _read_json(_settings_path(username), {}).get("platform", "lichess")


def _scheduler_loop() -> None:
    if sys.platform == "win32":
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        except Exception:
            pass
    log.info("Live-sync scheduler started (tick %ds, interval %ds)",
             SCHEDULER_TICK_SEC, SYNC_INTERVAL_SEC)
    while True:
        try:
            now = dt.datetime.utcnow()
            for sync_file in OUTPUT_DIR.glob("*_sync.json"):
                username = sync_file.name[:-len("_sync.json")]
                state = read_sync_state(username)
                last_active = state.get("last_active")
                if not last_active:
                    continue
                try:
                    active_dt = dt.datetime.fromisoformat(last_active)
                except Exception:
                    continue
                if (now - active_dt).total_seconds() > ACTIVE_WINDOW_SEC:
                    continue
                if state.get("is_syncing"):
                    continue
                last_sync = state.get("last_synced_at")
                if last_sync:
                    try:
                        if (now - dt.datetime.fromisoformat(last_sync)).total_seconds() < SYNC_INTERVAL_SEC:
                            continue
                    except Exception:
                        pass
                sync_user(username, _platform_for(username))
        except Exception as exc:
            log.warning("Scheduler tick error: %s", exc)
        time.sleep(SCHEDULER_TICK_SEC)


def start_scheduler() -> None:
    global _scheduler_started
    if _scheduler_started:
        return
    _scheduler_started = True
    threading.Thread(target=_scheduler_loop, daemon=True).start()
