"""Where real positions for the board drills come from.

  - the Puzzle Themes index (data/puzzles/themes.db): 313K positions from real Lichess
    games, rating-tagged;
  - the player's OWN imported games (data/output/{user}_mistakes.json): positions they
    actually reached. Only the positions and the moves are used -- never the
    classifier's motif labels -- so drill quality doesn't depend on the classifier.
"""
from __future__ import annotations

import json
import random
import sqlite3
from functools import lru_cache
from pathlib import Path

import chess

from ml.config import DATA_DIR

THEMES_DB = DATA_DIR / "puzzles" / "themes.db"
OUTPUT_DIR = DATA_DIR / "output"


def _db() -> sqlite3.Connection | None:
    if not THEMES_DB.exists():
        return None
    con = sqlite3.connect(f"file:{THEMES_DB.as_posix()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


@lru_cache(maxsize=1)
def _rowid_range() -> tuple[int, int]:
    con = _db()
    if con is None:
        return (0, 0)
    try:
        lo, hi = con.execute("SELECT min(rowid), max(rowid) FROM puzzles").fetchone()
        return int(lo or 0), int(hi or 0)
    finally:
        con.close()


def game_positions(rng: random.Random, n: int) -> list[dict]:
    """Random real-game positions (after the puzzle's trigger move, so whoever is to move
    has just been moved against), with the move that led there."""
    lo, hi = _rowid_range()
    con = _db()
    if con is None or hi <= lo:
        return []
    out = []
    try:
        while len(out) < n:
            start = rng.randint(lo, max(lo, hi - 400))
            rows = con.execute("SELECT id, fen, moves, rating FROM puzzles WHERE rowid >= ? LIMIT 60", (start,)).fetchall()
            rng.shuffle(rows)
            for r in rows[: max(4, n // 6)]:
                b = chess.Board(r["fen"])
                trig = chess.Move.from_uci(r["moves"].split()[0])
                if trig not in b.legal_moves:
                    continue
                before = b.fen()
                b.push(trig)
                if b.is_game_over():
                    continue
                out.append({"fen": b.fen(), "before": before, "last": trig.uci(), "src": f"lichess:{r['id']}",
                            "rating": int(r["rating"])})
    finally:
        con.close()
    return out[:n]


_own_cache: dict[str, tuple[float, list[dict]]] = {}


def own_positions(username: str) -> list[dict]:
    """Positions from the player's own imported games (user to move). Cached by file mtime."""
    path = OUTPUT_DIR / f"{username}_mistakes.json"
    if not username or not path.exists():
        return []
    mtime = path.stat().st_mtime
    hit = _own_cache.get(username)
    if hit and hit[0] == mtime:
        return list(hit[1])
    out = _parse_own(path)
    _own_cache[username] = (mtime, out)
    return list(out)


def _parse_own(path: Path) -> list[dict]:
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    out, seen = [], set()
    for r in records:
        if r.get("side") != "user" or not r.get("fen"):
            continue
        try:
            b = chess.Board(r["fen"])
        except ValueError:
            continue
        if b.is_game_over() or b.board_fen() in seen:
            continue
        seen.add(b.board_fen())
        item = {"fen": b.fen(), "src": f"own:{r.get('event_id') or r.get('game_id')}",
                "move_number": r.get("move_number"), "record": r}
        if r.get("prev_fen") and r.get("prev_move_uci"):
            try:
                pb = chess.Board(r["prev_fen"])
                pm = chess.Move.from_uci(r["prev_move_uci"])
                if pm in pb.legal_moves:
                    pb.push(pm)
                    if pb.board_fen() == b.board_fen():
                        item["before"], item["last"] = r["prev_fen"], r["prev_move_uci"]
            except ValueError:
                pass
        out.append(item)
    return out


def sample(rng: random.Random, n: int, username: str = "", own_share: float = .4,
           pieces: tuple[int, int] | None = None, pool: int = 6) -> list[dict]:
    """Up to n positions, roughly own_share of them from the player's own games,
    filtered by piece count. Over-samples then filters (cheap: no engine)."""
    own = own_positions(username)
    rng.shuffle(own)
    want_own = int(round(n * own_share)) if own else 0
    picked: list[dict] = []
    for p in own:
        if len(picked) >= want_own:
            break
        if pieces is None or pieces[0] <= len(chess.Board(p["fen"]).piece_map()) <= pieces[1]:
            picked.append(p)
    tries = 0
    while len(picked) < n and tries < 8:
        tries += 1
        for p in game_positions(rng, (n - len(picked)) * pool):
            if pieces is None or pieces[0] <= len(chess.Board(p["fen"]).piece_map()) <= pieces[1]:
                picked.append(p)
                if len(picked) >= n:
                    break
    rng.shuffle(picked)
    return picked[:n]


def has_own_games(username: str) -> bool:
    return bool(own_positions(username))


def own_path(username: str) -> Path:
    return OUTPUT_DIR / f"{username}_mistakes.json"
