"""Outcome linking: after a warm-up (or a "no warm-up" moment in the comparison), find the
game(s) the player started within the window and review them with the same Stockfish
analysis Game Review uses -> accuracy, blunders, blunders per 40 moves.

Runs in a background thread with its own engine (never holds the interactive engine).
"""
from __future__ import annotations

import asyncio
import logging
import sys
import threading
import time

import chess
import chess.engine

from . import games as G
from . import store
from .config import cfg

log = logging.getLogger("forked.warmup")
_running: set[str] = set()
_guard = threading.Lock()


def candidate_games(moment: dict, recent: list[dict]) -> list[dict]:
    """Games that started after the player went to play, inside the window, same time control first."""
    window = cfg()["outcomes"]["window_minutes"] * 60
    anchor = moment.get("play_at") or moment["created_at"]
    picked = [g for g in recent if anchor - 60 <= g["start_at"] <= anchor + window]
    picked.sort(key=lambda g: (g["time_control"] != moment.get("time_control"), g["start_at"]))
    return picked[: cfg()["outcomes"]["max_games"]]


def analyse(pgn: str, user_color: str, quality: str = "quick") -> dict | None:
    from backend.game_review import parse_game, review_rows, summarize
    from ml.config import STOCKFISH_PATH
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    game = parse_game(pgn)
    with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as engine:
        engine.configure({"Threads": 1, "Hash": 32})
        rows = list(review_rows(game, engine, quality))
    s = summarize(rows).get(user_color) or {}
    moves = s.get("moves") or 0
    counts = s.get("counts") or {}
    blunders = int(counts.get("blunder", 0))
    return {"accuracy": s.get("accuracy"), "blunders": blunders, "mistakes": int(counts.get("mistake", 0)),
            "moves": moves, "blunders_per40": round(blunders / moves * 40, 3) if moves else None}


def link_user(username: str, platform: str, analyser=analyse, recent=None) -> int:
    """Link every unlinked moment of this user whose window has closed. Returns games linked."""
    window = cfg()["outcomes"]["window_minutes"] * 60
    now = time.time()
    moments = store.query("SELECT * FROM moments WHERE username = ? AND linked_at IS NULL AND created_at > ?",
                          (username, now - 3 * 86400))
    due = [m for m in moments if (m.get("play_at") or m["created_at"]) + window < now
           or (m.get("play_at") or m["created_at"]) + 600 < now]
    if not due:
        return 0
    games = recent if recent is not None else G.recent_games(username, platform, n=25, fresh=True)
    linked = 0
    for m in due:
        for g in candidate_games(m, games):
            if store.one("SELECT 1 AS x FROM outcomes WHERE moment_id = ? AND game_id = ?", (m["id"], g["game_id"])):
                continue
            try:
                res = analyser(g["pgn"], g["user_color"], cfg()["outcomes"]["quality"]) if g.get("pgn") else None
            except Exception as exc:  # noqa: BLE001
                log.warning("outcome analysis failed for %s: %s", g.get("game_id"), exc)
                res = None
            if not res:
                continue
            store.write("INSERT OR REPLACE INTO outcomes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (m["id"], g["game_id"], username, platform, g["start_at"], g["time_control"], g.get("url"),
                         g.get("result"), res["accuracy"], res["blunders"], res["mistakes"], res["moves"],
                         res["blunders_per40"], time.time()))
            linked += 1
        # close the moment once its window is over, linked or not (no game = no data, not zero blunders)
        if (m.get("play_at") or m["created_at"]) + window < now:
            store.write("UPDATE moments SET linked_at = ? WHERE id = ?", (time.time(), m["id"]))
    return linked


def link_async(username: str, platform: str) -> bool:
    """Fire-and-forget linking for one user (deduplicated)."""
    key = f"{platform}:{username.lower()}"
    with _guard:
        if key in _running:
            return False
        _running.add(key)

    def run():
        try:
            n = link_user(username, platform)
            if n:
                log.info("warm-up outcomes: linked %d game(s) for %s", n, username)
        except Exception as exc:  # noqa: BLE001
            log.warning("warm-up outcome linking failed for %s: %s", username, exc)
        finally:
            with _guard:
                _running.discard(key)

    threading.Thread(target=run, daemon=True).start()
    return True
