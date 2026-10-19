"""
Stage-2 drop-in: a `run_clustering`-compatible entry point backed by the
fixed-family, peer-relative profile (ml/clustering/profile.py).

Same signature and output contract as before (returns `list[BlindspotCluster]`,
sets each `MistakeEvent.cluster_id`, writes `{user}_clusters.json`,
`{user}_profile.json`, re-persists `{user}_mistakes.json`). It additionally reads
the Stage-1 v2 side files when present — `{user}_peer_mistakes.json` (opponents'
mistakes = the rating-matched baseline), `{user}_opportunities.json` (tactics
found / missed) and `{user}_exposure.json` (moves per game) — and degrades
gracefully to a per-user profile without them.

A mistake's cluster is its top family (`family_probs`), which Stage 1 keeps
consistent with `family_of(threat_type)`, so every consumer that matches on
`family_of(threat_type)` (live sync, debrief, replay) agrees.
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


def _read(output_dir: Optional[Path], username: str, suffix: str):
    if not output_dir:
        return None
    p = Path(output_dir) / f"{username}_{suffix}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def run_clustering(
    mistakes:   list[MistakeEvent],
    username:   str,
    output_dir: Optional[Path] = None,
    peer_mistakes: Optional[list] = None,
    opportunities: Optional[list] = None,
    exposure: Optional[list[dict]] = None,
    **_compat,                     # accepts/ignores n_components, min_cluster_size, groq_api_key
) -> list[BlindspotCluster]:
    """Build the user's blindspot-family profile. `mistakes` must already carry
    Stage-1 labels (threat_type / family_probs)."""
    peer_mistakes = peer_mistakes if peer_mistakes is not None else (_read(output_dir, username, "peer_mistakes") or [])
    opportunities = opportunities if opportunities is not None else (_read(output_dir, username, "opportunities") or [])
    exposure = exposure if exposure is not None else _read(output_dir, username, "exposure")

    # Project every mistake onto its family (the cluster_id the product reads).
    for m in mistakes:
        fp = getattr(m, "family_probs", None) or {}
        m.cluster_id = max(fp, key=fp.get) if fp else family_of(m.threat_type)
        if family_of(m.threat_type) != m.cluster_id:
            m.cluster_id = family_of(m.threat_type)

    profile = build_profile(mistakes, username, peer_mistakes, opportunities, exposure)
    clusters = profile["clusters"]

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
            json.dumps([asdict(m) for m in mistakes], indent=1, default=str), encoding="utf-8")
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
    to each family's blindspot score (excess + impact, points per 10 games).
    The `unclassified` family is excluded (no tactical puzzles train positional play).

    Returns {family_key: {"name", "n_puzzles", "themes"}} ready for Stage 3 to
    query the Lichess puzzle DB by `themes`.
    """
    themes_by_family = family_lichess_themes()
    ranked = sorted(clusters, key=lambda c: c.score, reverse=True)
    if top_k:
        ranked = ranked[:top_k]
    ranked = [c for c in ranked if c.score > 0]
    total_score = sum(c.score for c in ranked) or 1.0

    out: dict[str, dict] = {}
    for c in ranked:
        fam = str(c.cluster_id) if str(c.cluster_id) in themes_by_family else family_of(c.dominant_threat_type)
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
