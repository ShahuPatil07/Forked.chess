#!/usr/bin/env python
"""
Run the Stage-1/2 pipeline over the fixed benchmark accounts (data/bench/).

The first run fetches each account's newest rapid games and freezes them to
data/bench/<user>_games.json, so every later run (new classifier, new scoring,
legacy comparison) sees the identical games. Stockfish work is cached per game
(data/annotation_cache.db), so re-runs only redo classification + Stage 2.

    python scripts/run_stage12_bench.py                 # all benchmark users
    python scripts/run_stage12_bench.py --users ShahuPatil27 --workers 5
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ml.config import DATA_DIR

BENCH_DIR = DATA_DIR / "bench"
BENCH_USERS = [            # (username, platform, games) — rating spread 1437-1827 rapid
    ("ShahuPatil27", "chesscom", 150),
    ("semilore17", "chesscom", 100),
    ("MinnowMate", "chesscom", 100),
    ("sambartiquel", "chesscom", 100),
    ("Pilkification", "chesscom", 100),
]


def frozen_games(user: str, platform: str, n: int) -> list[dict]:
    from ml.pipeline import _fetch_and_parse
    path = BENCH_DIR / f"{user}_games.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    games = _fetch_and_parse(user, platform, n)
    BENCH_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(games), encoding="utf-8")
    return games


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", nargs="*", default=None)
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--no-stage2", action="store_true")
    args = ap.parse_args()
    from ml.pipeline import run_ingestion
    from ml.clustering.profile_pipeline import run_clustering
    for user, platform, n in BENCH_USERS:
        if args.users and user not in args.users:
            continue
        t0 = time.time()
        games = frozen_games(user, platform, n)
        ms = run_ingestion(user, platform=platform, min_games=n, output_dir=BENCH_DIR,
                           workers=args.workers, games=games)
        if not args.no_stage2 and ms:
            run_clustering(ms, user, output_dir=BENCH_DIR)
        print(f"== {user}: {len(games)} games, {len(ms)} mistakes, {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
