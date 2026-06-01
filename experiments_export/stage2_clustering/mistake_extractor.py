"""
Extract mistake events from annotated games.

A MistakeEvent is a position where:
 - It was the target user's turn
 - eval_drop >= MISTAKE_THRESHOLD_CP (default 50 centipawns)
 - The player was not already losing badly (eval_before >= -300cp)
 - Optionally, it's not an opening move (move_number > 20)

Each event is enriched with game phase, the classified threat type,
and (after Maia2 annotation) human-move probability fields.
"""
from dataclasses import dataclass, field
from typing import Optional

import chess

from ml.config import MISTAKE_THRESHOLD_CP, EXCLUDE_OPENING_MISTAKES
from ml.ingestion.annotator import PositionAnnotation
from ml.ingestion.threat_classifier import classify_threat  # fallback (rule-only)


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
    played_at_unix:    Optional[int]  = field(default=None)
    cluster_id:        Optional[str]  = field(default=None)   # filled in Stage 2
    # Classification metadata (from HybridThreatClassifier)
    classification_confidence: Optional[float] = field(default=None)
    classification_method:     Optional[str]   = field(default=None)
    eval_drop_category:        Optional[str]   = field(default=None)
    # Maia2 human-move probability fields (populated in pipeline after Stockfish)
    maia2_prob_best:   Optional[float] = field(default=None)
    maia2_prob_played: Optional[float] = field(default=None)
    maia2_surprise:    Optional[float] = field(default=None)
    maia2_difficulty:  Optional[float] = field(default=None)


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
    if move_number <= 20:
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
    exclude_opening:     bool = EXCLUDE_OPENING_MISTAKES,
    classifier=None,     # Optional[HybridThreatClassifier] — uses hybrid when provided
) -> list[MistakeEvent]:
    """
    Filter annotations for the user's moves that crossed the eval-drop threshold.
    Returns a list of enriched MistakeEvent objects.

    Filters applied (in order):
      1. Only the target player's moves
      2. eval_drop >= eval_drop_threshold
      3. eval_before >= -300cp  (skip already-lost positions)
      4. Optionally skip opening moves (move_number <= 20) if exclude_opening=True
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

        phase = _game_phase(ann.fen, ann.move_number)

        if exclude_opening and phase == "opening":
            continue

        # Use HybridThreatClassifier when available (ML + lookahead fallback),
        # otherwise fall back to rule-only classify_threat.
        clf_confidence: Optional[float] = None
        clf_method:     Optional[str]   = None
        clf_category:   Optional[str]   = None

        if classifier is not None:
            result      = classifier.classify(ann.fen, ann.best_move_uci, ann.eval_drop_cp)
            threat_type = result.threat_type
            clf_confidence = result.confidence
            clf_method     = result.method
            clf_category   = result.eval_drop_category
        else:
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
            classification_confidence=clf_confidence,
            classification_method=clf_method,
            eval_drop_category=clf_category,
        ))

    return mistakes
