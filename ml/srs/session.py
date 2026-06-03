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
from dataclasses import dataclass
from pathlib import Path

from ml.puzzles.retriever import PuzzleResult, get_index
from ml.srs.scheduler import SRSState

DATA_DIR = Path(__file__).parent.parent.parent / "data" / "output"
SEEN_DIR = Path(__file__).parent.parent.parent / "data" / "seen"

# Rating band around user ELO for puzzle matching
ELO_BAND = 200


@dataclass
class SessionItem:
    cluster_id:    str
    cluster_label: str
    puzzle:        PuzzleResult
    # Context shown in the UI: "Your #1 blindspot — missed N times"
    blindspot_rank: int
    missed_count:   int


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
    clusters:  list,               # list[BlindspotCluster] — each cluster IS a blindspot family
    user_elo:  int = 1500,
    n_puzzles: int = 12,
    due_only:  bool = True,        # False = ignore SRS schedule, always include top families
) -> list[SessionItem]:
    """
    Build a drill session over the user's blindspot FAMILIES (Stage 2/3).

    Each cluster is a fixed family with a known set of Lichess themes. We
    allocate the puzzle budget across families proportional to their blindspot
    score (frequency × recency × severity) via `allocate_puzzles`, then pull
    that many unseen puzzles per family by theme. SRS mastery + seen-tracking
    are preserved; the positional `unclassified` family is excluded (no tactical
    puzzles train positional play).
    """
    if not clusters:
        return []

    from ml.clustering.profile_pipeline import allocate_puzzles

    srs = SRSState(username)
    srs.sync_clusters(clusters)

    # Respect SRS scheduling: keep only families that are due (unless due_only=False).
    if due_only:
        due_ids = {cs.cluster_id for cs in srs.due_clusters()}
        eligible_clusters = [c for c in clusters if str(c.cluster_id) in due_ids] or clusters[:5]
    else:
        eligible_clusters = clusters

    # Score-weighted puzzle budget per family (positional/unclassified excluded).
    plan = allocate_puzzles(eligible_clusters, total=n_puzzles)
    if not plan:
        return []

    cluster_rank = {str(c.cluster_id): i + 1 for i, c in enumerate(clusters)}
    cluster_size = {str(c.cluster_id): c.size for c in clusters}

    seen = _load_seen(username)
    index = get_index()

    min_rating = max(600,  user_elo - ELO_BAND)
    max_rating = min(3000, user_elo + ELO_BAND)

    session_items: list[SessionItem] = []
    # Highest-score families first so the user drills their biggest leak first.
    for family_key, spec in sorted(plan.items(), key=lambda kv: -kv[1]["score"]):
        want = spec["n_puzzles"]
        if want <= 0:
            continue
        results = index.query_by_themes(
            themes=spec["themes"],
            min_rating=min_rating,
            max_rating=max_rating,
            seen_ids=seen,
            top_k=want * 3,          # over-fetch; we filter seen + cap below
        )
        added = 0
        for puzzle in results:
            if added >= want or len(session_items) >= n_puzzles:
                break
            if puzzle.puzzle_id in seen:
                continue
            seen.add(puzzle.puzzle_id)
            session_items.append(SessionItem(
                cluster_id=family_key,
                cluster_label=spec["name"],
                puzzle=puzzle,
                blindspot_rank=cluster_rank.get(family_key, 0),
                missed_count=cluster_size.get(family_key, 0),
            ))
            added += 1

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
