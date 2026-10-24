"""Plain facts about how the player blunders, re-derived on the board from their imported
games -- no blindspot profile, no threat-classifier labels.

From data/output/{user}_mistakes.json we only use the positions, the move played, the
engine's refutation line and the clock flag; each fact is then CHECKED with python-chess:

  hung_piece     after your move the opponent could win material by force (exchange >= 2)
  missed_threat  before your move your opponent already threatened to win material or mate
                 (null-move probe), and your move left it on
  mated_or_checks the refutation was a mate or a run of checks against your king
  missed_win     you had a winning shot and didn't play it (missed-opportunity records)
  time_trouble   the blunder came with little time on the clock

Each fact only nudges how often a drill appears; with no imported games the session falls
back to the rating-band defaults.
"""
from __future__ import annotations

import json
from pathlib import Path

import chess

from .chesskit import see, threats
from .config import cfg
from .positions import OUTPUT_DIR

DRILLS_FOR = {
    "hung_piece": ["loose_pieces", "threat_count"],
    "missed_threat": ["opponent_threat", "what_changed"],
    "mated_or_checks": ["check_flash", "double_check_hunt", "opponent_threat"],
    "missed_win": ["easy_sprint"],
}
LABEL = {
    "hung_piece": "left a piece where it could be won",
    "missed_threat": "missed what the opponent was already threatening",
    "mated_or_checks": "walked into mating attacks or check sequences",
    "missed_win": "missed a winning shot",
    "time_trouble": "blundered with little time left",
}

_cache: dict[str, tuple[float, dict]] = {}


def _load(path: Path) -> list[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    except Exception:
        return []


def _hung(fen: str, played: str) -> bool:
    b = chess.Board(fen)
    try:
        mv = chess.Move.from_uci(played)
    except ValueError:
        return False
    if mv not in b.legal_moves:
        return False
    b.push(mv)
    me = not b.turn
    return any(b.is_capture(m) and b.color_at(m.to_square) == me and see(b, m) >= 2 for m in b.legal_moves)


def _missed_threat(fen: str, played: str) -> bool:
    b = chess.Board(fen)
    t = threats(b)
    if t["kind"] not in ("capture", "mate"):
        return False
    try:
        mv = chess.Move.from_uci(played)
    except ValueError:
        return False
    if mv not in b.legal_moves:
        return False
    b.push(mv)
    # is the same threat still on after your move? (opponent now to move: probe directly)
    if t["kind"] == "mate":
        for m in b.legal_moves:
            b.push(m)
            mate = b.is_checkmate()
            b.pop()
            if mate:
                return True
        return False
    targets = set(t["squares"])
    return any(b.is_capture(m) and m.to_square in targets and see(b, m) >= 2 for m in b.legal_moves)


def _mated_or_checks(fen: str, played: str, line: list[str]) -> bool:
    b = chess.Board(fen)
    try:
        b.push(chess.Move.from_uci(played))
    except (ValueError, AssertionError):
        return False
    checks = 0
    for i, u in enumerate(line[:6]):
        try:
            mv = chess.Move.from_uci(u)
        except ValueError:
            break
        if mv not in b.legal_moves:
            break
        b.push(mv)
        if b.is_checkmate():
            return True
        if i % 2 == 0 and b.is_check():
            checks += 1
    return checks >= 2


def facts(username: str) -> dict:
    """{"games", "blunders", "counts": {fact: n}, "share": {fact: 0-1}, "focus": [...]}"""
    mpath = OUTPUT_DIR / f"{username}_mistakes.json"
    opath = OUTPUT_DIR / f"{username}_opportunities.json"
    if not username or not mpath.exists():
        return {"games": 0, "blunders": 0, "counts": {}, "share": {}, "focus": []}
    key = mpath.stat().st_mtime + (opath.stat().st_mtime if opath.exists() else 0)
    hit = _cache.get(username)
    if hit and hit[0] == key:
        return hit[1]
    mistakes = [m for m in _load(mpath) if m.get("side") == "user" and (m.get("es_loss") or 0) >= .1
                and m.get("fen") and m.get("move_played_uci")]
    counts = {k: 0 for k in LABEL}
    for m in mistakes:
        fen, played = m["fen"], m["move_played_uci"]
        try:
            if _hung(fen, played):
                counts["hung_piece"] += 1
            if _missed_threat(fen, played):
                counts["missed_threat"] += 1
            if _mated_or_checks(fen, played, m.get("reply_line") or []):
                counts["mated_or_checks"] += 1
        except Exception:  # noqa: BLE001 -- a malformed record must not break the page
            continue
        if m.get("time_trouble"):
            counts["time_trouble"] += 1
    counts["missed_win"] = sum(1 for o in _load(opath) if o.get("side") == "user" and not o.get("found"))
    games = len({m.get("game_id") for m in mistakes})
    n = max(1, len(mistakes))
    share = {k: round(v / n, 3) for k, v in counts.items() if k != "missed_win"}
    ranked = sorted((k for k in DRILLS_FOR if k != "missed_win"), key=lambda k: -counts[k])
    focus = [{"fact": k, "label": LABEL[k], "count": counts[k], "drills": DRILLS_FOR[k]}
             for k in ranked if counts[k] >= 3][:2]
    out = {"games": games, "blunders": len(mistakes), "counts": counts, "share": share, "focus": focus}
    _cache[username] = (key, out)
    return out


def drill_weights(f: dict) -> dict[str, float]:
    """Multiplicative nudges (>= 1) for drills matching the player's top facts."""
    boost = cfg()["session"]["own_game_boost"]
    w: dict[str, float] = {}
    for item in f.get("focus", []):
        for d in item["drills"]:
            w[d] = max(w.get(d, 1.0), boost)
    return w
