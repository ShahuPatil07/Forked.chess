#!/usr/bin/env python
"""
Stage-2 CLI: cluster a user's mistake events into named blindspot patterns.

Usage:
    # First run Stage 1 to produce the mistakes JSON:
    python scripts/run_analysis.py ShahuPatil07 --platform lichess --games 100

    # Then run Stage 2:
    python scripts/run_clustering.py ShahuPatil07
    python scripts/run_clustering.py ShahuPatil07 --api-key sk-ant-...
    python scripts/run_clustering.py ShahuPatil07 --min-cluster-size 8 --games 50
"""
import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from ml.config import DATA_DIR
from ml.ingestion.mistake_extractor import MistakeEvent
from ml.clustering.pipeline import run_clustering


def load_mistakes(path: Path) -> list[MistakeEvent]:
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    mistakes = []
    for d in raw:
        # json.load gives us a plain dict — reconstruct the dataclass
        mistakes.append(MistakeEvent(**{
            k: v for k, v in d.items()
            if k in MistakeEvent.__dataclass_fields__
        }))
    return mistakes


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Forked Stage 2 — cluster mistake events into blindspot patterns."
    )
    p.add_argument("username", help="Username (must match an existing mistakes JSON file)")
    p.add_argument(
        "--input", type=Path, default=None,
        help="Path to mistakes JSON (default: data/output/<username>_mistakes.json)"
    )
    p.add_argument(
        "--output", type=Path, default=DATA_DIR / "output",
        help="Directory to save clusters JSON (default: data/output)"
    )
    p.add_argument(
        "--api-key", default=None,
        help="Anthropic API key for LLM labelling (or set ANTHROPIC_API_KEY env var)"
    )
    p.add_argument(
        "--min-cluster-size", type=int, default=15,
        help="HDBSCAN min_cluster_size (default 15; lower for fewer games)"
    )
    p.add_argument(
        "--umap-dims", type=int, default=16,
        help="UMAP output dimensions (default 16)"
    )
    return p


def main() -> None:
    args = build_parser().parse_args()

    input_path = args.input or (DATA_DIR / "output" / f"{args.username}_mistakes.json")
    if not input_path.exists():
        print(f"Mistakes file not found: {input_path}")
        print(f"Run Stage 1 first:  python scripts/run_analysis.py {args.username}")
        sys.exit(1)

    print(f"Loading mistakes from {input_path}...")
    mistakes = load_mistakes(input_path)
    print(f"Loaded {len(mistakes)} mistake events")

    api_key = args.api_key or os.environ.get("ANTHROPIC_API_KEY")

    clusters = run_clustering(
        mistakes=mistakes,
        username=args.username,
        n_components=args.umap_dims,
        min_cluster_size=args.min_cluster_size,
        api_key=api_key,
        output_dir=args.output,
    )

    if not clusters:
        sys.exit(1)

    print(f"\nDone. {len(clusters)} blindspot clusters identified.")
    print(f"Results saved to {args.output / (args.username + '_clusters.json')}")


if __name__ == "__main__":
    main()
