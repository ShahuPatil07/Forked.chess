#!/usr/bin/env python
"""
Evaluate the trained threat classifier on the test set.

Outputs:
  - Classification report (precision / recall / F1 per class)
  - Confusion matrix saved to results/confusion_matrix.png
  - Misclassified examples saved to results/misclassified_examples.json
  - Breakdown of rule_based vs depth_lookahead vs ml_model classification rates

Usage:
    python scripts/evaluate_classifier.py [--split test] [--n-misclassified 10]
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import joblib
import numpy as np
import pyarrow.parquet as pq
from sklearn.metrics import classification_report, confusion_matrix

from ml.classifier.features import BITBOARD_DIM  # used when PCA model present
from ml.classifier.label_map import ML_LICHESS_CLASSES, ML_CLASS_TO_THREAT
from ml.config import DATA_DIR

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

PROCESSED_DIR = DATA_DIR / "processed"
MODELS_DIR    = Path(__file__).parent.parent / "models"
RESULTS_DIR   = Path(__file__).parent.parent / "results"


def main() -> None:
    ap = argparse.ArgumentParser(description="Evaluate the threat classifier.")
    ap.add_argument("--split",           default="test",
                    help="Parquet split to evaluate on (default: test)")
    ap.add_argument("--n-misclassified", type=int, default=10,
                    help="Misclassified examples to save per class (default: 10)")
    ap.add_argument("--no-plot",         action="store_true",
                    help="Skip confusion matrix plot (useful in headless environments)")
    args = ap.parse_args()

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    # ── Load model ───────────────────────────────────────────────────────────
    model_path = MODELS_DIR / "threat_lgbm.pkl"
    if not model_path.exists():
        log.error("Model not found at %s. Run train_classifier.py first.", model_path)
        sys.exit(1)

    model    = joblib.load(model_path)
    enc_path = MODELS_DIR / "label_encoder.pkl"
    le       = joblib.load(enc_path) if enc_path.exists() else None
    # PCA is optional — present only in older runs
    pca_path = MODELS_DIR / "pca_bitboard.pkl"
    pca      = joblib.load(pca_path) if pca_path.exists() else None
    log.info("Loaded model from %s (PCA: %s)", model_path, "yes" if pca else "no")

    # ── Load test data ────────────────────────────────────────────────────────
    path = PROCESSED_DIR / f"{args.split}.parquet"
    if not path.exists():
        log.error("%s not found. Run build_training_data.py first.", path)
        sys.exit(1)

    log.info("Loading %s ...", path.name)
    table = pq.read_table(path)
    fens  = table.column("fen").to_pylist()
    moves = table.column("move").to_pylist()

    n     = len(table)
    feat_col = table.column("features").combine_chunks()
    X_raw    = feat_col.values.to_numpy(zero_copy_only=False).reshape(n, -1).astype(np.float32)
    y        = table.column("label").combine_chunks().to_numpy(zero_copy_only=False).astype(np.int32)

    # Apply PCA only if the model was trained with one
    if pca is not None:
        X_bb = pca.transform(X_raw[:, :BITBOARD_DIM])
        X    = np.hstack([X_bb, X_raw[:, BITBOARD_DIM:]])
    else:
        X = X_raw
    del X_raw
    log.info("  %d examples loaded", len(y))

    # ── Filter to classes seen during training ────────────────────────────────
    if le is not None:
        mask = np.isin(y, le.classes_)
        if not mask.all():
            log.info("  Filtered %d examples with classes absent from training", (~mask).sum())
            y     = y[mask]
            X     = X[mask]
            fens  = [f for f, m in zip(fens,  mask) if m]
            moves = [mv for mv, m in zip(moves, mask) if m]

    # ── Predict ───────────────────────────────────────────────────────────────
    y_pred_enc = model.predict(X)

    # y is in original ML_LICHESS_CLASSES index space (straight from parquet).
    # Predictions are in encoded space (0..N-1) — inverse_transform decodes them.
    if le is not None:
        y_true_orig = y                              # already original indices
        y_pred_orig = le.inverse_transform(y_pred_enc)
    else:
        y_true_orig, y_pred_orig = y, y_pred_enc

    acc = (y_pred_orig == y_true_orig).mean()
    log.info("Overall accuracy: %.2f%%\n", acc * 100)

    # ── Classification report ─────────────────────────────────────────────────
    present_labels = sorted(set(y_true_orig.tolist()) | set(y_pred_orig.tolist()))
    present_names  = [ML_LICHESS_CLASSES[i] + " -> " + ML_CLASS_TO_THREAT.get(ML_LICHESS_CLASSES[i], "?")
                      for i in present_labels if i < len(ML_LICHESS_CLASSES)]
    y_pred = y_pred_orig  # alias for downstream use

    report = classification_report(
        y_true_orig, y_pred,
        labels=present_labels,
        target_names=present_names,
        digits=3,
        zero_division=0,
    )
    print(report)

    report_path = RESULTS_DIR / "classification_report.txt"
    report_path.write_text(report, encoding="utf-8")
    log.info("Classification report saved → %s", report_path)

    # ── Confusion matrix ──────────────────────────────────────────────────────
    cm = confusion_matrix(y_true_orig, y_pred, labels=present_labels)

    if not args.no_plot:
        _plot_confusion_matrix(cm, present_names)

    # ── Misclassified examples ─────────────────────────────────────────────────
    misclassified = _collect_misclassified(
        fens, moves, y_true_orig, y_pred, n_per_class=args.n_misclassified
    )
    mis_path = RESULTS_DIR / "misclassified_examples.json"
    mis_path.write_text(
        json.dumps(misclassified, indent=2), encoding="utf-8"
    )
    log.info("Misclassified examples saved → %s", mis_path)

    # ── Rule vs ML breakdown (run hybrid on a subsample) ─────────────────────
    log.info("\nEstimating rule_based vs ml_model split (1000-example subsample)...")
    _method_breakdown(fens[:1000], moves[:1000])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _plot_confusion_matrix(cm: np.ndarray, labels: list[str]) -> None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.ticker as ticker
    except ImportError:
        log.warning("matplotlib not installed — skipping confusion matrix plot")
        return

    # Normalise rows to [0, 1] for readability
    cm_norm = cm.astype(float)
    row_sums = cm_norm.sum(axis=1, keepdims=True)
    row_sums[row_sums == 0] = 1
    cm_norm /= row_sums

    fig, ax = plt.subplots(figsize=(14, 12))
    im = ax.imshow(cm_norm, cmap="Blues", vmin=0, vmax=1)
    plt.colorbar(im, ax=ax, fraction=0.046, pad=0.04)

    ax.set_xticks(range(len(labels)))
    ax.set_yticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=45, ha="right", fontsize=8)
    ax.set_yticklabels(labels, fontsize=8)
    ax.set_xlabel("Predicted label")
    ax.set_ylabel("True label")
    ax.set_title("Threat classifier — normalised confusion matrix")

    # Annotate cells with raw counts
    for i in range(len(labels)):
        for j in range(len(labels)):
            if cm[i, j] > 0:
                ax.text(
                    j, i, str(cm[i, j]),
                    ha="center", va="center",
                    fontsize=6,
                    color="white" if cm_norm[i, j] > 0.6 else "black",
                )

    plt.tight_layout()
    out = RESULTS_DIR / "confusion_matrix.png"
    plt.savefig(out, dpi=150)
    plt.close()
    log.info("Confusion matrix saved → %s", out)


def _collect_misclassified(
    fens:       list[str],
    moves:      list[str],
    y_true:     np.ndarray,
    y_pred:     np.ndarray,
    n_per_class: int,
) -> list[dict]:
    buckets: dict[tuple, list] = {}
    for i, (yt, yp) in enumerate(zip(y_true, y_pred)):
        if yt == yp:
            continue
        key = (int(yt), int(yp))
        if len(buckets.get(key, [])) < n_per_class:
            buckets.setdefault(key, []).append({
                "fen":       fens[i],
                "move":      moves[i],
                "true":      _ml_class_name(yt),
                "predicted": _ml_class_name(yp),
            })

    return [entry for entries in buckets.values() for entry in entries]


def _ml_class_name(idx: int) -> str:
    if idx < len(ML_LICHESS_CLASSES):
        cls = ML_LICHESS_CLASSES[idx]
        return f"{cls} → {ML_CLASS_TO_THREAT.get(cls, '?')}"
    return str(idx)


def _method_breakdown(fens: list[str], moves: list[str]) -> None:
    from ml.classifier.hybrid_classifier import HybridThreatClassifier

    model_path = MODELS_DIR / "threat_lgbm.pkl"
    pca_path   = MODELS_DIR / "pca_bitboard.pkl"

    counts = {"rule_based": 0, "depth_lookahead": 0, "ml_model": 0}
    clf = HybridThreatClassifier(model_path=model_path, pca_path=pca_path)

    for fen, move in zip(fens, moves):
        try:
            _, method = clf.classify(fen, move, "")
            counts[method] = counts.get(method, 0) + 1
        except Exception:
            pass

    total = sum(counts.values())
    log.info("\nClassification method breakdown (n=%d):", total)
    for method, cnt in counts.items():
        bar = "#" * int(cnt / max(total, 1) * 40)
        log.info("  %-20s  %5d  (%5.1f%%)  %s", method, cnt, cnt / max(total, 1) * 100, bar)


if __name__ == "__main__":
    main()
