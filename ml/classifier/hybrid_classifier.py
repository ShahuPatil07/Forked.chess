"""
HybridThreatClassifier — 4-stage threat classification funnel.

Stage 0  eval_drop guard
         < 50cp  -> "skip" (not a real mistake)
         50-99cp -> "inaccuracy" category, still classify
         >= 100cp -> "blunder", classify with full pipeline

Stage 1  Rule-based (deterministic, fast)
         Non-"other" result AND pv_length < 3  -> done (confidence 1.0)
         If pv_length >= 3 (forcing line) -> always proceed to Stage 2

Stage 2  Depth lookahead (requires Stockfish engine)
         Play out PV up to 4 half-moves, classify terminal position.
         Non-"other" -> done (confidence 0.85)

Stage 3  LightGBM ML model (fallback)
         Apply per-class confidence thresholds.
         Above threshold -> done (confidence = model probability)

Stage 4  Uncertain -- log for future fine-tuning, return "other"

Usage (with model, no engine):
    clf = HybridThreatClassifier(model_path="models/threat_lgbm.pkl")
    result = clf.classify(fen, best_uci, eval_drop_cp=150)

Usage (full pipeline with engine):
    clf = HybridThreatClassifier(
        model_path="models/threat_lgbm.pkl",
        engine_path="data/stockfish/stockfish.exe",
    )
    result = clf.classify(fen, best_uci, eval_drop_cp=150, pv_length=4)

Expected healthy method distribution:
    rule_based ~65%  |  depth_lookahead ~15%  |  ml_model ~12%
    ml_uncertain < 5%  |  skip (low eval_drop) = not counted
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import chess
import chess.engine

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Per-class confidence thresholds for Stage 3 (ML model)
# ---------------------------------------------------------------------------
_CLASS_THRESHOLDS: dict[str, float] = {
    "removing_defender": 0.75,
    "deflection":        0.65,
    "trapped_piece":     0.65,
    "skewer":            0.60,
}
_DEFAULT_THRESHOLD = 0.55


def _threshold_for(threat_type: str) -> float:
    return _CLASS_THRESHOLDS.get(threat_type, _DEFAULT_THRESHOLD)


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------

@dataclass
class ClassificationResult:
    threat_type:        str
    confidence:         float
    method:             str    # "rule_based"|"depth_lookahead"|"ml_model"|"ml_uncertain"|"skip"
    eval_drop_category: str    # "skip"|"inaccuracy"|"blunder"


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------

class HybridThreatClassifier:

    def __init__(
        self,
        model_path:  Optional[str | Path] = None,
        engine_path: Optional[str | Path] = None,
    ):
        from ml.ingestion.threat_classifier import classify_threat, THREAT_TYPES
        self._classify_rule = classify_threat
        self._threat_types  = THREAT_TYPES

        self._model   = None
        self._encoder = None
        self._engine  = None

        if model_path and Path(model_path).exists():
            import joblib
            self._model = joblib.load(model_path)
            log.info("Loaded threat model from %s", model_path)
            enc_path = Path(model_path).parent / "label_encoder.pkl"
            if enc_path.exists():
                self._encoder = joblib.load(enc_path)

        if engine_path and Path(engine_path).exists():
            try:
                self._engine = chess.engine.SimpleEngine.popen_uci(str(engine_path))
                log.info("Opened Stockfish for depth lookahead: %s", engine_path)
            except Exception as exc:
                log.warning("Could not open engine at %s: %s", engine_path, exc)

        self._counter_lock = threading.Lock()
        self._method_counts: dict[str, int] = {
            "rule_based": 0, "depth_lookahead": 0,
            "ml_model": 0, "ml_uncertain": 0, "skip": 0,
        }
        self._uncertain_log: list[dict] = []

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def classify(
        self,
        fen:           str,
        best_move_uci: str,
        eval_drop_cp:  int = 100,
        pv_length:     int = 0,
    ) -> ClassificationResult:
        """
        Full 4-stage classification.
        eval_drop_cp: centipawn drop (positive magnitude).
        pv_length: number of moves in the engine PV (0 = unknown).
        """
        # Stage 0
        if eval_drop_cp < 50:
            return self._record(ClassificationResult(
                "other", 1.0, "skip", "skip",
            ))
        eval_drop_cat = "inaccuracy" if eval_drop_cp < 100 else "blunder"

        # Stage 1: rule-based
        rule_result = self._classify_rule(fen, best_move_uci)
        if rule_result != "other" and pv_length < 3:
            return self._record(ClassificationResult(
                rule_result, 1.0, "rule_based", eval_drop_cat,
            ))

        # Stage 2: depth lookahead
        if self._engine is not None:
            try:
                board = chess.Board(fen)
                info  = self._engine.analyse(board, chess.engine.Limit(depth=16))
                pv    = info.get("pv", [])
                if len(pv) >= 2:
                    result = self._classify_via_lookahead(board, pv)
                    if result != "other":
                        return self._record(ClassificationResult(
                            result, 0.85, "depth_lookahead", eval_drop_cat,
                        ))
            except Exception as exc:
                log.debug("Stage 2 lookahead failed: %s", exc)

        # If rule gave a non-other but line was forcing (pv>=3) use it now
        if rule_result != "other":
            return self._record(ClassificationResult(
                rule_result, 0.90, "rule_based", eval_drop_cat,
            ))

        # Stage 3: LightGBM
        if self._model is not None:
            try:
                threat_type, confidence = self._classify_via_model(fen, best_move_uci)
                threshold = _threshold_for(threat_type)
                if confidence >= threshold:
                    return self._record(ClassificationResult(
                        threat_type, confidence, "ml_model", eval_drop_cat,
                    ))
                self._log_uncertain(fen, best_move_uci, threat_type, confidence)
                return self._record(ClassificationResult(
                    "other", confidence, "ml_uncertain", eval_drop_cat,
                ))
            except Exception as exc:
                log.debug("Stage 3 ML failed: %s", exc)

        # Stage 4: fallback
        return self._record(ClassificationResult(
            "other", 0.0, "ml_uncertain", eval_drop_cat,
        ))

    def get_method_distribution(self) -> dict[str, int]:
        with self._counter_lock:
            return dict(self._method_counts)

    def get_uncertain_log(self) -> list[dict]:
        return list(self._uncertain_log)

    def close(self) -> None:
        if self._engine is not None:
            try:
                self._engine.quit()
            except Exception:
                pass
            self._engine = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _record(self, result: ClassificationResult) -> ClassificationResult:
        with self._counter_lock:
            self._method_counts[result.method] = (
                self._method_counts.get(result.method, 0) + 1
            )
        return result

    def _log_uncertain(self, fen: str, move: str, threat: str, conf: float) -> None:
        self._uncertain_log.append(
            {"fen": fen, "move": move, "predicted": threat, "confidence": round(conf, 4)}
        )

    def _classify_via_lookahead(self, board: chess.Board, pv: list[chess.Move]) -> str:
        temp   = board.copy()
        played: list[chess.Move] = []
        for move in pv[:4]:
            if move not in temp.legal_moves:
                break
            temp.push(move)
            played.append(move)
            if not temp.is_check() and len(list(temp.legal_moves)) > 10:
                if len(played) >= 2:
                    break
        if not played:
            return "other"
        if temp.is_checkmate():
            return "king_attack"
        pre_last = board.copy()
        for m in played[:-1]:
            pre_last.push(m)
        return self._classify_rule(pre_last.fen(), played[-1].uci())

    def _classify_via_model(self, fen: str, move_uci: str) -> tuple[str, float]:
        from ml.classifier.features import extract_raw
        from ml.classifier.label_map import ML_LICHESS_CLASSES, ML_CLASS_TO_THREAT
        import numpy as np

        vec      = extract_raw(fen, move_uci).reshape(1, -1)
        proba    = self._model.predict_proba(vec)[0]
        pred_enc = int(np.argmax(proba))
        confidence = float(proba[pred_enc])

        if self._encoder is not None:
            orig_idx = int(self._encoder.inverse_transform([pred_enc])[0])
        else:
            orig_idx = pred_enc

        ml_class    = ML_LICHESS_CLASSES[orig_idx] if orig_idx < len(ML_LICHESS_CLASSES) else None
        threat_type = ML_CLASS_TO_THREAT.get(ml_class, "other")
        return threat_type, confidence


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_SINGLETON: Optional[HybridThreatClassifier] = None
_SINGLETON_LOCK = threading.Lock()


def get_classifier(
    model_path:  Optional[str | Path] = None,
    engine_path: Optional[str | Path] = None,
    force_new:   bool = False,
) -> HybridThreatClassifier:
    """Return the process-level singleton, creating it on first call."""
    global _SINGLETON
    with _SINGLETON_LOCK:
        if _SINGLETON is None or force_new:
            _root = Path(__file__).parent.parent.parent
            _mp   = model_path  or (_root / "models" / "threat_lgbm.pkl")
            _SINGLETON = HybridThreatClassifier(model_path=_mp, engine_path=engine_path)
        return _SINGLETON
