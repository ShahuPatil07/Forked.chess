"""
Stage-2 clustering pipeline.

Input:  list[MistakeEvent]  (output of Stage 1)
Output: list[BlindspotCluster]  (named, scored blindspot patterns)

Steps:
  1. Extract 115-dim feature vectors (111 base + 4 new threat types)
  2. StandardScaler normalisation
  3. UMAP -> 16-dim embedding  (falls back to PCA if umap-learn unavailable)
  4. HDBSCAN clustering with dynamic min_cluster_size
  5. Assign noise points (label=-1) to their nearest cluster centroid
  6. Build BlindspotCluster objects + find representatives
  7. LLM labelling via Groq API
"""
from __future__ import annotations

import json
import pickle
import warnings
from dataclasses import asdict
from pathlib import Path
from typing import Optional

import numpy as np
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import HDBSCAN

from ml.ingestion.mistake_extractor import MistakeEvent
from ml.clustering.feature_extractor import extract_features, FEATURE_DIM
from ml.clustering.blindspot import BlindspotCluster, build_cluster
from ml.clustering.labeller import label_all_clusters


# ---------------------------------------------------------------------------
# Dimensionality reduction
# ---------------------------------------------------------------------------

def _reduce(X: np.ndarray, n_components: int = 16) -> tuple[np.ndarray, object]:
    """UMAP -> 16-dim. Falls back to PCA if umap-learn is not installed."""
    try:
        import umap
        reducer = umap.UMAP(
            n_components=n_components,
            n_neighbors=min(10, len(X) - 1),  # tighter local structure than default 15
            min_dist=0.05,                     # denser clusters than default 0.1
            metric="euclidean",
            random_state=42,
            low_memory=False,
        )
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            X_reduced = reducer.fit_transform(X)
        print(f"  UMAP: {X.shape} -> {X_reduced.shape}")
        return X_reduced, reducer

    except ImportError:
        from sklearn.decomposition import PCA
        n = min(n_components, X.shape[0] - 1, X.shape[1])
        reducer = PCA(n_components=n, random_state=42)
        X_reduced = reducer.fit_transform(X)
        print(f"  PCA (umap-learn not installed): {X.shape} -> {X_reduced.shape}")
        return X_reduced, reducer


# ---------------------------------------------------------------------------
# Noise handling
# ---------------------------------------------------------------------------

def _assign_noise_to_nearest(
    labels:    np.ndarray,
    X_reduced: np.ndarray,
) -> np.ndarray:
    """
    Assign HDBSCAN noise points (label=-1) to the closest cluster centroid
    in UMAP space instead of discarding them.

    Noise events are often the player's rarest but highest-cost blindspots —
    dropping them entirely means those puzzle positions never surface in drills.
    """
    unique_labels = sorted(set(labels) - {-1})
    if not unique_labels:
        return labels  # no clusters to assign to

    centroids = {
        cid: X_reduced[labels == cid].mean(axis=0)
        for cid in unique_labels
    }

    labels = labels.copy()
    noise_indices = np.where(labels == -1)[0]

    for idx in noise_indices:
        pt = X_reduced[idx]
        nearest = min(centroids, key=lambda cid: np.linalg.norm(pt - centroids[cid]))
        labels[idx] = nearest

    return labels


# ---------------------------------------------------------------------------
# Cluster building
# ---------------------------------------------------------------------------

