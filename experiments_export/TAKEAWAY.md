# Forked — Model Experiments Handoff

You are working in a **standalone experiment repo**, split off from the main
Forked product so we can try better models for two ML stages **without touching
the running app**. Your job is to beat the current production models on their
own held-out data, while keeping every input/output contract identical so the
winner can be dropped straight back into the product.

There are **two independent experiments**. They share no code and can be done in
either order:

1. **Stage 1 — Threat classifier.** Replace LightGBM-on-hand-crafted-features
   with a small chess transformer trained with contrastive loss.
2. **Stage 2 — Blindspot clusterer.** Replace HDBSCAN-on-dense-features with a
   Contrastive Sparse Autoencoder (CSAE) whose sparse features self-label as
   tactical concepts.

> **Golden rule — preserve the contracts.** The rest of Forked (ingestion,
> Stockfish annotation, Maia2 filtering, SRS, the whole frontend) stays exactly
> as-is. Each experiment has a fixed **input** and **output** described below.
> If your new model honours that contract, swapping it in is a one-file change.
> If you change the contract, you've broken the product — don't.

---

## 0. What's in this bundle

```
experiments_export/
  TAKEAWAY.md                  ← you are here
  README_SETUP.md              ← env + data setup (read second)

  stage1_classifier/           ← everything for the Stage 1 experiment
    features.py                current 805-dim hand-crafted feature extractor
    label_map.py               Lichess theme → 16 ML classes → 18 THREAT_TYPES
    hybrid_classifier.py       the production inference funnel (the integration target)
    threat_classifier.py       rule-based classifier (Stages 0-2 of the funnel) + THREAT_TYPES
    build_training_data.py     Lichess puzzle DB → train/val/test parquet
    train_classifier.py        current LightGBM trainer (the baseline to beat)
    evaluate_classifier.py     held-out test metrics (per-class F1 — your scoreboard)

  stage2_clustering/           ← everything for the Stage 2 experiment
    feature_extractor.py       current 122-dim MistakeEvent → vector
    pipeline.py                current StandardScaler → UMAP-16 → HDBSCAN → label
    blindspot.py               BlindspotCluster dataclass + scoring (the output contract)
    labeller.py                Groq cluster naming (CSAE aims to make this unnecessary)
    maia_annotator.py          Maia2 dense-embedding source (CSAE input candidate)
    mistake_extractor.py       MistakeEvent dataclass (the Stage 2 input contract)
    annotator.py               PositionAnnotation dataclass (mistake_extractor imports it)
    run_clustering.py          Stage 2 CLI entry point

  shared/
    config.py                  paths + thresholds (trim to what you need)

  reference_docs/
    THREAT_CLASSIFIER_ML_PIVOT.md   how/why the current LightGBM design was chosen
    CLASSIFIER_FINALIZE_PROMPT.md   the spec the current classifier was built to

  README_SETUP.md              env, package layout, dataset copy list, baseline repro
  requirements_baseline.txt    exact deps to reproduce both baselines
```

You must also copy the **datasets** (too large to live in git — see
`README_SETUP.md`):
- `data/processed/{train,val,test}.parquet` — 2M labelled puzzle positions, the
  Stage 1 train/eval set (already built; ~215 MB total).
- `data/puzzles/{meta.json,index.npz,ids.txt,themes.txt}` — the 100K-puzzle
  index, useful if you want raw FEN+theme pairs for contrastive sampling.
- `data/output/{user}_mistakes.json` + `{user}_clusters.json` — real per-user
  Stage 2 input/output examples (e.g. `ShahuPatil27` has 315 mistakes → 3
  clusters). Use these to sanity-check the clusterer on real data.

---

## 1. STAGE 1 — Transformer + contrastive threat classifier

### 1.1 What the current model does (the baseline)

- **Input:** a chess position `fen` + the engine's best move `move_uci`.
- **Feature step** (`features.py` → `extract_raw`): produces an **805-dim**
  vector = 768 bitboard (12 piece-planes × 64 sq) + 20 move + 12 context + 5
  post-move features.
- **Model** (`train_classifier.py`): LightGBM on the raw 805-dim vector (no PCA
  — trees handle sparse binary natively), trained on **16 Lichess-native
  classes** (`ML_LICHESS_CLASSES` in `label_map.py`).
- **Output:** one of 16 ML classes → mapped at inference to one of 18
  `THREAT_TYPES` via `ML_CLASS_TO_THREAT`.
- **Current score:** **63.5% overall accuracy** on the held-out test split;
  rare/abstract classes (pin, deflection, removeDefender, endgame) sit well
  below 70% and plateau no matter how LightGBM is tuned. That plateau is the
  whole reason for this experiment.

### 1.2 The experiment

