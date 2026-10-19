#!/usr/bin/env python
"""
Build the Stage-1 v2 (multi-label) training data from the Lichess puzzle DB.

Streams data/raw/lichess_db_puzzle.csv.zst once and writes, under data/processed/:
  mt_train.npz / mt_val.npz   class-balanced (bucketed by rarest label) puzzles,
                              multi-hot targets over label_map_v2.MOTIF_CLASSES
  mt_oldtest.npz              a fixed sample of the v1 TEST split (never trained on
                              by v1 or v2) with v1 label + v2 multi-hot targets
  e2_realgame.jsonl           raw real-game blunders from that same held-out sample
                              (pre-blunder FEN, blunder move, solution, themes) for
                              the end-to-end Stage-1 evaluation
  neg_source.txt              pre-blunder real-game FENs, mined into "none"
                              (no-tactic) negatives by mine_negatives.py

Leakage guard: every (puzzle_fen, solution) in the v1 val/test parquet is excluded
from mt_train/mt_val, so the v1 test split stays clean for both models.

    python -m ml.classifier.transformer.prepare_data [--cap 24000]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

import chess
import numpy as np

from ml.config import DATA_DIR
from ml.classifier.label_map_v2 import (
    MOTIF_CLASSES, N_CLASSES, CLASS_INDEX, themes_to_classes, rarest,
)
from ml.classifier.transformer.board_encoding import encode_position

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

RAW = DATA_DIR / "raw" / "lichess_db_puzzle.csv.zst"
OUT = DATA_DIR / "processed"


def _old_split_keys(split: str) -> tuple[list[str], list[int]]:
    import pyarrow.parquet as pq
    t = pq.read_table(OUT / f"{split}.parquet", columns=["fen", "move", "label"])
    fens = t.column("fen").to_pylist()
    moves = t.column("move").to_pylist()
    labels = t.column("label").to_pylist()
    return [f"{f} {m}" for f, m in zip(fens, moves)], labels


def _encode_rows(rows: list[tuple[str, str]]):
    codes, meta, castle, keep = [], [], [], []
    for fen, mv in rows:
        try:
            e = encode_position(fen, mv)
        except Exception:
            keep.append(False)
            continue
        codes.append(e["codes"]); meta.append(e["meta"]); castle.append(e["castle"])
        keep.append(True)
    return (np.stack(codes).astype(np.int8), np.stack(meta).astype(np.int16),
            np.stack(castle).astype(np.int8), np.array(keep, dtype=bool))


def _multi_hot(class_lists: list[list[str]]) -> np.ndarray:
    y = np.zeros((len(class_lists), N_CLASSES), dtype=np.uint8)
    for i, cl in enumerate(class_lists):
        for c in cl:
            y[i, CLASS_INDEX[c]] = 1
    return y


def _save(name: str, rows, class_lists, extra: dict | None = None) -> int:
    codes, meta, castle, keep = _encode_rows(rows)
    y = _multi_hot([c for c, k in zip(class_lists, keep) if k])
    payload = {"codes": codes, "meta": meta, "castle": castle, "labels": y}
    for k, v in (extra or {}).items():
        payload[k] = np.asarray(v)[keep]
    np.savez_compressed(OUT / name, **payload)
    log.info("  wrote %-18s %7d rows", name, len(y))
    return len(y)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cap", type=int, default=24_000, help="max puzzles per rarest-label bucket")
    ap.add_argument("--val-frac", type=float, default=0.04)
    ap.add_argument("--oldtest", type=int, default=40_000, help="v1-test rows to keep for E1")
    ap.add_argument("--e2", type=int, default=4_000, help="held-out real-game blunders for E2")
    ap.add_argument("--neg-source", type=int, default=90_000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    OUT.mkdir(parents=True, exist_ok=True)

    log.info("Loading v1 val/test keys (leakage guard)...")
    val_keys, _ = _old_split_keys("val")
    test_keys, test_labels = _old_split_keys("test")
    exclude = set(val_keys) | set(test_keys)
    idx = list(range(len(test_keys)))
    rng.shuffle(idx)
    oldtest_pick = {test_keys[i]: test_labels[i] for i in idx[: args.oldtest]}
    log.info("  excluded %d keys; E1 sample %d", len(exclude), len(oldtest_pick))

    buckets: dict[str, int] = {c: 0 for c in MOTIF_CLASSES}
    train_rows, train_cls, train_rating = [], [], []
    val_rows, val_cls = [], []
    oldtest_rows, oldtest_cls, oldtest_v1 = [], [], []
    e2_rows: list[dict] = []
    neg_src: list[str] = []
    n_seen = 0
    t0 = time.time()

    import zstandard
    with open(RAW, "rb") as fh:
        text = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), encoding="utf-8")
        for row in csv.DictReader(text):
            n_seen += 1
            moves = row["Moves"].split()
            if len(moves) < 2:
                continue
            try:
                b = chess.Board(row["FEN"])
                b.push(chess.Move.from_uci(moves[0]))
            except Exception:
                continue
            key = f"{b.fen()} {moves[1]}"
            classes = themes_to_classes(row["Themes"])

            if key in oldtest_pick:
                if classes:
                    oldtest_rows.append((b.fen(), moves[1]))
                    oldtest_cls.append(classes)
                    oldtest_v1.append(oldtest_pick[key])
                    if len(e2_rows) < args.e2 * 3:          # oversample, subsampled below
                        e2_rows.append({
                            "puzzle_id": row["PuzzleId"], "raw_fen": row["FEN"],
                            "moves": moves, "themes": row["Themes"].split(),
                            "classes": classes, "rating": int(row["Rating"]),
                            "url": row["GameUrl"],
                        })
                continue
            if key in exclude:
                continue

            # Negative-mining source: the real-game position BEFORE the blunder.
            if len(neg_src) < args.neg_source:
                neg_src.append(row["FEN"])
            elif rng.random() < 0.02:
                neg_src[rng.randrange(len(neg_src))] = row["FEN"]

            if not classes:
                continue
            bucket = rarest(classes)
            if buckets[bucket] >= args.cap:
                continue
            buckets[bucket] += 1
            if rng.random() < args.val_frac:
                val_rows.append((b.fen(), moves[1])); val_cls.append(classes)
            else:
                train_rows.append((b.fen(), moves[1])); train_cls.append(classes)
                train_rating.append(int(row["Rating"]))

            if n_seen % 500_000 == 0:
                log.info("  %7d rows streamed | train %d | %.0fs", n_seen, len(train_rows), time.time() - t0)

    log.info("Streamed %d puzzles in %.0fs", n_seen, time.time() - t0)
    log.info("Bucket fill: %s", {k: v for k, v in buckets.items() if v})

    perm = list(range(len(train_rows)))
    rng.shuffle(perm)
    train_rows = [train_rows[i] for i in perm]
    train_cls = [train_cls[i] for i in perm]
    train_rating = [train_rating[i] for i in perm]

    _save("mt_train.npz", train_rows, train_cls, {"rating": train_rating})
    _save("mt_val.npz", val_rows, val_cls)
    _save("mt_oldtest.npz", oldtest_rows, oldtest_cls, {"v1_label": oldtest_v1})

    rng.shuffle(e2_rows)
    with open(OUT / "e2_realgame.jsonl", "w", encoding="utf-8") as fh:
        for r in e2_rows[: args.e2]:
            fh.write(json.dumps(r) + "\n")
    (OUT / "neg_source.txt").write_text("\n".join(neg_src), encoding="utf-8")
    log.info("  wrote e2_realgame.jsonl (%d) and neg_source.txt (%d)", min(len(e2_rows), args.e2), len(neg_src))


if __name__ == "__main__":
    main()
