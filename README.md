<div align="center">
  <img src="frontend/public/logo.png" alt="Forked" width="180" />

  <h1>Forked</h1>
  <p><strong>"A coach who knows exactly how you lose."</strong></p>
  <p>
    Forked watches your real game history, detects your specific recurring tactical blindspots using ML clustering, and serves targeted drills that fix exactly those patterns — not generic puzzles.
  </p>
</div>

---

## The Problem

Chess.com and Lichess both have puzzle trainers. Neither knows that *you* personally have missed a back-rank checkmate 23 times this month. They serve the same static puzzle pool to everyone. Forked changes that.

---

## How It Works

```
Your Lichess / Chess.com username
        |
        v
 [Stage 1 — Ingestion & Classification]     COMPLETE
  Fetch last 80–200 games via public API (no login)
  Annotate every position: Stockfish depth-12 screen → depth-18 on mistakes
  Extract mistake events where eval_drop >= 100cp (blunders)
  HybridThreatClassifier: rule-based → depth lookahead → LightGBM ML model
  Maia2 filter: discard universally-hard positions (not personal blindspots)
        |
        v
 [Stage 2 — Clustering & Labelling]         COMPLETE
  Build 122-dim feature vectors per mistake event
  (64 board + 10 material + 12 pawn structure + 8 king safety + 28 context)
  StandardScaler → UMAP 16-dim → HDBSCAN (auto cluster count)
  Groq LLM (llama-3.3-70b) names each cluster: "Missed back-rank threats"
  Score clusters: frequency × recency × (1 − mastery)
        |
        v
 [Stage 3 — Puzzle Retrieval & SRS]         COMPLETE
  100K+ Lichess puzzles indexed in the same UMAP space as mistake clusters
  Query nearest puzzles per blindspot centroid, filtered by threat type + rating
  SM-2 spaced repetition scheduler — mastery tracked per blindspot
  Mastery resets if user blunders the same pattern in a live game
```

---

## Pipeline Status

| Stage | Component | Status |
|---|---|---|
| **Stage 1** | Game fetcher (Lichess + Chess.com) | Done |
| | Two-pass Stockfish annotator | Done |
| | Mistake extractor (100cp threshold) | Done |
| | HybridThreatClassifier — rule-based | Done |
| | HybridThreatClassifier — ML (LightGBM, 63.5% F1, 14 classes) | Done |
| | Maia2 human-probability filter | Done |
| **Stage 2** | 122-dim feature extraction | Done |
| | UMAP → HDBSCAN clustering | Done |
| | Groq LLM cluster labelling | Done |
| | Blindspot scoring (frequency × recency × mastery) | Done |
| **Stage 3** | Lichess puzzle DB import + indexing | Done |
| | Nearest-neighbour puzzle retrieval | Done |
| | SM-2 spaced repetition scheduler | Done |
| **Frontend** | Onboarding + analysis trigger | Done |
| | Dashboard (blindspot profile) | Done |
| | Puzzle session (board + context panel) | Done |
| | Game history view | Done |
| | Analytics board | Done |

---

## ML Classifier — Threat Classification

The threat classifier is a 3-stage hybrid:

1. **Rule-based** — deterministic, handles ~65% of cases with confidence=1.0
2. **Depth lookahead** — plays out Stockfish PV (up to 4 half-moves), ~15% of cases
3. **LightGBM** — trained on 2M Lichess puzzles, handles the remaining ~20%

**14 threat categories:**

| Category | F1 | Description |
|---|---|---|
| `back_rank` | 0.912 | Back-rank checkmate threats |
| `mate` / `king_attack` | 0.776 | Checks, king invasions |
| `passed_pawn` | 0.730 | Passed pawn advances and promotions |
| `hanging_piece` | 0.715 | Undefended or under-defended pieces |
| `fork` | 0.612 | Simultaneous attacks on 2+ pieces |
| `discovered_attack` | 0.606 | Revealed slider attacks |
| `pin` | 0.557 | Absolute pins on opponent pieces |
| `skewer` | 0.582 | High-value piece skewered behind |
| `trapped_piece` | 0.568 | Piece with no safe escape |
| `deflection` | 0.502 | Forcing a key defender away |
| `removing_defender` | 0.348 | Capturing the sole guardian |
| `piece_activity` | — | Dramatic piece activation |
| `endgame_technique` | — | King moves in low-material endings |
| `other` | — | Fallback |

**Training:** 2M Lichess puzzles, 805-dim raw bitboard features, no PCA. LightGBM with `class_weight="balanced"`. Test accuracy: 63.5% on 200K held-out examples.

---

## Project Structure