Replace LightGBM-on-hand-crafted-features with a **small chess transformer
(~4 layers) where each of the 64 squares is one token**, trained with a
**contrastive objective**: positions sharing a Lichess theme should be close in
embedding space; positions with different themes should be far. Then a tiny
linear head (or k-NN over embeddings) does the 16-class prediction.

- Architecture reference: the **Chessformer**-style per-square tokenisation
  (64 tokens + piece-type/colour embeddings + a learned positional/square
  embedding; a CLS or mean-pooled embedding feeds the head).
- Objective reference: standard **supervised contrastive loss** (SupCon) — the
  label is the Lichess theme/ML class, so same-class positions are positives.
- **Target:** 78–85% overall, and crucially lift the hard classes above 70%.

### 1.3 The contract you MUST preserve

The integration target is `hybrid_classifier.py` — specifically
`HybridThreatClassifier._classify_via_model(self, fen, move_uci) -> (threat_type, confidence)`.
Today that calls `extract_raw` + `model.predict_proba`. Your job is to make a
drop-in replacement for **just that method** that:

- takes `(fen: str, move_uci: str)`,
- returns `(threat_type: str, confidence: float)` where `threat_type ∈ THREAT_TYPES`
  (use the existing `ML_CLASS_TO_THREAT` map — predict an ML class, then map),
- and `confidence` is a calibrated probability in `[0,1]` (the funnel applies
  per-class thresholds in `_CLASS_THRESHOLDS`, so calibration matters).

Everything upstream (Stages 0-2: eval-drop guard, rule-based, depth lookahead)
and the per-class thresholds stay. You are **only** replacing the Stage 3 ML
fallback. Do NOT change `THREAT_TYPES`, `ML_LICHESS_CLASSES`, or the label
mapping — they're how the model talks to the product.

### 1.4 Train / evaluate on the SAME data, the SAME way

- **Train set:** `data/processed/train.parquet` (and `val.parquet`). Each row
  has `fen`, `move` (UCI), `label` (int index into `ML_LICHESS_CLASSES`),
  `features` (the 805-dim vector — ignore it; you're building your own from the
  `fen`+`move`). Build your transformer inputs from `fen` + `move`.
- **If you want more/raw data:** `build_training_data.py` re-streams the Lichess
  puzzle DB; `label_map.py::map_lichess_themes_to_ml_class` is the canonical
  theme→class function — reuse it so your labels match the baseline exactly.
- **Scoreboard:** `evaluate_classifier.py` reports per-class precision/recall/F1
  on `test.parquet`. **Report your model on the identical test split** so the
  63.5% comparison is apples-to-apples. A win is: higher overall F1 **and** no
  class regressing badly, especially the hard four (pin, deflection,
  removeDefender, endgame).

### 1.5 Definition of done (Stage 1)

- [ ] Transformer trains on `train.parquet`, converges on `val.parquet`.
- [ ] Per-class F1 on `test.parquet` reported next to the LightGBM baseline.
- [ ] Overall accuracy ≥ 75% (stretch 85%), hard classes ≥ 70%.
- [ ] A `predict(fen, move_uci) -> (threat_type, confidence)` function that
      matches `_classify_via_model`'s signature, ready to drop into
      `hybrid_classifier.py`.
- [ ] A short writeup: architecture, loss, training curve, confusion matrix,
      and the swap-in instructions.

---

## 2. STAGE 2 — Contrastive Sparse Autoencoder clusterer

### 2.1 What the current pipeline does (the baseline)

- **Input:** a list of `MistakeEvent` objects for one user (see
  `mistake_extractor.py` for the dataclass; real examples in
  `data/output/{user}_mistakes.json`).
- **Feature step** (`feature_extractor.py` → `extract_features`): each event →
  **122-dim** vector (64 piece-map + 10 material + 12 pawn + 8 king-safety + 28
  context, where context includes the 18 threat one-hots + 3 Maia2 fields).
- **Model** (`pipeline.py` → `run_clustering`): StandardScaler → **UMAP→16-dim**
  → **HDBSCAN** (noise reassigned to nearest centroid) → **Groq LLM names each
  cluster**. Produces `BlindspotCluster` objects (`blindspot.py`).
- **Why replace it:** clusters are dense-feature blobs with fuzzy boundaries,
  and we need an LLM call just to name them. We want **sparse, self-labelling
  features** that map cleanly onto tactical concepts.

### 2.2 The experiment

Train a **Contrastive Sparse Autoencoder** on pairs of
**(correct-play, user's-play) trajectories**. The sparse latent features that
fire should correspond to interpretable tactical concepts with meaningful
boundaries — so a user's blindspot profile becomes "which sparse features fire
most on their mistakes," **no LLM labelling needed** (the active features are
self-labelling once you inspect what activates them).

