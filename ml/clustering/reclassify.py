"""
Re-classify a user's saved Stage-1 events with the current classifier and
rebuild the Stage-2 profile — without re-running Stockfish.

Works on v2 files (mistakes / peer_mistakes / opportunities carry fen_after,
reply_line and the mechanism tag). Pre-v2 files lack those fields: re-run
ingestion instead; annotations are cached per game, so that is also cheap.

Usage:
    python -m ml.clustering.reclassify ShahuPatil27
    python -m ml.clustering.reclassify ShahuPatil27 --output-dir data/bench
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from ml.config import DATA_DIR
from ml.ingestion.mistake_extractor import MistakeEvent, Opportunity, link_cascades
from ml.ingestion.classify_events import classify_events

OUTPUT_DIR = DATA_DIR / "output"


def _load(path: Path, cls):
    if not path.exists():
        return []
    fields = cls.__dataclass_fields__
    return [cls(**{k: v for k, v in d.items() if k in fields}) for d in json.loads(path.read_text(encoding="utf-8"))]


def reclassify_mistakes(username: str, output_dir: Path = OUTPUT_DIR, rebuild_profile: bool = True) -> int:
    """Relabel the user's saved events in place; returns how many user
    mistakes changed family. Rebuilds clusters/profile unless told not to."""
    from ml.pipeline import default_classifier
    from ml.clustering.profile_pipeline import run_clustering

    mp = output_dir / f"{username}_mistakes.json"
    if not mp.exists():
        print(f"  [reclassify] {mp} not found — run Stage 1 first.")
        return 0
    mistakes = _load(mp, MistakeEvent)
    if mistakes and not any(m.fen_after for m in mistakes):
        print(f"  [reclassify] {username}: pre-v2 file (no engine lines). Re-run ingestion; "
              "annotations are cached so only new games hit Stockfish.")
        return 0
    peers = _load(output_dir / f"{username}_peer_mistakes.json", MistakeEvent)
    opps = _load(output_dir / f"{username}_opportunities.json", Opportunity)
    before = {m.event_id: m.cluster_id for m in mistakes}

    for m in mistakes + peers:
        m.cascade, m.incident_id = False, m.event_id or m.incident_id
    classify_events(mistakes + peers, opps, default_classifier())
    link_cascades(mistakes + peers)

    for name, rows in (("peer_mistakes", peers), ("opportunities", opps)):
        (output_dir / f"{username}_{name}.json").write_text(
            json.dumps([asdict(r) for r in rows], indent=1, default=str), encoding="utf-8")
    if rebuild_profile:
        run_clustering(mistakes, username, output_dir=output_dir)     # also re-saves mistakes
    else:
        mp.write_text(json.dumps([asdict(m) for m in mistakes], indent=1, default=str), encoding="utf-8")
    changed = sum(1 for m in mistakes if before.get(m.event_id) != m.cluster_id)
    print(f"  Re-classified {username}: {len(mistakes)} mistakes ({changed} changed family), "
          f"{len(peers)} peer mistakes, {len(opps)} opportunities")
    return changed


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("usernames", nargs="+")
    ap.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    args = ap.parse_args()
    for uname in args.usernames:
        reclassify_mistakes(uname, args.output_dir)