```
Forked/
├── requirements.txt
├── stage1.md                         # Detailed Stage 1 developer reference
├── planned_improvements/             # Backlog of next improvements per stage
│   └── stage2_improvements.md
├── scripts/
│   ├── setup_stockfish.py            # Download Stockfish binary
│   ├── run_analysis.py               # Stage 1 CLI
│   ├── build_training_data.py        # Build classifier training data from Lichess puzzles
│   ├── train_classifier.py           # Train LightGBM threat classifier
│   ├── evaluate_classifier.py        # Evaluate classifier on test set
│   └── verify_category_alignment.py  # Assert rule-based and ML labels are in sync
├── ml/
│   ├── config.py                     # Paths, thresholds, feature flags
│   ├── pipeline.py                   # Stage 1 orchestrator
│   ├── ingestion/
│   │   ├── fetcher.py                # Chess.com + Lichess API clients
│   │   ├── annotator.py              # Two-pass Stockfish annotator
│   │   ├── mistake_extractor.py      # MistakeEvent builder (with HybridClassifier)
│   │   ├── threat_classifier.py      # Rule-based tactical classifier (14 types)
│   │   └── maia_annotator.py         # Maia2 human-probability annotation
│   ├── classifier/
│   │   ├── hybrid_classifier.py      # 4-stage HybridThreatClassifier
│   │   ├── features.py               # 805-dim feature extraction for ML
│   │   └── label_map.py              # Lichess theme → THREAT_TYPE mapping
│   ├── clustering/
│   │   ├── feature_extractor.py      # 122-dim clustering feature vectors
│   │   ├── blindspot.py              # BlindspotCluster dataclass + scoring
│   │   ├── labeller.py               # Groq LLM cluster naming
│   │   ├── pipeline.py               # Stage 2 orchestrator
│   │   └── reclassify.py             # Re-classify existing mistakes (no re-annotation)
│   ├── puzzles/
│   │   ├── importer.py               # Lichess puzzle DB importer + indexer
│   │   └── retriever.py              # Nearest-neighbour puzzle search index
│   └── srs/
│       ├── scheduler.py              # SM-2 mastery + interval tracking per cluster
│       └── session.py                # Session builder (softmax-weighted sampling)
├── models/
│   ├── threat_lgbm.pkl               # Trained LightGBM classifier (157 MB)
│   └── label_encoder.pkl             # Class index encoder/decoder
├── backend/
│   └── main.py                       # FastAPI backend (8 endpoints)
├── frontend/
│   └── src/
│       ├── pages/                    # Dashboard, BlindspotDetail, PuzzleSession, etc.
│       ├── components/               # AppShell, board components
│       └── api/                      # API client
└── tests/
    └── test_hybrid_classifier.py     # 13 unit tests for known tactical positions
```

---

## Setup

### Prerequisites
- Python 3.10+
- Node.js 18+
- Windows / macOS / Linux

### 1 — Clone and install

```bash
git clone https://github.com/ShahuPatil07/Forked
cd Forked

python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux

pip install -r requirements.txt
```

### 2 — Environment

Create `.env` in the project root:
```
GROQ_API_KEY=gsk_...    # Free at console.groq.com — powers LLM cluster naming
```

### 3 — Download Stockfish

```bash
python scripts/setup_stockfish.py
```

### 4 — Frontend

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
```

### 5 — Backend

```bash
uvicorn backend.main:app --reload --port 8000
```

Then open `http://localhost:5173`, enter your Lichess or Chess.com username, and click Analyse.

---

## Stage 1 CLI (standalone)

```bash
python scripts/run_analysis.py ShahuPatil07 --platform lichess --games 80
```

**Output:** `data/output/ShahuPatil07_mistakes.json`

To retrain the threat classifier from scratch:

```bash
# 1. Build training data (~30 min, downloads Lichess puzzle DB once)
python scripts/build_training_data.py --resume --max 2000000

# 2. Train
python scripts/train_classifier.py

# 3. Evaluate
python scripts/evaluate_classifier.py --no-plot

# 4. Verify alignment
python scripts/verify_category_alignment.py
```

---

## Key Configuration (`ml/config.py`)

| Variable | Default | Meaning |
|---|---|---|
| `MISTAKE_THRESHOLD_CP` | 100 | Min centipawn drop to record a mistake (blunders only) |
| `ANNOTATION_DEPTH_FAST` | 12 | Stockfish depth for initial screen |
| `ANNOTATION_DEPTH_FULL` | 18 | Stockfish depth for deep re-analysis |
| `USE_MAIA2` | True | Enable Maia2 human-probability filter |
| `MAIA2_MIN_PROB_BEST` | 0.04 | Discard events below this human probability |
| `EXCLUDE_OPENING_MISTAKES` | False | Include mistakes in moves 1–20 |

---

## Key Design Decisions

**No PCA on bitboards** — LightGBM splits on individual binary features. PCA destroys the sparse structure ("white queen on d5") that trees use for interpretable splits. Raw 805-dim features outperform PCA-64 by +4.5pp overall accuracy.

**HybridThreatClassifier not just rules** — Rule-based covers ~65% with certainty=1.0. The remaining 35% goes through LightGBM, filtered by per-class confidence thresholds (back_rank=75%, others=55–65%). This minimises false positives in rare-class categories.

**Groq not Anthropic for labelling** — Free tier (30 RPM, 14K req/day) is more than sufficient for ≤50 clusters per user. No cost for the core loop.

**HDBSCAN over K-means** — K-means requires k and assumes spherical clusters. Blindspot patterns are irregular in UMAP space. HDBSCAN finds natural density structure and marks genuinely anomalous mistakes as noise (then reassigns them to the nearest cluster rather than discarding).

**L2 search over pgvector/Qdrant** — 100K puzzles × 16-dim UMAP vectors: numpy L2 in memory runs in <50ms. No database required at MVP scale.

---

## Competitive Context

| | Forked | Chess.com Learn | Lichess Puzzles | Chessable |
|---|---|---|---|---|
| Uses your real games | Yes | No | No | No |
| Detects personal blindspots | Yes | No | No | No |
| Spaced repetition | Yes (per blindspot) | No | No | Yes (openings only) |
| Resets on live blunders | Yes | No | No | No |
| Requires login | No (username only) | Yes | Yes | Yes |
| ML threat classification | Yes (63.5% F1) | No | No | No |
| Focus | Tactical blindspots | General | Generic tactics | Openings |
