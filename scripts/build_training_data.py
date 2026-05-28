#!/usr/bin/env python
"""
Download and process the Lichess puzzle database into train/val/test parquet files.

The Lichess DB (~700MB compressed, ~3M puzzles) is streamed and decompressed
on the fly — it is never fully loaded into memory.

Output files:
    data/processed/train.parquet   (~80% of accepted examples)
    data/processed/val.parquet     (~10%)
    data/processed/test.parquet    (~10%)

Each parquet row has columns:
    fen      (str)       — position after opponent's first move (the actual puzzle FEN)
    move     (str)       — solution UCI move (first move the solver plays)
    label    (int8)      — index into THREAT_TYPES
    features (list<f32>) — 805-dim raw feature vector (bitboard + move + context)

Usage:
    python scripts/build_training_data.py [--max 2000000] [--max-per-class 200000] [--resume]
"""
from __future__ import annotations

import argparse
import csv
import io
import logging
import random
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import chess
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from ml.classifier.features import extract_raw, RAW_FEATURE_DIM
from ml.classifier.label_map import map_lichess_themes_to_ml_class, ML_LICHESS_CLASSES
from ml.config import DATA_DIR

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)

URL         = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
RAW_DIR     = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
CHUNK_SIZE  = 50_000   # rows per write batch
SPLIT_SEED  = 42
SPLITS      = {"train": 0.80, "val": 0.10, "test": 0.10}

PARQUET_SCHEMA = pa.schema([
    ("fen",      pa.string()),
    ("move",     pa.string()),
    ("label",    pa.int8()),
    ("features", pa.list_(pa.float32())),
])


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

