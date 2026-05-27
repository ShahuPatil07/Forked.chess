"""
Session builder — assembles a drill session of N puzzles from the puzzle index,
weighted by each cluster's blindspot urgency score.

Usage:
    session = build_session(
        username="ShahuPatil07",
        clusters=clusters,          # list[BlindspotCluster]
        user_elo=1400,
        n_puzzles=12,
    )
    for item in session:
        print(item.cluster_label, item.puzzle.puzzle_id, item.puzzle.fen)
"""
from __future__ import annotations

import json
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

from ml.puzzles.retriever import PuzzleResult, get_index
from ml.srs.scheduler import SRSState, ClusterState

DATA_DIR = Path(__file__).parent.parent.parent / "data" / "output"
SEEN_DIR = Path(__file__).parent.parent.parent / "data" / "seen"

# Rating band around user ELO for puzzle matching
ELO_BAND = 200
# Temperature for softmax weighting (higher = concentrate on top cluster)
TEMPERATURE = 2.0


@dataclass
class SessionItem:
    cluster_id:    str
    cluster_label: str
    puzzle:        PuzzleResult
    # Context shown in the UI: "Your #1 blindspot — missed N times"
    blindspot_rank: int
    missed_count:   int


def _softmax(scores: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    s = scores * temperature
    s = s - s.max()
    e = np.exp(s)
    return e / e.sum()


def _load_seen(username: str) -> set[str]:
    path = SEEN_DIR / f"{username}_seen.json"
    if path.exists():
        with open(path, encoding="utf-8") as fh:
            return set(json.load(fh))
    return set()


def _save_seen(username: str, seen: set[str]) -> None:
    SEEN_DIR.mkdir(parents=True, exist_ok=True)
    path = SEEN_DIR / f"{username}_seen.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(list(seen), fh)


def build_session(
    username:  str,
    clusters:  list,               # list[BlindspotCluster]
    user_elo:  int = 1500,
    n_puzzles: int = 12,
    due_only:  bool = True,        # False = ignore SRS schedule, always include top clusters
) -> list[SessionItem]:
    """
    Build a drill session.

    Clusters are weighted by urgency score via softmax. For each slot, we
    sample a cluster (with replacement allowed) then retrieve the nearest
    unseen puzzle for that cluster from the index.
    """
    if not clusters:
        return []

    srs = SRSState(username)
    srs.sync_clusters(clusters)

    if due_only:
        eligible = srs.due_clusters()
        if not eligible:
            print("All clusters are ahead of schedule. Using top clusters anyway.")
            eligible = srs.all_clusters()[:5]
    else:
        eligible = srs.all_clusters()

    scores = np.array([cs.score for cs in eligible], dtype=np.float64)
    if scores.sum() == 0:
        scores = np.ones(len(eligible))
    weights = _softmax(scores, TEMPERATURE)

    # cluster_id -> BlindspotCluster (for centroid lookup)
    cluster_map = {str(c.cluster_id): c for c in clusters}
    # cluster rank (1-indexed, already sorted by score desc)
    cluster_rank = {str(c.cluster_id): i + 1 for i, c in enumerate(clusters)}

    seen = _load_seen(username)
    index = get_index()

    min_rating = max(600,  user_elo - ELO_BAND)
    max_rating = min(3000, user_elo + ELO_BAND)

    session_items: list[SessionItem] = []
    tries = 0
    max_tries = n_puzzles * 5

    while len(session_items) < n_puzzles and tries < max_tries:
        tries += 1
        # Sample a cluster
        cs: ClusterState = random.choices(eligible, weights=weights, k=1)[0]
        cluster = cluster_map.get(cs.cluster_id)
        if cluster is None:
            continue

        centroid = cluster.centroid

        results = index.query(
            centroid=centroid,
            threat_type=cluster.dominant_threat_type,
            min_rating=min_rating,
            max_rating=max_rating,
            seen_ids=seen,
            top_k=10,
        )

        if not results:
            continue

        # Pick the closest unseen puzzle
        puzzle = results[0]
        if puzzle.puzzle_id in seen:
            continue

        seen.add(puzzle.puzzle_id)
        session_items.append(SessionItem(
            cluster_id=cs.cluster_id,
            cluster_label=cs.label,
            puzzle=puzzle,
            blindspot_rank=cluster_rank.get(cs.cluster_id, 0),
            missed_count=cs.size,
        ))

    _save_seen(username, seen)
    return session_items


def record_session_results(
    username: str,
    results: list[tuple[str, bool, float]],  # (cluster_id, correct, time_s)
) -> None:
    """Persist SRS updates after a completed session."""
    srs = SRSState(username)
    for cluster_id, correct, time_s in results:
        try:
            srs.record_attempt(cluster_id, correct, time_s)
        except KeyError:
            pass
    srs.save()
