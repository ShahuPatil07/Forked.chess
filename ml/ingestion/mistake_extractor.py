"""
Extract mistake events from annotated games.

A MistakeEvent is a position where:
 - It was the target user's turn
 - eval_drop >= MISTAKE_THRESHOLD_CP (default 50 centipawns)

Each event is enriched with game phase and the classified threat type.
"""
from dataclasses import dataclass, field
from typing import Optional

import chess

from ml.config import MISTAKE_THRESHOLD_CP
from ml.ingestion.annotator import PositionAnnotation
from ml.ingestion.threat_classifier import classify_threat


@dataclass
class MistakeEvent:
    game_id:           str
    user_id:           str
    fen:               str
    move_played_uci:   str
    move_played_san:   str
    best_move_uci:     str
    eval_before_cp:    int
    eval_after_cp:     int
    eval_drop_cp:      int
    threat_type:       str
    game_phase:        str          # "opening" | "middlegame" | "endgame"
    time_remaining_ms: Optional[int]
    move_number:       int
    played_at_unix:    Optional[int] = field(default=None)   # game timestamp (seconds)
    cluster_id:        Optional[str] = field(default=None)   # filled in Stage 2


# ---------------------------------------------------------------------------
# Game phase detection
# ---------------------------------------------------------------------------

_PHASE_MATERIAL = {
    chess.QUEEN:  9,
    chess.ROOK:   5,
    chess.BISHOP: 3,
    chess.KNIGHT: 3,
}


def _game_phase(fen: str, move_number: int) -> str:
    if move_number <= 12:
        return "opening"

    board = chess.Board(fen)
    total = sum(
        len(board.pieces(pt, chess.WHITE) | board.pieces(pt, chess.BLACK)) * v
        for pt, v in _PHASE_MATERIAL.items()
    )
    # Endgame: combined non-pawn material ≤ 15 (e.g. two rooks + a minor each side)
    return "endgame" if total <= 15 else "middlegame"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_mistakes(
    annotations:         list[PositionAnnotation],
    game_id:             str,
    user_id:             str,
    user_color:          str,                        # "white" or "black"
    eval_drop_threshold: int = MISTAKE_THRESHOLD_CP,
    played_at_unix:      Optional[int] = None,
) -> list[MistakeEvent]:
    """
    Filter annotations for the user's moves that crossed the eval-drop threshold.
    Returns a list of enriched MistakeEvent objects.
    """
    user_is_white = user_color == "white"
    mistakes: list[MistakeEvent] = []

    for ann in annotations:
        # Only look at the target player's moves
        if ann.is_white_move != user_is_white:
            continue

        if ann.eval_drop_cp < eval_drop_threshold:
            continue

        # Skip positions where the player was already losing badly (eval < −300cp).
        # These tend to produce spurious "mistakes" in hopeless positions.
        if ann.eval_before_cp < -300:
            continue

        phase       = _game_phase(ann.fen, ann.move_number)
        threat_type = classify_threat(ann.fen, ann.best_move_uci)

        mistakes.append(MistakeEvent(
            game_id=game_id,
            user_id=user_id,
            fen=ann.fen,
            move_played_uci=ann.move_played_uci,
            move_played_san=ann.move_played_san,
            best_move_uci=ann.best_move_uci,
            eval_before_cp=ann.eval_before_cp,
            eval_after_cp=ann.eval_after_cp,
            eval_drop_cp=ann.eval_drop_cp,
            threat_type=threat_type,
            game_phase=phase,
            time_remaining_ms=ann.clock_remaining_ms,
            move_number=ann.move_number,
            played_at_unix=played_at_unix,
        ))

    return mistakes
