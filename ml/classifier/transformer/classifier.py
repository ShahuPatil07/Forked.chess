"""
TransformerThreatClassifier — pure transformer threat classification.

This REPLACES the old rule-based / depth-lookahead / LightGBM funnel
(`ml.classifier.hybrid_classifier.HybridThreatClassifier`) entirely. A mistake's
threat type now comes directly from the Stage-1 Chessformer's prediction — no
geometric rule system, no Stockfish lookahead, no LightGBM fallback.

Decision logic per (fen, best_move):
  1. eval_drop guard (kept — it's just a magnitude filter, not "rule-based
     classification"): < 50cp  -> "skip"; 50-99 -> "inaccuracy"; >=100 -> "blunder".
  2. The transformer predicts (threat_type, calibrated confidence) AND an
     out-of-distribution signal (`is_positional`).
  3. If the position looks UNLIKE any tactic the model learned
     (`is_positional`), route to "other" — the honest positional/unclassified
     bucket Stage 2 maps to the `unclassified` family and Stage 3 deliberately
     does NOT fetch tactical puzzles for.
  4. Otherwise take the transformer's top tactical class.

Public API matches the old classifier so it's a drop-in for ingestion:
  clf = get_classifier()
  res = clf.classify(fen, best_move_uci, eval_drop_cp=150)   # -> ClassificationResult
  dist = clf.get_method_distribution()
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


@dataclass
class ClassificationResult:
    """Same shape as the old hybrid classifier's result — downstream code
    (mistake_extractor) reads .threat_type / .confidence / .method /
    .eval_drop_category unchanged."""
    threat_type:        str
    confidence:         float
    method:             str    # "transformer" | "transformer_positional" | "skip"
    eval_drop_category: str    # "skip" | "inaccuracy" | "blunder"


class TransformerThreatClassifier:
    """Direct transformer classifier. No rule layer, no engine, no LightGBM."""

    def __init__(
        self,
        ckpt: Optional[str | Path] = None,
        ref:  Optional[str | Path] = None,
    ):
        from ml.classifier.transformer.predict import Predictor, DEFAULT_CKPT, DEFAULT_REF
        self._predictor = Predictor(
            ckpt=Path(ckpt) if ckpt else DEFAULT_CKPT,
            ref=Path(ref)  if ref  else DEFAULT_REF,
        )
        self._counter_lock = threading.Lock()
        self._method_counts: dict[str, int] = {
            "transformer": 0, "transformer_positional": 0, "skip": 0,
        }
        log.info("TransformerThreatClassifier ready (pure transformer, no rule funnel).")

    # ------------------------------------------------------------------ public

    def classify(
        self,
        fen:           str,
        best_move_uci: str,
        eval_drop_cp:  int = 100,
        pv_length:     int = 0,     # accepted + ignored (kept for call-site compatibility)
    ) -> ClassificationResult:
        # Stage 0 — eval-drop magnitude guard (not classification, just filtering)
        if eval_drop_cp < 50:
            return self._record(ClassificationResult("other", 1.0, "skip", "skip"))
        eval_drop_cat = "inaccuracy" if eval_drop_cp < 100 else "blunder"

        # Transformer prediction (single forward pass)
        try:
            out = self._predictor.predict(fen, best_move_uci)
        except Exception as exc:
            # Encoding/inference failure -> unclassified, never crash ingestion
            log.debug("Transformer predict failed for %s: %s", fen, exc)
            return self._record(ClassificationResult("other", 0.0, "skip", eval_drop_cat))

        # Out-of-distribution -> positional / unclassified bucket
        if bool(out.get("is_positional")):
            return self._record(ClassificationResult(
                "other", float(out["confidence"]), "transformer_positional", eval_drop_cat,
            ))

        return self._record(ClassificationResult(
            out["threat_type"], float(out["confidence"]), "transformer", eval_drop_cat,
        ))

    def get_method_distribution(self) -> dict[str, int]:
        with self._counter_lock:
            return dict(self._method_counts)

    def get_uncertain_log(self) -> list[dict]:
        return []   # no uncertain bucket in the pure-transformer path

    def close(self) -> None:
        pass        # no engine to release

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    # ----------------------------------------------------------------- internal

    def _record(self, result: ClassificationResult) -> ClassificationResult:
        with self._counter_lock:
            self._method_counts[result.method] = self._method_counts.get(result.method, 0) + 1
        return result


# ---------------------------------------------------------------------------
# Singleton — mirrors ml.classifier.hybrid_classifier.get_classifier
# ---------------------------------------------------------------------------

_SINGLETON: Optional[TransformerThreatClassifier] = None
_LOCK = threading.Lock()


def get_classifier(
    ckpt:      Optional[str | Path] = None,
    ref:       Optional[str | Path] = None,
    force_new: bool = False,
    **_compat,                       # accepts/ignores engine_path, model_path, etc.
) -> TransformerThreatClassifier:
    """Process-level singleton, created on first call. Drop-in replacement for
    the old hybrid_classifier.get_classifier()."""
    global _SINGLETON
    with _LOCK:
        if _SINGLETON is None or force_new:
            _SINGLETON = TransformerThreatClassifier(ckpt=ckpt, ref=ref)
        return _SINGLETON
