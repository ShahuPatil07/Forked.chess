"""
Two-pass Stockfish annotation (with stored lines and a per-game cache).

Pass 1 — depth 12, fast: evaluate all N+1 board positions in the game once each.
          Each position is shared between consecutive moves, so N+1 engine calls
          cover N moves.
          Flag a move for deep re-analysis when its fast win-probability loss is
          >= 3% (or cp drop >= FAST_THRESHOLD_CP), or when the depth-12 line shows
          a tactic available to the mover (so found/missed opportunities are
          judged at full depth too).

Pass 2 — depth 18, thorough: re-evaluate only the flagged positions at full depth.
          All other positions keep their fast-pass values.

Every position keeps its principal variation (first 12 plies) and mate distance.
For move i that gives both the mover's best line (from position i) AND the
opponent's refutation (the PV of position i+1) at zero extra engine cost — the
refutation is what Stage 1 needs to classify a mistake that ALLOWED a tactic.

Raw engine output is cached per game (annotation_cache.py), so re-running
Stage 1 never re-analyses a game.
"""
import io
import re
from dataclasses import dataclass, field
from typing import Optional

import chess
import chess.engine
import chess.pgn

from ml.config import (
    ANNOTATION_DEPTH_FAST,
    ANNOTATION_DEPTH_FULL,
    FAST_THRESHOLD_CP,
)
from ml.ingestion import annotation_cache
from ml.ingestion.mechanism import opportunity_gain
from ml.ingestion.winprob import expected_score

PV_PLIES = 12
FAST_ES_FLAG = 0.04


@dataclass
class PositionAnnotation:
    fen: str
    move_played_uci: str
    move_played_san: str
    eval_before_cp: int        # from mover's perspective before the move
    eval_after_cp: int         # from mover's perspective after the move
    eval_drop_cp: int          # max(0, eval_before - eval_after)
    best_move_uci: str         # engine's preferred move in the position
    best_move_eval_cp: int     # same as eval_before (what the best move achieves)
    move_number: int           # full-move number (1-based)
    is_white_move: bool
    clock_remaining_ms: Optional[int] = None
    # ── v2 fields ──────────────────────────────────────────────────────────
    ply: int = 0                                   # 0-based half-move index
    fen_after: str = ""
    best_line: list = field(default_factory=list)  # PV from `fen` (mover first)
    reply_line: list = field(default_factory=list) # PV after the move (opponent first)
    mate_before: Optional[int] = None              # mover mates in N from `fen`
    mate_after_opp: Optional[int] = None           # opponent mates in N after the move
    es_before: float = 0.5                         # mover's expected score before
    es_after: float = 0.5                          # ... and after the move
    es_loss: float = 0.0
    think_time_ms: Optional[int] = None
    deep: bool = False                             # both sides analysed at full depth


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_CLK_RE = re.compile(r"\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]")


def _parse_clock_ms(comment: str) -> Optional[int]:
    m = _CLK_RE.search(comment)
    if not m:
        return None
    h, mins, secs = m.group(1), m.group(2), m.group(3)
    total_ms = (int(h) * 3600 + int(mins) * 60 + float(secs)) * 1000
    return int(total_ms)


def _score_cp(score: chess.engine.PovScore, turn: chess.Color) -> int:
    """Return centipawns from `turn`'s perspective. Mate scores → ±30 000."""
    pov = score.pov(turn)
    if pov.is_mate():
        return 30_000 if (pov.mate() or 0) > 0 else -30_000
    return pov.score() or 0


def _record(board: chess.Board, info: dict, depth: int) -> dict:
    pov = info["score"].pov(board.turn)
    mate = pov.mate() if pov.is_mate() else None
    return {
        "cp": _score_cp(info["score"], board.turn),
        "mate": mate,
        "pv": [m.uci() for m in info.get("pv", [])[:PV_PLIES]],
        "d": depth,
    }


def _terminal_record(board: chess.Board) -> dict:
    # Game over: checkmated side to move scores as mated, stalemate/draw as 0.
    if board.is_checkmate():
        return {"cp": -30_000, "mate": 0, "pv": [], "d": 99}
    return {"cp": 0, "mate": None, "pv": [], "d": 99}


