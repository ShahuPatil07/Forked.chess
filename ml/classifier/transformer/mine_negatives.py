#!/usr/bin/env python
"""
Mine "none" (no-tactic) negatives for the v2 classifier.

Source: real-game positions (the pre-blunder FENs of puzzles, written by
prepare_data.py to neg_source.txt). A position is a negative when, at depth 10,
it is not decided (|eval| <= 300cp, no mate) and the side to move's best line
nets less than one pawn of settled material — i.e. the engine's best move is
quiet. The (fen, best move) pair is exactly what Stage 1 classifies for a
"quiet" mistake, so this teaches the model an honest "no tactic" answer.

    python -m ml.classifier.transformer.mine_negatives [--n 30000] [--workers 4]
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

import chess
import chess.engine
import numpy as np

from ml.config import DATA_DIR
from ml.classifier.label_map_v2 import N_CLASSES, NONE_INDEX
from ml.classifier.transformer.board_encoding import encode_position
from ml.ingestion.engine_pool import EnginePool
from ml.ingestion.mechanism import settled_gain

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger(__name__)
OUT = DATA_DIR / "processed"


def _probe(engine: chess.engine.SimpleEngine, fen: str):
    try:
        b = chess.Board(fen)
        if b.is_game_over():
            return None
        info = engine.analyse(b, chess.engine.Limit(depth=10))
        sc = info["score"].pov(b.turn)
        if sc.is_mate():
            return None
        cp = sc.score() or 0
        pv = [m.uci() for m in info.get("pv", [])]
        if abs(cp) > 300 or len(pv) < 2:
            return None
        if settled_gain(b, pv) >= 100:
            return None
        return fen, pv[0]
    except Exception:
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=30_000)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    src = (OUT / "neg_source.txt").read_text(encoding="utf-8").split("\n")
    log.info("Mining up to %d negatives from %d real-game positions...", args.n, len(src))
    t0 = time.time()
    found: list[tuple[str, str]] = []
    with EnginePool(workers=args.workers) as pool:
        for start in range(0, len(src), 4000):
            chunk = src[start:start + 4000]
            found.extend(r for r in pool.map(_probe, chunk) if r)
            log.info("  scanned %d | negatives %d | %.0fs", start + len(chunk), len(found), time.time() - t0)
            if len(found) >= args.n:
                break
    found = found[: args.n]

    codes, meta, castle = [], [], []
    for fen, mv in found:
        e = encode_position(fen, mv)
        codes.append(e["codes"]); meta.append(e["meta"]); castle.append(e["castle"])
    y = np.zeros((len(found), N_CLASSES), dtype=np.uint8)
    y[:, NONE_INDEX] = 1
    np.savez_compressed(OUT / "mt_neg.npz", codes=np.stack(codes).astype(np.int8),
                        meta=np.stack(meta).astype(np.int16), castle=np.stack(castle).astype(np.int8),
                        labels=y)
    log.info("Wrote mt_neg.npz with %d negatives (%.0fs)", len(found), time.time() - t0)


if __name__ == "__main__":
    main()
