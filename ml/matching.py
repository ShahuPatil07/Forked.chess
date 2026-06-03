"""
Cluster matching — map a fresh MistakeEvent to an existing blindspot cluster.

Stage 2 is now a deterministic blindspot-FAMILY profile (no UMAP/HDBSCAN). A
cluster IS a family, and a mistake's cluster is simply `family_of(threat_type)`
— there is no embedding to project, no scaler/reducer, no cosine threshold.

This module keeps its original public API (`load_match_context`, `match_events`,
`match_event`, `assign_nearest`, `MatchContext`, `MatchResult`) so the consumers
— live_sync (alerts), replay, counterfactual, bot-game debrief — need no change.
Internally it now matches on family key instead of centroid distance.

Each MistakeEvent must already carry `threat_type` from Stage 1 (the transformer,
set during ingestion). A confident match = the event's family is one of the
user's existing blindspot clusters; the only "unmatched" case is the
`unclassified` (positional) family, which is never a tactical cluster.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from ml.clustering.families import family_of, UNCLASSIFIED

log = logging.getLogger(__name__)

# Kept for API compatibility; family matching is exact, so this is effectively 1.0.
MATCH_THRESHOLD = 0.72


@dataclass
class MatchContext:
    """Family-based cluster context for a user. `clusters` are the raw cluster
    dicts from {username}_clusters.json; each cluster_id is a family key."""
    clusters:    list[dict]
    family_to_i: dict[str, int]          # family key -> index in `clusters`


@dataclass
class MatchResult:
    cluster_id:   Optional[object]       # family key, or None if unmatched
    cluster_rank: Optional[int]
    similarity:   float                  # 1.0 for an exact family match, else 0.0
    matched:      bool


def load_match_context(username: str, output_dir: Path) -> Optional[MatchContext]:
    """Load the user's blindspot clusters. None if no profile exists yet.

    No scaler / reducer needed any more — the profile is family-based."""
    clusters_path = output_dir / f"{username}_clusters.json"
    if not clusters_path.exists():
        return None
    try:
        with open(clusters_path, encoding="utf-8") as fh:
            clusters = json.load(fh)
        if not clusters:
            return None
        family_to_i = {str(c.get("cluster_id")): i for i, c in enumerate(clusters)}
        return MatchContext(clusters=clusters, family_to_i=family_to_i)
    except Exception as exc:
        log.warning("Could not load match context for %s: %s", username, exc)
        return None


def _family_for(event) -> str:
    """A fresh event's family = family_of(its Stage-1 threat_type)."""
    return family_of(getattr(event, "threat_type", "") or "other")


def match_events(events: list, ctx: MatchContext) -> list[MatchResult]:
    """
    For each event, match to the user's existing cluster whose family it belongs
    to. The positional `unclassified` family is treated as unmatched (it is never
    a tactical blindspot cluster), mirroring the old "below threshold" behaviour.
    """
    out: list[MatchResult] = []
    for ev in events:
        fam = _family_for(ev)
        idx = ctx.family_to_i.get(fam)
        if fam == UNCLASSIFIED or idx is None:
            out.append(MatchResult(None, None, 0.0, False))
            continue
        c = ctx.clusters[idx]
        out.append(MatchResult(
            cluster_id   = c.get("cluster_id"),
            cluster_rank = c.get("rank", idx + 1),
            similarity   = 1.0,
            matched      = True,
        ))
    return out


def match_event(event, ctx: MatchContext) -> MatchResult:
    """Convenience wrapper for a single event."""
    return match_events([event], ctx)[0]


def assign_nearest(events: list, ctx: MatchContext) -> list[tuple[int, float]]:
    """
    Assign every event to its family's cluster index, with NO threshold.
    Returns [(cluster_index, similarity), ...]; index = -1 if the event's family
    isn't one of the user's clusters (e.g. positional/unclassified).

    Used by Mistake Replay / counterfactual to regroup the user's own mistakes —
    same return contract as before, now exact by family.
    """
    out: list[tuple[int, float]] = []
    for ev in events:
        fam = _family_for(ev)
        idx = ctx.family_to_i.get(fam)
        out.append((idx, 1.0) if idx is not None else (-1, 0.0))
    return out