def _download_raw(dest: Path) -> None:
    log.info("Downloading Lichess puzzle DB → %s", dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp")
    start = time.time()

    def _reporthook(count, block_size, total_size):
        if total_size > 0:
            pct = min(100, int(count * block_size * 100 / total_size))
            mb  = count * block_size / 1e6
            sys.stderr.write(f"\r  {pct}%  {mb:.0f} MB")
        else:
            mb = count * block_size / 1e6
            sys.stderr.write(f"\r  {mb:.0f} MB")
        sys.stderr.flush()

    urllib.request.urlretrieve(URL, tmp, _reporthook)
    sys.stderr.write("\n")
    tmp.rename(dest)
    elapsed = time.time() - start
    log.info("Download complete in %.0fs  (%.0f MB)", elapsed, dest.stat().st_size / 1e6)


# ---------------------------------------------------------------------------
# Parquet writers
# ---------------------------------------------------------------------------

class _SplitWriters:
    def __init__(self, out_dir: Path, rng: random.Random):
        out_dir.mkdir(parents=True, exist_ok=True)
        self._rng = rng
        self._writers: dict[str, pq.ParquetWriter] = {
            split: pq.ParquetWriter(
                out_dir / f"{split}.parquet",
                PARQUET_SCHEMA,
                compression="snappy",
            )
            for split in SPLITS
        }
        self._bufs: dict[str, dict] = {s: _empty_buf() for s in SPLITS}
        self._counts = {s: 0 for s in SPLITS}

    def add(self, fen: str, move: str, label: int, features: np.ndarray) -> None:
        r = self._rng.random()
        if r < SPLITS["train"]:
            split = "train"
        elif r < SPLITS["train"] + SPLITS["val"]:
            split = "val"
        else:
            split = "test"

        b = self._bufs[split]
        b["fen"].append(fen)
        b["move"].append(move)
        b["label"].append(label)
        b["features"].append(features.tolist())
        self._counts[split] += 1

        if len(b["fen"]) >= CHUNK_SIZE:
            self._flush(split)

    def _flush(self, split: str) -> None:
        b = self._bufs[split]
        if not b["fen"]:
            return
        batch = pa.RecordBatch.from_pydict(
            {
                "fen":      pa.array(b["fen"],   type=pa.string()),
                "move":     pa.array(b["move"],  type=pa.string()),
                "label":    pa.array(b["label"], type=pa.int8()),
                "features": pa.array(b["features"], type=pa.list_(pa.float32())),
            },
            schema=PARQUET_SCHEMA,
        )
        self._writers[split].write_batch(batch)
        self._bufs[split] = _empty_buf()

    def close(self) -> dict[str, int]:
        for split in SPLITS:
            self._flush(split)
        for w in self._writers.values():
            w.close()
        return dict(self._counts)


def _empty_buf() -> dict:
    return {"fen": [], "move": [], "label": [], "features": []}


# ---------------------------------------------------------------------------
# Main processing loop
# ---------------------------------------------------------------------------

def process(raw_path: Path, max_examples: int, max_per_class: int) -> None:
    import zstandard as zstd

    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    rng     = random.Random(SPLIT_SEED)
    writers = _SplitWriters(PROCESSED_DIR, rng)

    # Per-class cap: tracks accepted count globally (across all splits).
    # Prevents dominant classes (king_attack, endgame_technique) from
    # consuming the entire training budget.
    class_counts: dict[int, int] = {}
    capped = 0  # examples skipped specifically due to per-class cap

    accepted = 0
    skipped  = 0
    errors   = 0
    t0       = time.time()

    log.info(
        "Streaming %s  (max %d total, max %d per class)",
        raw_path.name, max_examples, max_per_class,
    )

    with open(raw_path, "rb") as fh:
        dctx   = zstd.ZstdDecompressor()
        stream = dctx.stream_reader(fh)
        text   = io.TextIOWrapper(stream, encoding="utf-8", newline="")
        reader = csv.DictReader(text)

        for row in reader:
            if accepted >= max_examples:
                break

            themes = row.get("Themes", "").split()
            label_str = map_lichess_themes_to_ml_class(themes)
            if label_str is None:
                skipped += 1
                continue

            label_idx = ML_LICHESS_CLASSES.index(label_str)   # always valid

            # Per-class cap — skip once this class is saturated
            if class_counts.get(label_idx, 0) >= max_per_class:
                capped += 1
                continue

            raw_fen = row.get("FEN", "")
            moves   = row.get("Moves", "").split()
            if len(moves) < 2 or not raw_fen:
                skipped += 1
                continue

            try:
                board = chess.Board(raw_fen)
                board.push(chess.Move.from_uci(moves[0]))
                puzzle_fen = board.fen()
                solution_uci = moves[1]
                if chess.Move.from_uci(solution_uci) not in board.legal_moves:
                    skipped += 1
                    continue
            except Exception:
                errors += 1
                continue

            try:
                features = extract_raw(puzzle_fen, solution_uci)
            except Exception:
                errors += 1
                continue

            writers.add(puzzle_fen, solution_uci, label_idx, features)
            class_counts[label_idx] = class_counts.get(label_idx, 0) + 1
            accepted += 1

            if accepted % 100_000 == 0:
                elapsed = time.time() - t0
                log.info(
                    "  %d accepted  |  %d skipped  |  %d capped  |  %d errors  |  %.0fs",
                    accepted, skipped, capped, errors, elapsed,
                )

    counts = writers.close()
    elapsed = time.time() - t0

    log.info("\n=== Build complete ===")
    log.info("Total accepted : %d", accepted)
    log.info("Skipped        : %d  (no clean theme mapping)", skipped)
    log.info("Capped         : %d  (per-class limit reached)", capped)
    log.info("Errors         : %d  (bad FEN / move)", errors)
    log.info("Time           : %.0fs", elapsed)
    log.info("")
    log.info("Split breakdown:")
    for split, count in counts.items():
        log.info("  %-8s %d", split, count)
    log.info("")
    log.info("Label distribution (train):")
    _print_label_dist(PROCESSED_DIR / "train.parquet")


def _print_label_dist(path: Path) -> None:
    if not path.exists():
        return
    import pyarrow.parquet as pq
    t      = pq.read_table(path, columns=["label"])
    labels = t.column("label").to_pylist()
    total  = len(labels)
    counts: dict[int, int] = {}
    for lbl in labels:
        counts[lbl] = counts.get(lbl, 0) + 1
    for idx, name in enumerate(ML_LICHESS_CLASSES):
        cnt = counts.get(idx, 0)
        bar = "#" * min(25, int(cnt / max(total, 1) * 50))
        print(f"  {name:<22}  {cnt:>7}  ({cnt/max(total,1)*100:5.1f}%)  {bar}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser(
        description="Build training data from Lichess puzzle DB."
    )
    p.add_argument(
        "--max", type=int, default=2_000_000,
        help="Maximum total accepted examples (default 2M)",
    )
    p.add_argument(
        "--max-per-class", type=int, default=200_000,
        help="Cap per class: dominant classes are capped here, rare ones use all available "
             "(default 200K — gives a ≤8:1 ratio between most and least common classes)",
    )
    p.add_argument(
        "--resume", action="store_true",
        help="Skip download if the raw .zst file already exists",
    )
    args = p.parse_args()

    raw_path = RAW_DIR / "lichess_db_puzzle.csv.zst"

    if raw_path.exists() and args.resume:
        log.info("Raw file found at %s — skipping download (--resume)", raw_path)
    else:
        _download_raw(raw_path)

    process(raw_path, args.max, args.max_per_class)


if __name__ == "__main__":
    main()