- Framework reference: the **CSAE** paper — sparse autoencoder + a contrastive
  term that pulls together the (correct, played) representations that share a
  tactical motif and pushes apart unrelated ones.
- **Trajectory data:** each `MistakeEvent` already carries both the position
  (`fen`), the **user's move** (`move_played_uci`) and the **correct move**
  (`best_move_uci`) — that's your (played vs correct) pair per event. For richer
  trajectories you can roll the line out a few plies with Stockfish (see how the
  rule funnel does lookahead in `threat_classifier.py` / `hybrid_classifier.py`).
- **Dense-embedding input option:** `maia_annotator.py` shows how we get Maia2
  move-probability signals per position; the prompt's plan is to run the CSAE on
  Maia2-derived dense embeddings. You can use Maia2 embeddings, the 122-dim
  vectors from `feature_extractor.py`, or raw board tensors — your call, as long
  as the output contract holds.

### 2.3 The contract you MUST preserve

`run_clustering(mistakes, username, ...)` in `pipeline.py` returns a
`list[BlindspotCluster]` and writes `{user}_clusters.json` + the persisted
`scaler.pkl` / `reducer.pkl`. The product (and the whole intelligence layer —
live alerts, replay, counterfactual, DNA card) depends on **`BlindspotCluster`**
having at least these fields (see `blindspot.py`):

```
cluster_id, user_id, label, size, centroid (list[float]),
dominant_threat_type, dominant_game_phase, mastery, last_occurrence_unix,
next_review_unix, score, representative_events (list[dict])
```

and on each `MistakeEvent.cluster_id` being set to its cluster.

**Critical detail:** downstream matching (alerts/replay/counterfactual) projects
*new* mistakes into the cluster space by reusing the persisted `scaler` +
`reducer` and taking the nearest **`centroid`** (cosine). So whatever embedding
space your CSAE produces, you must:
1. emit a stable per-cluster `centroid` vector in that space, and
2. provide a way to project a fresh `MistakeEvent` into the same space
   (the equivalent of the saved scaler+reducer) so `ml/matching.py` in the main
   repo can keep working.

If you keep `run_clustering`'s signature and the `BlindspotCluster` shape, the
swap is again a one-file change. The LLM `labeller.py` becomes optional — if
your sparse features self-label, fill `label` from the dominant active feature
instead of calling Groq.

### 2.4 Evaluate

There's no labelled ground truth for "correct" clusters, so judge on:
- **Interpretability:** do sparse features correspond to nameable motifs
  (back-rank, fork, etc.)? Cross-check against each event's existing
  `threat_type`.
- **Cohesion/separation:** silhouette score in the latent space vs the current
  UMAP+HDBSCAN baseline on the same `{user}_mistakes.json`.
- **Stability:** re-running on the same user gives the same clusters.
- **Self-labelling:** can you name a cluster from its top active features
  without the LLM? Compare those names to what `labeller.py` produces.

### 2.5 Definition of done (Stage 2)

- [ ] CSAE trains on (played, correct) pairs from real `_mistakes.json` files.
- [ ] Sparse features inspected + named; mapping to tactical motifs documented.
- [ ] A `run_clustering`-compatible function returning `list[BlindspotCluster]`
      with valid `centroid`s + a projection fn for new events.
- [ ] Silhouette / interpretability comparison vs the UMAP+HDBSCAN baseline on
      `ShahuPatil27` (and any other user JSON you copy over).
- [ ] Writeup: architecture, loss, what each top feature means, swap-in notes.

---

## 3. Integrating a winner back into the product

Don't try to PR into the main repo from here. When a model wins, hand back:

1. The trained weights + any projector/scaler artifacts.
2. The drop-in function:
   - **Stage 1:** replacement body for `HybridThreatClassifier._classify_via_model`.
   - **Stage 2:** replacement for `run_clustering` (same signature + output).
3. The eval numbers vs baseline on the identical splits.
4. New dependencies (the main repo is deliberately light — torch is already
   present for Maia2, but flag anything else).

The main-repo owner does the actual swap, re-runs `evaluate_classifier.py` /
`run_clustering.py` to confirm parity, and ships.

---

## 4. Hard constraints (do not violate)

- **Don't change** `THREAT_TYPES` (18), `ML_LICHESS_CLASSES` (16), or
  `ML_CLASS_TO_THREAT`. They are the vocabulary the product speaks.
- **Don't change** the `MistakeEvent` or `BlindspotCluster` field sets.
- **Train and report on the provided splits** (`train/val/test.parquet`) — no
  re-splitting, so the 63.5% baseline stays comparable.
- Keep the `(fen, move_uci)` Stage-1 input and the `list[MistakeEvent]` Stage-2
  input — everything upstream feeds these and must not be rebuilt.
