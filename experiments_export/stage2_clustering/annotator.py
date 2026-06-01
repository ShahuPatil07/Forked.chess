"""
Two-pass Stockfish annotation.

Pass 1 — depth 12, fast: evaluate all N+1 board positions in the game once each.
          Each position is shared between consecutive moves, so N+1 engine calls
          cover N moves (50% fewer calls than the naive before+after approach).
          Flag positions where implied eval-drop >= FAST_THRESHOLD_CP.

Pass 2 — depth 18, thorough: re-evaluate only the flagged positions at full depth.
          All other positions keep their fast-pass values.

This yields depth-18 accuracy for mistakes while spending ~10× less engine time
on the majority of moves that aren't mistakes.
"""
import io
import re
from dataclasses import dataclass
from typing import Optional

import chess
import chess.engine
import chess.pgn

from ml.config import (
    ANNOTATION_DEPTH_FAST,
    ANNOTATION_DEPTH_FULL,
    FAST_THRESHOLD_CP,
)


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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def annotate_game(
    pgn_text: str,
    engine: chess.engine.SimpleEngine,
    fast_depth: int = ANNOTATION_DEPTH_FAST,
    full_depth: int = ANNOTATION_DEPTH_FULL,
    fast_threshold: int = FAST_THRESHOLD_CP,
) -> list[PositionAnnotation]:
    """
    Annotate every move in `pgn_text`.
    Returns one PositionAnnotation per move.
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

    # ── Pass 1: fast evaluation of all N+1 positions ──────────────────────
    fast_evals:  list[int] = []
    fast_best:   list[str] = []

    for b in boards:
        info = engine.analyse(b, chess.engine.Limit(depth=fast_depth))
        fast_evals.append(_score_cp(info["score"], b.turn))
        pv = info.get("pv", [])
        fast_best.append(pv[0].uci() if pv else "")

    # Compute which move indices have a significant eval drop
    # eval_drop[i] = fast_evals[i] - (−fast_evals[i+1])
    #              = fast_evals[i] + fast_evals[i+1]
    # (sign flip because perspective changes after the move)
    candidate_positions: set[int] = set()
    for i in range(len(move_meta)):
        drop = fast_evals[i] - (-fast_evals[i + 1])
        if drop >= fast_threshold:
            candidate_positions.add(i)
            candidate_positions.add(i + 1)

    # ── Pass 2: deep re-evaluation of candidate positions only ─────────────
    deep_evals = list(fast_evals)   # default: keep fast values
    deep_best  = list(fast_best)

    for idx in sorted(candidate_positions):
        b = boards[idx]
        info = engine.analyse(b, chess.engine.Limit(depth=full_depth))
        deep_evals[idx] = _score_cp(info["score"], b.turn)
        pv = info.get("pv", [])
        deep_best[idx] = pv[0].uci() if pv else ""

    # ── Build output ───────────────────────────────────────────────────────
    annotations: list[PositionAnnotation] = []
    for i, (move, comment, fullmove_num, is_white) in enumerate(move_meta):
        eval_before = deep_evals[i]
        eval_after  = -deep_evals[i + 1]   # negate for mover's perspective
        eval_drop   = max(0, eval_before - eval_after)

        annotations.append(PositionAnnotation(
            fen=boards[i].fen(),
            move_played_uci=move.uci(),
            move_played_san=boards[i].san(move),
            eval_before_cp=eval_before,
            eval_after_cp=eval_after,
            eval_drop_cp=eval_drop,
            best_move_uci=deep_best[i],
            best_move_eval_cp=eval_before,
            move_number=fullmove_num,
            is_white_move=is_white,
            clock_remaining_ms=_parse_clock_ms(comment),
        ))

    return annotations
