#!/usr/bin/env python
"""
Stage-3 CLI: download Lichess puzzles and build the search index.

Run once (or re-run to refresh with more puzzles):
    python scripts/run_puzzle_import.py ShahuPatil07
    python scripts/run_puzzle_import.py ShahuPatil07 --puzzles 50000
    python scripts/run_puzzle_import.py ShahuPatil07 --min-rating 1000 --max-rating 2000
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from ml.config import DATA_DIR
from ml.puzzles.importer import build_puzzle_index, PUZZLE_DIR


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Forked Stage 3 -- download and index Lichess puzzles."
    )
    p.add_argument("username", help="Username whose scaler/reducer to use (must have run Stage 2 first)")
    p.add_argument("--puzzles",    type=int, default=100_000, help="Max puzzles to download (default 100000)")
    p.add_argument("--min-rating", type=int, default=800,  help="Minimum puzzle rating (default 800)")
    p.add_argument("--max-rating", type=int, default=2800, help="Maximum puzzle rating (default 2800)")
    p.add_argument("--output",     type=Path, default=PUZZLE_DIR, help="Output directory for index files")
    p.add_argument(
        "--scaler",  type=Path, default=None,
        help="Path to scaler.pkl (default: data/output/<username>_scaler.pkl)"
    )
    p.add_argument(
        "--reducer", type=Path, default=None,
        help="Path to reducer.pkl (default: data/output/<username>_reducer.pkl)"
    )
    return p


def main() -> None:
    args = build_parser().parse_args()

    scaler_path  = args.scaler  or (DATA_DIR / "output" / f"{args.username}_scaler.pkl")
    reducer_path = args.reducer or (DATA_DIR / "output" / f"{args.username}_reducer.pkl")

    if not scaler_path.exists():
        print(f"Scaler not found: {scaler_path}")
        print(f"Run Stage 2 first:  python scripts/run_clustering.py {args.username}")
        sys.exit(1)

    if not reducer_path.exists():
        print(f"Reducer not found: {reducer_path}")
        print(f"Run Stage 2 first:  python scripts/run_clustering.py {args.username}")
        sys.exit(1)

    index_path = build_puzzle_index(
        scaler_path=scaler_path,
        reducer_path=reducer_path,
        max_puzzles=args.puzzles,
        output_dir=args.output,
        min_rating=args.min_rating,
        max_rating=args.max_rating,
    )
    print(f"\nDone. Index ready at {index_path}")


if __name__ == "__main__":
    main()
