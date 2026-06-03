"""
Stage-2 drop-in: a `run_clustering`-compatible entry point backed by the
fixed-family profile instead of UMAP+HDBSCAN+Groq.

Same signature and output contract as `ml.clustering.pipeline.run_clustering`
(returns `list[BlindspotCluster]`, sets each `MistakeEvent.cluster_id`, writes
`{user}_clusters.json`), so it swaps in one-for-one — but it needs no scaler,
no reducer, and no LLM. The "projection" of a new mistake into cluster space is
just `family_of(threat_type)`.

Also exposes the Stage-3 helpers: how many puzzles to pull per family, and which
Lichess themes to pull them from.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from ml.ingestion.mistake_extractor import MistakeEvent
from ml.clustering.blindspot import BlindspotCluster
from ml.clustering.profile import build_profile
from ml.clustering.families import (
    family_of, family_lichess_themes, UNCLASSIFIED,
)


def run_clustering(
    mistakes:   list[MistakeEvent],
    username:   str,
    output_dir: Optional[Path] = None,
    **_compat,                     # accepts/ignores n_components, min_cluster_size, groq_api_key
) -> list[BlindspotCluster]:
    """Build the user's blindspot-family profile. `mistakes` must already carry
    `threat_type` from Stage 1 (the transformer, set during ingestion)."""
    profile = build_profile(mistakes, username)
    clusters = profile["clusters"]

    # Project every mistake onto its family (the cluster_id the product reads).
    for m in mistakes:
        m.cluster_id = family_of(m.threat_type)

    if output_dir:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / f"{username}_clusters.json").write_text(
            json.dumps([asdict(c) for c in clusters], indent=2, default=str), encoding="utf-8")
        (output_dir / f"{username}_profile.json").write_text(
            json.dumps({k: v for k, v in profile.items() if k != "clusters"},
                       indent=2, default=str), encoding="utf-8")
        # Persist mistakes with their family cluster_id so every downstream
        # consumer that filters mistakes by cluster_id (replay, counterfactual,
        # get_cluster, dashboard enrichment) resolves correctly.
        (output_dir / f"{username}_mistakes.json").write_text(
            json.dumps([asdict(m) for m in mistakes], indent=2, default=str), encoding="utf-8")
    return clusters


def assign_family(mistake: MistakeEvent) -> str:
    """Projector for a fresh mistake (replaces the saved scaler+reducer +
    nearest-centroid step). Returns the family key = its cluster_id."""
    return family_of(mistake.threat_type)


# ---------------------------------------------------------------------------
# Stage-3 helpers: which puzzles to fetch, and how many
# ---------------------------------------------------------------------------

def allocate_puzzles(
    clusters: list[BlindspotCluster],
    total:    int = 30,
    top_k:    Optional[int] = None,
) -> dict[str, dict]:
    """
    Allocate a puzzle budget across the user's blindspot families, proportional
    to each family's blindspot score (frequency x recency x severity). The
    `unclassified` family is excluded (no tactical puzzles train positional play).

    Returns {family_key: {"name", "n_puzzles", "themes"}} ready for Stage 3 to
    query the Lichess puzzle DB by `themes`.
    """
    themes_by_family = family_lichess_themes()
    # clusters are BlindspotCluster; recover the family key from its themes/label.
    # We re-derive family key from the cluster's dominant threat to stay robust.
    from ml.clustering.families import family_of as _fof
    ranked = sorted(clusters, key=lambda c: c.score, reverse=True)
    if top_k:
        ranked = ranked[:top_k]
    ranked = [c for c in ranked if c.score > 0]
    total_score = sum(c.score for c in ranked) or 1.0

    out: dict[str, dict] = {}
    for c in ranked:
        fam = _fof(c.dominant_threat_type)
        if fam == UNCLASSIFIED or fam not in themes_by_family:
            continue
        n = max(1, round(total * c.score / total_score))
        out[fam] = {
            "name": c.label,
            "n_puzzles": n,
            "themes": themes_by_family[fam],
            "score": c.score,
        }
    return out