def _build_all_clusters(
    mistakes:  list[MistakeEvent],
    X_reduced: np.ndarray,
    labels:    np.ndarray,
    username:  str,
) -> list[BlindspotCluster]:
    unique_labels = sorted(set(labels))   # noise already reassigned, no -1
    clusters: list[BlindspotCluster] = []

    for cid in unique_labels:
        mask   = labels == cid
        events = [mistakes[i] for i, m in enumerate(mask) if m]
        pts    = X_reduced[mask]
        centroid = pts.mean(axis=0)

        # Find the 5 events closest to the centroid (in UMAP space)
        dists        = np.linalg.norm(pts - centroid, axis=1)
        top5_local   = np.argsort(dists)[:5]
        orig_indices = [i for i, m in enumerate(mask) if m]
        rep_events   = [mistakes[orig_indices[j]] for j in top5_local]

        cluster = build_cluster(
            cluster_id=cid,
            user_id=username,
            events=events,
            centroid=centroid,
            all_events=mistakes,
        )
        from ml.clustering.blindspot import _event_summary
        cluster.representative_events = [_event_summary(e) for e in rep_events]

        clusters.append(cluster)

    clusters.sort(key=lambda c: c.score, reverse=True)
    return clusters


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_clustering(
    mistakes:         list[MistakeEvent],
    username:         str,
    n_components:     int = 16,
    min_cluster_size: Optional[int] = None,   # None = auto-scaled
    groq_api_key:     Optional[str] = None,
    output_dir:       Optional[Path] = None,
) -> list[BlindspotCluster]:
    """
    Full Stage-2 pipeline.  Returns labelled, scored BlindspotCluster objects.

    min_cluster_size: if None, scaled automatically as max(5, min(20, n//50)).
      ~50 games  →  100 mistakes → size=5  (fine-grained)
      ~200 games → 4000 mistakes → size=20  (avoids over-splitting)
    """
    n = len(mistakes)

    if min_cluster_size is None:
        min_cluster_size = max(5, min(20, n // 50))

    if n < min_cluster_size * 2:
        print(
            f"  Only {n} mistake events — need at least "
            f"{min_cluster_size * 2} for meaningful clustering. "
            f"Run Stage 1 on more games first."
        )

    print(f"\n{'='*60}")
    print(f"  Stage 2: Blindspot clustering")
    print(f"  User: {username}  |  Events: {n}  |  min_cluster_size: {min_cluster_size}")
    print(f"{'='*60}\n")

    # ── 1. Feature extraction ────────────────────────────────────────────────
    print("[1/5] Extracting feature vectors...")
    X = extract_features(mistakes)
    print(f"  Feature matrix: {X.shape}  (dtype={X.dtype}, expected dim={FEATURE_DIM})")
    if np.isnan(X).any():
        X = np.nan_to_num(X, nan=0.0)
        print("  Warning: replaced NaN values with 0")

    # ── 2. Normalise ─────────────────────────────────────────────────────────
    scaler   = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # ── 3. Dimensionality reduction ──────────────────────────────────────────
    print(f"[2/5] Reducing to {n_components}-dim embedding...")
    X_reduced, reducer = _reduce(X_scaled, n_components=n_components)

    # ── 4. HDBSCAN clustering ────────────────────────────────────────────────
    print(f"[3/5] HDBSCAN clustering (min_cluster_size={min_cluster_size})...")
    clusterer = HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=max(1, min_cluster_size // 3),
        cluster_selection_method="eom",   # excess of mass — stable clusters
    )
    labels = clusterer.fit_predict(X_reduced)

    n_clusters = len(set(labels) - {-1})
    n_noise    = int((labels == -1).sum())
    print(f"  Found {n_clusters} clusters  |  {n_noise}/{n} events as noise (will be reassigned)")

    if n_clusters == 0:
        print(
            "  No clusters found. This usually means too few events or too high "
            "min_cluster_size. Try --games 100+ or reduce min_cluster_size."
        )
        if output_dir:
            output_dir.mkdir(parents=True, exist_ok=True)
            with open(output_dir / f"{username}_clusters.json", "w") as fh:
                json.dump([], fh)
        return []

    # ── 5. Assign noise points to nearest cluster ────────────────────────────
    print(f"[4/5] Assigning {n_noise} noise points to nearest cluster...")
    labels = _assign_noise_to_nearest(labels, X_reduced)
    print(f"  After reassignment: {len(set(labels))} clusters, 0 noise")

    # ── 6. Build cluster objects ─────────────────────────────────────────────
    clusters = _build_all_clusters(mistakes, X_reduced, labels, username)

    # Assign cluster_id back onto each MistakeEvent
    for i, label in enumerate(labels):
        mistakes[i].cluster_id = str(label)

    # ── 7. LLM labelling ─────────────────────────────────────────────────────
    print(f"[5/5] Labelling clusters with Groq...")
    clusters = label_all_clusters(clusters, groq_api_key=groq_api_key)

    # ── Save ─────────────────────────────────────────────────────────────────
    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / f"{username}_clusters.json"
        with open(path, "w", encoding="utf-8") as fh:
            json.dump([asdict(c) for c in clusters], fh, indent=2, default=str)
        print(f"\nSaved clusters to {path}")

        with open(output_dir / f"{username}_scaler.pkl", "wb") as fh:
            pickle.dump(scaler, fh)
        with open(output_dir / f"{username}_reducer.pkl", "wb") as fh:
            pickle.dump(reducer, fh)
        print(f"Saved scaler + reducer to {output_dir}")

    # ── Summary ──────────────────────────────────────────────────────────────
    print(f"\n{'-'*60}")
    print(f"  Blindspot profile for {username}")
    print(f"{'-'*60}")
    for rank, c in enumerate(clusters, 1):
        bar = "#" * min(20, int(c.size / max(1, n) * 100))
        print(
            f"  #{rank:2d}  {c.label:<35}  "
            f"{c.size:>3} events  score={c.score:.3f}  {bar}"
        )
    print(f"{'-'*60}\n")

    return clusters
