"""
Re-classify threat types in existing mistakes.json files using the improved
11-type classifier — without re-running the slow Stage 1 annotation pipeline.

Usage:
    python -m ml.clustering.reclassify ShahuPatil07
    python -m ml.clustering.reclassify ShahuPatil07 ShahuPatil27

After running this, re-run Stage 2 clustering for the updated profiles:
    python -m ml.clustering.pipeline ShahuPatil07   (or via the backend ingest endpoint)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from ml.config import DATA_DIR
from ml.ingestion.threat_classifier import classify_threat

OUTPUT_DIR = DATA_DIR / "output"


def reclassify_mistakes(username: str, output_dir: Path = OUTPUT_DIR) -> int:
    """
    Load {username}_mistakes.json, re-apply the improved classifier to every
    event, and save the file in-place.

    Returns the number of events whose threat_type changed.
    """
    path = output_dir / f"{username}_mistakes.json"
    if not path.exists():
        print(f"  [reclassify] {path} not found — run Stage 1 first.")
        return 0

    with open(path, encoding="utf-8") as fh:
        mistakes: list[dict] = json.load(fh)

    changed = 0
    type_counts: dict[str, int] = {}

    for m in mistakes:
        fen      = m.get("fen", "")
        best_uci = m.get("best_move_uci", "")
        old_type = m.get("threat_type", "other")
        new_type = classify_threat(fen, best_uci)

        if new_type != old_type:
            m["threat_type"] = new_type
            changed += 1

        type_counts[new_type] = type_counts.get(new_type, 0) + 1

    with open(path, "w", encoding="utf-8") as fh:
        json.dump(mistakes, fh, indent=2, default=str)

    total = len(mistakes)
    print(f"\n  Re-classified {username}: {total} events, {changed} changed")
    print(f"  Threat type breakdown:")
    for t, cnt in sorted(type_counts.items(), key=lambda x: -x[1]):
        bar = "#" * min(30, int(cnt / total * 60))
        print(f"    {t:<22}  {cnt:>4}  ({cnt/total*100:4.1f}%)  {bar}")

    return changed


if __name__ == "__main__":
    usernames = sys.argv[1:]
    if not usernames:
        print("Usage: python -m ml.clustering.reclassify <username> [<username2> ...]")
        sys.exit(1)

    for uname in usernames:
        reclassify_mistakes(uname)
    print("\nDone. Re-run Stage 2 clustering to update blindspot profiles.")
