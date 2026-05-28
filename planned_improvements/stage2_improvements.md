# Stage 2 — Planned Improvements

Current state: clustering pipeline is functional end-to-end (UMAP → HDBSCAN → Groq LLM labelling). These are the next quality improvements, ordered by impact.

---

## 1. Mastery persistence across re-runs (High priority)

**Problem:** When a user re-analyses games (e.g. after 20 more games), `build_cluster()` always starts every cluster at `mastery=0.0`. All puzzle accuracy the SRS accumulated is silently wiped.

**Fix:** Before saving the new `_clusters.json`, load the previous one. For each new cluster, look for an existing cluster with the same `dominant_threat_type` and `dominant_game_phase` (or close centroid distance). If found, carry forward the `mastery`, `interval_days`, and `ease_factor`.

**Where:** `ml/clustering/pipeline.py` — in `run_clustering()`, before the final `json.dump`.

```python
# Load previous clusters if they exist
prev_path = output_dir / f"{username}_clusters.json"
prev_by_type: dict[str, float] = {}
if prev_path.exists():
    with open(prev_path) as fh:
        for c in json.load(fh):
            key = (c["dominant_threat_type"], c["dominant_game_phase"])
            prev_by_type[key] = c.get("mastery", 0.0)

# Apply before saving new clusters
for cluster in clusters:
    key = (cluster.dominant_threat_type, cluster.dominant_game_phase)
    cluster.mastery = prev_by_type.get(key, 0.0)
```

---

## 2. Maia2 position embeddings to replace/augment hand-crafted features (Medium priority)

**Problem:** The 122-dim hand-crafted feature vector captures board geometry well but can't encode what human players at a specific ELO *notice* vs. miss. Two positions with identical material and piece placement can have completely different human-perception profiles.

**Approach:** Maia2's ResNet backbone produces ~256-dim position embeddings trained on 169M human games. These capture skill-dependent pattern recognition rather than pure geometry.

**Options:**
- **Option A (conservative):** Concatenate Maia2 embeddings with existing 122-dim features → 378-dim, then UMAP. Lower risk, can ablate easily.
- **Option B (clean):** Replace the 94-dim board block (piece_map + material + pawn_structure + king_safety) with Maia2 embeddings, keep the 28-dim context block. 256 + 28 = 284-dim.

**Blocker:** Maia2 is already installed (`pip install maia2`). Need to expose penultimate layer activations — check if `maia2.model` provides an embedding hook or requires a custom forward pass.

---

## 3. ELO-conditioned cluster labelling (Low priority)

**Problem:** The Groq labelling prompt sends FEN + eval drop + dominant threat type. It doesn't tell the LLM how hard this position was for a player at this ELO.

**Improvement:** Add `maia2_prob_best` and `maia2_difficulty` from the representative events to the prompt. The LLM can distinguish "consistently missed easy tactics" from "missed a hard combination everyone struggles with."

**Where:** `ml/clustering/labeller.py` — in `_surprise_description()` and the user content string in `label_cluster()`.

---

## 4. UMAP parameter tuning for small datasets (Low priority)

**Problem:** `n_neighbors=min(10, len(X)-1)` is very tight (10 neighbours). This optimises for local structure but can miss the global cluster topology when the user has < 200 events. For larger datasets (400+ events), the default `n_neighbors=15` would give better results.

**Fix:** Scale `n_neighbors` with dataset size:
```python
n_neighbors = max(5, min(30, len(X) // 20))
```

This gives 5 neighbours at 100 events, 15 at 300, 20 at 400+ — matching the UMAP recommendation to use ~sqrt(N) for local structure.

---

## 5. Soft cluster membership for noise points (Low priority)

**Problem:** HDBSCAN noise points (label=-1) are currently assigned to the nearest centroid by L2 distance in UMAP space. This is coarse — a noise point equidistant between two clusters gets assigned arbitrarily.

**Improvement:** Use HDBSCAN's `soft_clustering` parameter to get per-cluster membership probabilities for every point, including noise. Assign each noise point to the cluster with the highest soft membership probability. This is more principled than nearest-centroid.

```python
import hdbscan
soft_labels = hdbscan.all_points_membership_vectors(clusterer)
noise_mask = labels == -1
labels[noise_mask] = np.argmax(soft_labels[noise_mask], axis=1)
```

**Note:** Requires `hdbscan` package (separate from `sklearn.cluster.HDBSCAN`). Check if the sklearn version supports soft clustering before implementing.
