#!/usr/bin/env python
"""
Train the LightGBM threat classifier on processed parquet data.

The model is trained on ML_LICHESS_CLASSES (16 Lichess-native labels).
At inference time, HybridThreatClassifier maps predictions back to
THREAT_TYPES via ML_CLASS_TO_THREAT.

Steps:
  1. Load train.parquet and val.parquet
  2. Separate bitboard dims (0:768) from non-bitboard dims (768:)
  3. Fit PCA(64) on train bitboard dims only
  4. Concatenate PCA-reduced bitboard + other dims → 101-dim final features
  5. Train LightGBM with early stopping on val loss
  6. Save PCA + model + LabelEncoder to models/

LabelEncoder is used to handle any ML_LICHESS_CLASSES that have 0 training
examples (maps present classes to consecutive 0..N-1 indices).

Prerequisites:
    python scripts/build_training_data.py

Usage:
    python scripts/train_classifier.py [--pca-components 64] [--n-estimators 1000]
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import joblib
import lightgbm as lgb
import numpy as np
import pyarrow.parquet as pq
from sklearn.preprocessing import LabelEncoder
from ml.classifier.label_map import ML_LICHESS_CLASSES, ML_CLASS_TO_THREAT
from ml.config import DATA_DIR

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

PROCESSED_DIR = DATA_DIR / "processed"
MODELS_DIR    = Path(__file__).parent.parent / "models"


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def _load_split(name: str) -> tuple[np.ndarray, np.ndarray]:
    """Load one parquet split. Returns (X_raw, y) where X_raw is (N, 805).

    Uses PyArrow native array ops to avoid the ~3× peak-memory spike that
    to_pylist() causes (it materialises every row as a Python list before numpy
    sees it).
    """
    path = PROCESSED_DIR / f"{name}.parquet"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found — run build_training_data.py first")

    log.info("Loading %s ...", path.name)
    t = pq.read_table(path, columns=["features", "label"])
    n = len(t)

    # features column is ListArray<float32>: flatten → reshape, no Python list
    feat_col = t.column("features").combine_chunks()
    X = feat_col.values.to_numpy(zero_copy_only=False).reshape(n, -1).astype(np.float32)

    y = t.column("label").combine_chunks().to_numpy(zero_copy_only=False).astype(np.int32)

    log.info("  %d examples, %d raw features", X.shape[0], X.shape[1])
    return X, y


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Train LightGBM threat classifier.")
    ap.add_argument("--n-estimators",   type=int, default=1000,
                    help="Max LightGBM trees (early stopping trims this, default 1000)")
    ap.add_argument("--learning-rate",  type=float, default=0.05)
    ap.add_argument("--num-leaves",     type=int,   default=127)
    ap.add_argument("--early-stopping", type=int,   default=50)
    args = ap.parse_args()

    MODELS_DIR.mkdir(parents=True, exist_ok=True)

    # ── Load data ──────────────────────────────────────────────────────────────
    X_train_raw, y_train = _load_split("train")
    X_val_raw,   y_val   = _load_split("val")

    # ── LabelEncoder — handles any zero-sample classes gracefully ─────────────
    present_in_train = sorted(set(y_train.tolist()))
    absent = [ML_LICHESS_CLASSES[i] for i in range(len(ML_LICHESS_CLASSES))
              if i not in present_in_train]
    if absent:
        log.info("\nML classes absent from training data: %s", ", ".join(absent))

    le = LabelEncoder()
    le.fit(present_in_train)            # maps present class indices → 0..N-1
    y_train_enc = le.transform(y_train)

    # Val: drop rows whose label isn't in the training set
    val_mask = np.isin(y_val, present_in_train)
    if not val_mask.all():
        log.info("Dropped %d val rows (class not in training set)", (~val_mask).sum())
    X_val_raw   = X_val_raw[val_mask]
    y_val_enc   = le.transform(y_val[val_mask])

    # ── Class distribution ────────────────────────────────────────────────────
    log.info("\nTraining label distribution (%d classes present):", len(present_in_train))
    n_train = len(y_train_enc)
    for enc_idx in range(len(present_in_train)):
        orig_idx = int(le.inverse_transform([enc_idx])[0])
        name     = ML_LICHESS_CLASSES[orig_idx]
        cnt      = (y_train_enc == enc_idx).sum()
        threat   = ML_CLASS_TO_THREAT.get(name, "?")
        log.info("  %-22s → %-22s  %7d  (%.1f%%)",
                 name, threat, cnt, cnt / n_train * 100)

    # ── No PCA — use raw 805-dim features directly ───────────────────────────
    # LightGBM is a tree model: it splits on individual features and handles
    # high-dimensional sparse binary inputs (bitboard) natively and efficiently.
    # PCA destroys the sparse binary structure and the interpretable piece-square
    # encoding, hurting accuracy. Raw features are strictly better here.
    X_train, X_val = X_train_raw, X_val_raw
    del X_train_raw, X_val_raw
    log.info("\nFeature dim: %d (raw, no PCA)", X_train.shape[1])

    # ── Train LightGBM ────────────────────────────────────────────────────────
    log.info("\nTraining LightGBM (%d classes)...", len(present_in_train))
    t0 = time.time()

    model = lgb.LGBMClassifier(
        n_estimators=args.n_estimators,
        learning_rate=args.learning_rate,
        num_leaves=args.num_leaves,
        max_depth=8,
        min_child_samples=20,
        class_weight="balanced",
        subsample=0.8,
        colsample_bytree=0.8,
        reg_alpha=0.1,
        reg_lambda=0.1,
        n_jobs=-1,
        random_state=42,
        verbose=-1,
    )

    model.fit(
        X_train, y_train_enc,
        eval_set=[(X_val, y_val_enc)],
        callbacks=[
            lgb.early_stopping(args.early_stopping, verbose=True),
            lgb.log_evaluation(50),
        ],
    )

    elapsed = time.time() - t0
    log.info("Training complete in %.0fs  (%d trees)", elapsed, model.n_estimators_)

    # ── Validation accuracy ───────────────────────────────────────────────────
    y_pred_enc = model.predict(X_val)
    acc = (y_pred_enc == y_val_enc).mean()
    log.info("Val overall accuracy: %.2f%%", acc * 100)

    log.info("\nPer-class accuracy:")
    for enc_idx in range(len(present_in_train)):
        orig_idx = int(le.inverse_transform([enc_idx])[0])
        name     = ML_LICHESS_CLASSES[orig_idx]
        mask     = y_val_enc == enc_idx
        if mask.sum() == 0:
            continue
        a    = (y_pred_enc[mask] == enc_idx).mean()
        bar  = "#" * int(a * 20)
        flag = "  ⚠ BELOW 70%" if a < 0.70 else ""
        log.info("  %-22s  %5.1f%%  %s%s", name, a * 100, bar, flag)

    # ── Save artifacts ────────────────────────────────────────────────────────
    model_path   = MODELS_DIR / "threat_lgbm.pkl"
    encoder_path = MODELS_DIR / "label_encoder.pkl"

    joblib.dump(model, model_path)
    joblib.dump(le,    encoder_path)

    log.info("\nSaved model        → %s  (%.1f MB)", model_path,
             model_path.stat().st_size / 1e6)
    log.info("Saved label encoder → %s", encoder_path)


if __name__ == "__main__":
    main()