def analyse_boards(
    boards: list[chess.Board],
    engine: chess.engine.SimpleEngine,
    fast_depth: int = ANNOTATION_DEPTH_FAST,
    full_depth: int = ANNOTATION_DEPTH_FULL,
    fast_threshold: int = FAST_THRESHOLD_CP,
) -> list[dict]:
    """Two-pass analysis of N+1 consecutive boards -> one record per board."""
    recs: list[dict] = []
    for b in boards:
        if b.is_game_over():
            recs.append(_terminal_record(b))
        else:
            recs.append(_record(b, engine.analyse(b, chess.engine.Limit(depth=fast_depth)), fast_depth))

    candidates: set[int] = set()
    for i in range(len(boards) - 1):
        cp_b, cp_a = recs[i]["cp"], -recs[i + 1]["cp"]
        es_b = expected_score(cp_b)
        if es_b - expected_score(cp_a) >= FAST_ES_FLAG:
            candidates.update((i, i + 1))
            continue
        if es_b >= 0.92 or es_b < 0.08:          # decided: a found tactic changes nothing
            continue
        prev = boards[i - 1] if i > 0 else None
        has_tactic, _ = opportunity_gain(boards[i], recs[i]["pv"],
                                         recs[i]["mate"] if (recs[i]["mate"] or 0) > 0 else None, prev)
        if has_tactic:
            candidates.update((i, i + 1))

    for idx in sorted(candidates):
        b = boards[idx]
        if b.is_game_over() or recs[idx]["d"] >= full_depth:
            continue
        recs[idx] = _record(b, engine.analyse(b, chess.engine.Limit(depth=full_depth)), full_depth)
    return recs


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def annotate_game(
    pgn_text: str,
    engine: chess.engine.SimpleEngine,
    fast_depth: int = ANNOTATION_DEPTH_FAST,
    full_depth: int = ANNOTATION_DEPTH_FULL,
    fast_threshold: int = FAST_THRESHOLD_CP,
    game_id: Optional[str] = None,
    increment_s: float = 0.0,
) -> list[PositionAnnotation]:
    """
    Annotate every move in `pgn_text`.
    Returns one PositionAnnotation per move. With `game_id`, raw engine output
    is read from / written to the annotation cache.
    """
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return []

    # ── Collect board snapshots and move metadata ──────────────────────────
    boards: list[chess.Board] = []       # board state BEFORE each move
    move_meta: list[tuple] = []          # (move, comment, fullmove_num, is_white)

    board = game.board()
    node = game
    while node.variations:
        nxt = node.variation(0)
        boards.append(board.copy())
        move_meta.append((
            nxt.move,
            nxt.comment or "",
            board.fullmove_number,
            board.turn == chess.WHITE,
        ))
        board.push(nxt.move)
        node = nxt

    if not move_meta:
        return []

    boards.append(board.copy())   # final position after the last move  →  N+1 boards

    recs = None
    if game_id:
        cached = annotation_cache.get(game_id)
        if cached and len(cached.get("recs", [])) == len(boards):
            recs = cached["recs"]
    if recs is None:
        recs = analyse_boards(boards, engine, fast_depth, full_depth, fast_threshold)
        if game_id:
            annotation_cache.put(game_id, {"recs": recs})

    # ── Build output ───────────────────────────────────────────────────────
    clocks = [_parse_clock_ms(c) for (_m, c, _n, _w) in move_meta]
    inc_ms = int(increment_s * 1000)
    annotations: list[PositionAnnotation] = []
    for i, (move, comment, fullmove_num, is_white) in enumerate(move_meta):
        eval_before = recs[i]["cp"]
        eval_after  = -recs[i + 1]["cp"]   # negate for mover's perspective
        eval_drop   = max(0, eval_before - eval_after)
        es_b, es_a = expected_score(eval_before), expected_score(eval_after)
        think = None
        if i >= 2 and clocks[i] is not None and clocks[i - 2] is not None:
            think = max(0, clocks[i - 2] - clocks[i] + inc_ms)
        mb = recs[i]["mate"]
        ma = recs[i + 1]["mate"]

        annotations.append(PositionAnnotation(
            fen=boards[i].fen(),
            move_played_uci=move.uci(),
            move_played_san=boards[i].san(move),
            eval_before_cp=eval_before,
            eval_after_cp=eval_after,
            eval_drop_cp=eval_drop,
            best_move_uci=recs[i]["pv"][0] if recs[i]["pv"] else "",
            best_move_eval_cp=eval_before,
            move_number=fullmove_num,
            is_white_move=is_white,
            clock_remaining_ms=clocks[i],
            ply=i,
            fen_after=boards[i + 1].fen(),
            best_line=list(recs[i]["pv"]),
            reply_line=list(recs[i + 1]["pv"]),
            mate_before=mb if (mb or 0) > 0 else None,
            mate_after_opp=ma if (ma or 0) > 0 else None,
            es_before=round(es_b, 4),
            es_after=round(es_a, 4),
            es_loss=round(max(0.0, es_b - es_a), 4),
            think_time_ms=think,
            deep=recs[i]["d"] >= full_depth and recs[i + 1]["d"] >= full_depth,
        ))

    return annotations
