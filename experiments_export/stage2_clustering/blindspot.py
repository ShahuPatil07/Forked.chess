"""
BlindspotCluster — the core output of Stage 2.

One cluster = one recurring failure pattern for a user, identified by HDBSCAN
on the 16-dim UMAP embedding of mistake-event feature vectors.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from ml.ingestion.mistake_extractor import MistakeEvent

_RECENCY_LAMBDA = 0.05   # decay per day; half-life ≈ 14 days


@dataclass
class BlindspotCluster:
    cluster_id:           int
    user_id:              str
    label:                str          # LLM-generated name, e.g. "Back-rank threats"
    size:                 int          # number of mistake events assigned
    centroid:             list[float]  # 16-dim UMAP centroid (stored as list for JSON)
    dominant_threat_type: str
    dominant_game_phase:  str
    mastery:              float        # 0.0–1.0, starts at 0 (no puzzle data yet)
    last_occurrence_unix: Optional[int]   # Unix timestamp of most recent event
    next_review_unix:     Optional[int]   # filled by SRS scheduler
    score:                float        # frequency × recency_weight × (1 – mastery)
    representative_events: list[dict]  # 5 closest events to centroid (serialisable)


def build_cluster(
    cluster_id:  int,
    user_id:     str,
    events:      list[MistakeEvent],
    centroid:    np.ndarray,
    all_events:  list[MistakeEvent],
) -> BlindspotCluster:
    """
    Construct a BlindspotCluster from the raw HDBSCAN assignment.

    `events`     — all mistake events assigned to this cluster
    `centroid`   — 16-dim UMAP centroid of this cluster
    `all_events` — full set of user mistakes (for frequency calculation)
    """
    from collections import Counter
    dominant_threat = Counter(e.threat_type for e in events).most_common(1)[0][0]
    dominant_phase  = Counter(e.game_phase  for e in events).most_common(1)[0][0]

    # Most recent occurrence
    timestamps  = [e.played_at_unix for e in events if e.played_at_unix]
    last_ts     = max(timestamps) if timestamps else None

    # Score formula from spec
    frequency       = len(events) / max(len(all_events), 1)
    recency_weight  = _recency(last_ts)
    score           = frequency * recency_weight * 1.0   # mastery=0 at start

    return BlindspotCluster(
        cluster_id=cluster_id,
        user_id=user_id,
        label=f"Cluster {cluster_id}",   # placeholder until LLM labels it
        size=len(events),
        centroid=centroid.tolist(),
        dominant_threat_type=dominant_threat,
        dominant_game_phase=dominant_phase,
        mastery=0.0,
        last_occurrence_unix=last_ts,
        next_review_unix=None,
        score=round(score, 4),
        representative_events=[_event_summary(e) for e in events[:5]],
    )


def recompute_score(cluster: BlindspotCluster) -> float:
    """Recompute score using current mastery and recency."""
    frequency      = 1.0   # relative — caller scales by total_mistakes / cluster.size
    recency_weight = _recency(cluster.last_occurrence_unix)
    return frequency * recency_weight * (1.0 - cluster.mastery)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _recency(last_unix: Optional[int]) -> float:
    if last_unix is None:
        return 0.5   # unknown recency → neutral weight
    days_ago = (time.time() - last_unix) / 86_400
    return math.exp(-_RECENCY_LAMBDA * days_ago)


def _event_summary(e: MistakeEvent) -> dict:
    return {
        "fen":            e.fen,
        "move_played":    e.move_played_san,
        "best_move":      e.best_move_uci,
        "eval_drop_cp":   e.eval_drop_cp,
        "threat_type":    e.threat_type,
        "game_phase":     e.game_phase,
        "move_number":    e.move_number,
        "maia2_surprise": e.maia2_surprise,    # None when Maia2 wasn't run
        "maia2_difficulty": e.maia2_difficulty,
    }
