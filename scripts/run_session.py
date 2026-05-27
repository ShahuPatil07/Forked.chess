#!/usr/bin/env python
"""
Stage-3 CLI: build and run a drill session for a user.

Usage:
    python scripts/run_session.py ShahuPatil07
    python scripts/run_session.py ShahuPatil07 --elo 1400 --puzzles 12
    python scripts/run_session.py ShahuPatil07 --all-clusters   # ignore SRS schedule
"""
import argparse
import json
import sys
import time
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from ml.config import DATA_DIR
from ml.clustering.blindspot import BlindspotCluster
from ml.srs.session import build_session, record_session_results


def load_clusters(path: Path) -> list[BlindspotCluster]:
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    clusters = []
    for d in raw:
        clusters.append(BlindspotCluster(**{
            k: v for k, v in d.items()
            if k in BlindspotCluster.__dataclass_fields__
        }))
    return clusters


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Pawnprint Stage 3 -- run a blindspot drill session."
    )
    p.add_argument("username", help="Username (must have run Stage 2 and Stage 3 import)")
    p.add_argument("--elo",      type=int, default=1500, help="Your rating (for puzzle difficulty matching)")
    p.add_argument("--puzzles",  type=int, default=12,   help="Number of puzzles in the session")
    p.add_argument("--all-clusters", action="store_true", help="Ignore SRS schedule; pull from all clusters")
    p.add_argument(
        "--clusters", type=Path, default=None,
        help="Path to clusters JSON (default: data/output/<username>_clusters.json)"
    )
    return p


def _fmt_moves(moves_str: str) -> str:
    """Format UCI move sequence for display. First move is opponent's; rest is solution."""
    parts = moves_str.strip().split()
    if len(parts) <= 1:
        return moves_str
    trigger = parts[0]
    solution = " -> ".join(parts[1:])
    return f"Opponent played: {trigger}  |  Solution: {solution}"


def main() -> None:
    args = build_parser().parse_args()

    clusters_path = args.clusters or (DATA_DIR / "output" / f"{args.username}_clusters.json")
    if not clusters_path.exists():
        print(f"Clusters file not found: {clusters_path}")
        print(f"Run Stage 2 first:  python scripts/run_clustering.py {args.username}")
        sys.exit(1)

    clusters = load_clusters(clusters_path)
    print(f"Loaded {len(clusters)} blindspot clusters for {args.username}")

    print(f"\nBuilding session ({args.puzzles} puzzles, ELO {args.elo})...")
    session = build_session(
        username=args.username,
        clusters=clusters,
        user_elo=args.elo,
        n_puzzles=args.puzzles,
        due_only=not args.all_clusters,
    )

    if not session:
        print(
            "\nNo puzzles found. Make sure you have run:\n"
            "  python scripts/run_puzzle_import.py " + args.username
        )
        sys.exit(1)

    print(f"\n{'='*60}")
    print(f"  Drill session for {args.username}")
    print(f"  {len(session)} puzzles  |  ELO band: {args.elo - 200}-{args.elo + 200}")
    print(f"{'='*60}\n")

    attempt_log: list[tuple[str, bool, float]] = []

    for i, item in enumerate(session, 1):
        print(f"Puzzle {i}/{len(session)}")
        print(f"  Blindspot #{item.blindspot_rank}: {item.cluster_label}  (missed {item.missed_count} times)")
        print(f"  Rating: {item.puzzle.rating}  |  Themes: {item.puzzle.themes}")
        print(f"  FEN: {item.puzzle.fen}")
        print(f"  Moves: {_fmt_moves(item.puzzle.moves)}")
        if item.puzzle.game_url:
            print(f"  Game: {item.puzzle.game_url}")
        print()

        # Simulate interactive solve (CLI mode — just prompt correct/wrong)
        start = time.time()
        ans = input("  Did you solve it? [y/n/skip]: ").strip().lower()
        elapsed = time.time() - start

        if ans == "skip":
            print("  Skipped.\n")
            continue
        correct = ans == "y"
        attempt_log.append((item.cluster_id, correct, elapsed))

        if correct:
            print(f"  Correct! ({elapsed:.0f}s)\n")
        else:
            print(f"  Incorrect. The solution was: {_fmt_moves(item.puzzle.moves)}\n")

    if attempt_log:
        record_session_results(args.username, attempt_log)
        n_correct = sum(1 for _, c, _ in attempt_log if c)
        print(f"\n{'='*60}")
        print(f"  Session complete: {n_correct}/{len(attempt_log)} correct")
        print(f"  SRS state updated. Run again tomorrow for next review.")
        print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
