"""
Spaced repetition scheduler.

Per-cluster mastery state lives in data/output/<username>_srs.json.
Algorithm: SM-2 variant with cluster-wide mastery (not per-card).

Mastery updates after each puzzle attempt:
  correct + fast  -> mastery += 0.05,  interval *= ease_factor (2.5)
  correct + slow  -> mastery += 0.02,  interval *= 1.5
  wrong           -> mastery -= 0.03,  interval = 1 day (reset)

Mastery is clamped to [0, 1].
Scores are re-computed on load so they reflect recent game activity.
"""
from __future__ import annotations

import json
import math
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

DATA_DIR = Path(__file__).parent.parent.parent / "data" / "output"

# A "fast" solve is under this many seconds
FAST_THRESHOLD_S = 30


@dataclass
class ClusterState:
    cluster_id:    str
    label:         str
    mastery:       float           # 0.0 -> 1.0
    interval_days: float           # SM-2 interval
    ease_factor:   float           # SM-2 ease
    last_review:   Optional[int]   # unix timestamp
    next_review:   Optional[int]   # unix timestamp
    score:         float           # urgency score from clustering
    size:          int             # number of mistake events


def _now() -> int:
    return int(time.time())


def _days_until(ts: Optional[int]) -> float:
    if ts is None:
        return 0.0
    return max(0.0, (ts - _now()) / 86400)


class SRSState:
    """
    Loads and persists per-user cluster mastery state.
    One SRSState per user — call save() after any update.
    """

    def __init__(self, username: str, data_dir: Path = DATA_DIR):
        self._path = data_dir / f"{username}_srs.json"
        self._clusters: dict[str, ClusterState] = {}
        self._load()

    def _load(self) -> None:
        if self._path.exists():
            with open(self._path, encoding="utf-8") as fh:
                raw = json.load(fh)
            for d in raw:
                cs = ClusterState(**d)
                self._clusters[cs.cluster_id] = cs

    def save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with open(self._path, "w", encoding="utf-8") as fh:
            json.dump(
                [asdict(cs) for cs in self._clusters.values()],
                fh, indent=2,
            )

    def sync_clusters(self, clusters: list) -> None:
        """
        Merge BlindspotCluster list into SRS state.
        New clusters get default state; existing ones keep their mastery/interval.
        """
        for c in clusters:
            cid = str(c.cluster_id)
            if cid not in self._clusters:
                self._clusters[cid] = ClusterState(
                    cluster_id=cid,
                    label=c.label,
                    mastery=0.0,
                    interval_days=1.0,
                    ease_factor=2.5,
                    last_review=None,
                    next_review=None,
                    score=c.score,
                    size=c.size,
                )
            else:
                # Update label + score in case clustering was re-run
                self._clusters[cid].label = c.label
                self._clusters[cid].score = c.score
                self._clusters[cid].size  = c.size

    def due_clusters(self) -> list[ClusterState]:
        """Return clusters whose next_review <= now, sorted by urgency (score desc)."""
        now = _now()
        due = [
            cs for cs in self._clusters.values()
            if cs.next_review is None or cs.next_review <= now
        ]
        due.sort(key=lambda cs: cs.score, reverse=True)
        return due

    def all_clusters(self) -> list[ClusterState]:
        return sorted(self._clusters.values(), key=lambda cs: cs.score, reverse=True)

    def record_attempt(
        self,
        cluster_id: str,
        correct: bool,
        time_taken_s: float,
    ) -> ClusterState:
        """Update mastery + schedule next review. Returns updated state."""
        cs = self._clusters.get(cluster_id)
        if cs is None:
            raise KeyError(f"Unknown cluster_id: {cluster_id}")

        fast = time_taken_s < FAST_THRESHOLD_S

        if correct and fast:
            cs.mastery     = min(1.0, cs.mastery + 0.05)
            cs.ease_factor = min(2.5, cs.ease_factor + 0.1)
            cs.interval_days *= cs.ease_factor
        elif correct:
            cs.mastery     = min(1.0, cs.mastery + 0.02)
            cs.interval_days *= 1.5
        else:
            cs.mastery     = max(0.0, cs.mastery - 0.03)
            cs.ease_factor = max(1.3, cs.ease_factor - 0.2)
            cs.interval_days = 1.0  # reset on failure

        cs.interval_days = max(1.0, cs.interval_days)
        now = _now()
        cs.last_review = now
        cs.next_review = now + int(cs.interval_days * 86400)

        return cs

    def reset_cluster(self, cluster_id: str) -> None:
        """Call when user blunders the same pattern in a live game."""
        cs = self._clusters.get(cluster_id)
        if cs:
            cs.mastery       = max(0.0, cs.mastery - 0.10)
            cs.interval_days = 1.0
            cs.next_review   = _now()

    def get(self, cluster_id: str) -> Optional[ClusterState]:
        return self._clusters.get(cluster_id)
