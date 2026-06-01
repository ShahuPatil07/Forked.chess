"""
Cluster matching — map a fresh MistakeEvent to an existing blindspot cluster.

Blindspot clusters are identified ONLY by their cluster_id and centroid
vector. Centroids live in the 16-dim UMAP space, so a new mistake must be
projected through the SAME persisted StandardScaler + UMAP reducer before
comparing. The LLM label is never used for matching.

A match requires cosine similarity > MATCH_THRESHOLD (0.72). Below that the
mistake is genuinely unmatched — caller must NOT force the closest cluster.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

from ml.clustering.feature_extractor import extract_features

log = logging.getLogger(__name__)

MATCH_THRESHOLD = 0.72


@dataclass
class MatchContext:
    scaler:    object
    reducer:   object
    clusters:  list[dict]          # raw cluster dicts from {username}_clusters.json
    centroids: np.ndarray          # (K, 16)


@dataclass
class MatchResult:
    cluster_id:   Optional[object]  # None if unmatched
    cluster_rank: Optional[int]
    similarity:   float             # best similarity (even if below threshold)
    matched:      bool


def load_match_context(username: str, output_dir: Path) -> Optional[MatchContext]:
    """Load the persisted scaler, reducer and clusters for a user. None if absent."""
    clusters_path = output_dir / f"{username}_clusters.json"
    scaler_path   = output_dir / f"{username}_scaler.pkl"
    reducer_path  = output_dir / f"{username}_reducer.pkl"

    if not (clusters_path.exists() and scaler_path.exists() and reducer_path.exists()):
        return None

    try:
        import joblib
        with open(clusters_path, encoding="utf-8") as fh:
            clusters = json.load(fh)
        if not clusters:
            return None
        scaler  = joblib.load(scaler_path)
        reducer = joblib.load(reducer_path)
        centroids = np.array([c["centroid"] for c in clusters], dtype=np.float64)
        return MatchContext(scaler=scaler, reducer=reducer, clusters=clusters, centroids=centroids)
    except Exception as exc:
        log.warning("Could not load match context for %s: %s", username, exc)
        return None


def _project(events: list, ctx: MatchContext) -> np.ndarray:
    """122-dim features → scaler → UMAP → (N, 16)."""
    X = extract_features(events)                 # (N, 122)
    Xs = ctx.scaler.transform(X)
    Xr = np.asarray(ctx.reducer.transform(Xs), dtype=np.float64)   # (N, 16)
    return Xr


def _cosine_to_centroids(vec: np.ndarray, centroids: np.ndarray) -> np.ndarray:
    eps = 1e-9
    v = vec / (np.linalg.norm(vec) + eps)
    C = centroids / (np.linalg.norm(centroids, axis=1, keepdims=True) + eps)
    return C @ v                                  # (K,)


def match_events(events: list, ctx: MatchContext) -> list[MatchResult]:
    """
    For each event return the best-matching cluster (by centroid cosine) only
    if similarity > MATCH_THRESHOLD, else an unmatched result. Never forces a
    match.
    """
    if not events or ctx.centroids.size == 0:
        return [MatchResult(None, None, 0.0, False) for _ in events]

    projected = _project(events, ctx)
    out: list[MatchResult] = []
    for vec in projected:
        sims = _cosine_to_centroids(vec, ctx.centroids)
        bi   = int(np.argmax(sims))
        best = float(sims[bi])
        if best > MATCH_THRESHOLD:
            c = ctx.clusters[bi]
            out.append(MatchResult(
                cluster_id   = c.get("cluster_id"),
                cluster_rank = c.get("rank", bi + 1),
                similarity   = best,
                matched      = True,
            ))
        else:
            out.append(MatchResult(None, None, best, False))
    return out


def match_event(event, ctx: MatchContext) -> MatchResult:
    """Convenience wrapper for a single event."""
    return match_events([event], ctx)[0]


def assign_nearest(events: list, ctx: MatchContext) -> list[tuple[int, float]]:
    """
    Assign every event to its NEAREST cluster by centroid cosine, with NO
    threshold. Returns [(cluster_index, similarity), ...].

    Used by Mistake Replay: these events are the user's own mistakes that
    originally formed the clusters, so we want the full grouping back —
    not the confident-repeat filter that live-sync uses.
    """
    if not events or ctx.centroids.size == 0:
        return [(-1, 0.0) for _ in events]
    projected = _project(events, ctx)
    out: list[tuple[int, float]] = []
    for vec in projected:
        sims = _cosine_to_centroids(vec, ctx.centroids)
        bi = int(np.argmax(sims))
        out.append((bi, float(sims[bi])))
    return out
