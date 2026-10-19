"""
The pre-v2 Stage-1 logic, reproduced exactly for before/after evaluation.

Runs on the SAME cached Stockfish annotations as the v2 pipeline, so any
difference comes from the logic, not the engine:
  - mistake = cp drop >= 100 and eval_before >= -300 (no win-probability)
  - phase   = opening if move <= 20, endgame if non-pawn material <= 15
  - label   = v1 transformer on (position BEFORE the move, engine best move),
              OOD/positional -> "other"
  - Maia2   = drop the event if P(best move) < 0.04 at a fixed 1500 rating
  - no cascades, no opponents, no opportunities
"""
from __future__ import annotations

from typing import Optional

import chess

from ml.clustering.families import family_of
from ml.ingestion.mistake_extractor import MistakeEvent

_PHASE_MATERIAL = {chess.QUEEN: 9, chess.ROOK: 5, chess.BISHOP: 3, chess.KNIGHT: 3}


def legacy_phase(fen: str, move_number: int) -> str:
    if move_number <= 20:
        return "opening"
    board = chess.Board(fen)
    total = sum(len(board.pieces(pt, chess.WHITE) | board.pieces(pt, chess.BLACK)) * v
                for pt, v in _PHASE_MATERIAL.items())
    return "endgame" if total <= 15 else "middlegame"


def legacy_extract(annotations, game: dict, user_color: str,
                   played_at_unix: Optional[int] = None) -> list[MistakeEvent]:
    user_white = user_color == "white"
    out = []
    for ann in annotations:
        if ann.is_white_move != user_white:
            continue
        if ann.eval_drop_cp < 100 or ann.eval_before_cp < -300:
            continue
        out.append(MistakeEvent(
            game_id=game.get("game_id", ""), user_id="", fen=ann.fen,
            move_played_uci=ann.move_played_uci, move_played_san=ann.move_played_san,
            best_move_uci=ann.best_move_uci, eval_before_cp=ann.eval_before_cp,
            eval_after_cp=ann.eval_after_cp, eval_drop_cp=ann.eval_drop_cp,
            threat_type="other", game_phase=legacy_phase(ann.fen, ann.move_number),
            time_remaining_ms=ann.clock_remaining_ms, move_number=ann.move_number,
            played_at_unix=played_at_unix, ply=ann.ply, es_loss=ann.es_loss,
            es_before=ann.es_before, es_after=ann.es_after, fen_after=ann.fen_after,
            refutation_uci=ann.reply_line[0] if ann.reply_line else "",
            best_line=list(ann.best_line), reply_line=list(ann.reply_line),
            event_id=f"{game.get('game_id','')}:{ann.ply}",
        ))
    return out


def legacy_classify(events: list[MistakeEvent], v1_predictor) -> None:
    if not events:
        return
    out = v1_predictor.predict_many([e.fen for e in events], [e.best_move_uci for e in events])
    j = 0
    for k, e in enumerate(events):
        if not out["keep"][k]:
            e.threat_type = "other"
        else:
            e.threat_type = "other" if bool(out["is_positional"][j]) else out["threat_type"][j]
            e.classification_confidence = float(out["confidence"][j])
            j += 1
        e.cluster_id = family_of(e.threat_type)
        e.family_probs = {e.cluster_id: 1.0}
        e.incident_id = e.event_id
        e.classification_method = "legacy_v1:before_best"


def legacy_maia_filter(events: list[MistakeEvent], maia, min_prob_best: float = 0.04) -> list[MistakeEvent]:
    if maia is None:
        return events
    kept = []
    for e in events:
        try:
            probs = maia.move_probs(e.fen, 1500, 1500)
            pb = float(probs.get(e.best_move_uci, 1e-6))
        except Exception:
            pb = None
        e.maia2_prob_best = pb
        if pb is None or pb >= min_prob_best:
            kept.append(e)
    return kept
