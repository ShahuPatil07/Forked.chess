<div align="center">
  <img src="frontend/public/logo.png" alt="Forked" width="180" />

  <h1>Forked</h1>
  <p><strong>"A coach who knows exactly how you lose."</strong></p>
  <p>
    A complete adaptive chess training platform. Forked watches your real game
    history and detects your personal recurring blindspots with ML clustering —
    then surrounds that core loop with an interactive opening explorer, an
    endgame trainer, two AI coaches, a human-like bot to practise against, and
    an intelligence layer that tracks repeats live, replays your mistakes,
    estimates the rating they cost you, and renders a shareable Chess DNA card.
  </p>
</div>

---

## What Forked is

Forked started as a personalised blindspot trainer and has grown into a full
learning suite. Five pillars, all built around the same engine + data stack:

| Pillar | What it does |
|---|---|
| **Blindspot Profile** | Pull your last 80–200 games, annotate every move with Stockfish, cluster your mistakes with ML, and name your top recurring weaknesses ("Back-rank threats — missed 23 times"). |
| **Drill Session** | Spaced-repetition puzzle queue targeting *your* blindspots, retrieved from 100K+ Lichess puzzles in the same embedding space as your mistakes. |
| **Openings** | Interactive lazy-loaded opening tree from real Lichess game data — engine eval, win/draw/loss bars and AI "typical ideas" on every node, plus a RAG opening coach grounded in chess literature. |
| **Endgames** | A theory tree of canonical positions (Syzygy-verified), practice vs a human-like bot from any material configuration, and a tablebase-grounded endgame coach. |
| **Play vs Maia** | Play full games against Maia (human-move model) tuned near your rating, then get a Stockfish accuracy report, a blindspot debrief, and an interactive game-analysis view. |

### Intelligence layer

Five features that turn the blindspot graph into a living feedback loop. All
identify clusters by their **ID + centroid vector** (never the LLM label, which
can change on re-cluster):

| Feature | What it does |
|---|---|
| **Live sync + alerts** | A background loop polls for new games, re-runs Stage 1, and the moment you repeat a known blindspot it raises a dashboard alert + resets that cluster's mastery. |
| **Post-game debrief** | After a Maia game, every mistake is matched against your clusters — "you triggered 1 known weakness in this game" — instead of a generic accuracy number. |
| **Mistake Replay** | Walk every real-game position in a cluster: eval bar, free piece exploration, a unique per-position "Notice", and a Groq one-line pattern insight. |
| **Counterfactual rating** | "Fix these patterns → +67 points." A bounded performance-rating estimate of what each blindspot costs you, with per-cluster `+N pts` badges. |
| **Chess DNA card** | A shareable 1200×630 PNG: your 5-axis style archetype ("The Attacker") + top blindspots + counterfactual, with a public `/dna/{username}` landing page. |

Product name: **Forked**. Tagline: *"A coach who knows exactly how you lose."*

---

## Why this is defensible

- Chess.com could build the blindspot loop but won't — their Learn section is a revenue line, not a priority.
- The moat is the per-user blindspot graph. It gets richer with every game and can't be replicated by a fresh account.
- The feedback loop is the key: when a user blunders the same pattern in a real game, the system detects it and resets that cluster's mastery score. No static puzzle platform does this.
- The surrounding tools (openings, endgames, coaches, bot) make Forked a daily-use product, not a one-time audit — every one of them is grounded in real data or tablebases, not generic AI text.

---

## The core ML pipeline (3 stages)

```
Your Lichess / Chess.com username
        |
        v
 [Stage 1 — Ingestion & Classification]
  Fetch last 80–200 games via public API (no login)
  Annotate every position: Stockfish depth-12 screen → depth-18 on mistakes
  Extract mistake events where eval_drop >= 100cp (blunders)
  HybridThreatClassifier: rule-based → depth lookahead → LightGBM ML model
  Maia2 filter: discard universally-hard positions (not personal blindspots)
        |
        v
 [Stage 2 — Clustering & Labelling]
  Build 122-dim feature vectors per mistake event
  (64 board + 10 material + 12 pawn structure + 8 king safety + 28 context)
  StandardScaler → UMAP 16-dim → HDBSCAN (auto cluster count)
  Groq LLM (llama-3.3-70b) names each cluster: "Missed back-rank threats"
  Score clusters: frequency × recency × (1 − mastery)
        |
        v
 [Stage 3 — Puzzle Retrieval & SRS]
  100K+ Lichess puzzles indexed in the same UMAP space as mistake clusters
  Query nearest puzzles per blindspot centroid, filtered by threat type + rating
  SM-2 spaced repetition scheduler — mastery tracked per blindspot
  Mastery resets if user blunders the same pattern in a live game
```

### ML threat classifier

A 3-stage hybrid: **rule-based** (deterministic, ~65% of cases, confidence 1.0)
→ **depth lookahead** (plays out Stockfish PV up to 4 half-moves, ~15%) →
**LightGBM** (trained on 2M Lichess puzzles, remaining ~20%, per-class
confidence thresholds). 14 threat categories, 63.5% F1 on 200K held-out
examples, 805-dim raw bitboard features (no PCA).

---

## The four learning surfaces

### Openings Explorer  (`/openings`)
- Lazy-loaded tree from the live **Lichess Opening Explorer API**, filtered to your rating band.
- Every node shows a mini-board thumbnail, engine eval, popularity and a WDL bar.
- Detail panel: full board, ECO + name, Stockfish eval, AI-generated "typical ideas".
- Fuzzy opening search ("veina" → Vienna) jumps the tree to any named line.
- **Opening Coach** — streaming RAG chatbot grounded in a curated opening corpus + live Lichess stats, rating-aware, with source citations. Independent of the tree.

### Endgames  (`/endgames`)  — three tabs
- **Theory** — a hardcoded tree of canonical positions (K+P, K+R, K+Q, minor-piece, rook, pawn endings). Each leaf is **Syzygy-verified** (≤7-piece tablebase) with result, difficulty and key idea.
- **Practice** — a piece configurator (pick exact material or type "queen pawn endgame") fetches an *instructive* position (Lichess puzzle DB first, Stockfish-filtered generation as fallback), then you play it out vs Maia. The result is judged against the theoretical objective ("Correct draw!" / "You drew a winning position").
- **Coach** — a streaming endgame RAG chatbot that injects **Syzygy results as verified fact** and shows a "Tablebase verified" badge.

### Play vs Maia  (`/bot-game`)
- Full games against the **Maia2** human-move model, tuned near your rating, with human-like thinking delays.
- Move history is navigable (click or ← / →), board flips to your colour, check highlighting, promotion dialogue.
- After the game: a **Stockfish accuracy report** (chess.com-style %) and an **Analyse Game** view with engine eval on every move.

### Analysis Board  (`/analysis`)
- Free-play board with live Stockfish eval bar, best-move arrows, move list, flip, FEN copy.
- Opens directly from any position via `?fen=` or from the endgame theory panel.

---

## Tech stack

**Backend** — Python 3.10+, FastAPI, `python-chess` + Stockfish, LightGBM,
scikit-learn (HDBSCAN), umap-learn, Maia2 (PyTorch), Groq (LLM), Pillow (DNA
card PNG), SQLite for caches. Background annotation + live sync run in worker
threads with SSE progress.

**Frontend** — React + TypeScript, Vite, `chess.js` + `react-chessboard`,
TanStack Query, Zustand, Tailwind, Framer Motion. WebSockets for live games,
manual SSE parsing for streaming coach responses.

**Data** — Lichess puzzle DB (100K sample indexed), Lichess Opening Explorer
API, Syzygy tablebase API (`tablebase.lichess.ovh`), curated JSON corpora for
the coaches.

> **No PostgreSQL / pgvector.** Position embeddings are 16-dim UMAP vectors;
> numpy L2 over 100K puzzles runs in <50 ms in memory. All caches (eval, ideas,
> Syzygy, suggestions) are SQLite files under `data/`.

---

## Backend API (`backend/`, FastAPI)

The backend is split into seven routers, all mounted on one app:

```
backend/main.py          — ingestion, profile, drills, analysis, bot-game (+ WS), debrief
backend/openings.py      — opening explorer: explore / eval / ideas
backend/opening_chat.py  — opening coach: chat / chat/stream / suggestions
backend/endgames.py      — endgames: practice-position(/by-config) / syzygy / coach
backend/live_sync.py     — background sync + blindspot alerts
backend/replay.py        — mistake replay: per-cluster mistakes / insight / note / explain
backend/counterfactual.py— counterfactual rating estimate
backend/card.py          — Chess DNA: compute-style / style / dna-card (Pillow PNG)
backend/bot/             — Maia2 move generator + human thinking-delay
```

| Area | Endpoints |
|---|---|
| **Ingestion / profile** | `POST /api/ingest`, `GET /api/ingest/status/{job}` (SSE), `GET /api/profile/{user}`, `GET /api/cluster/{user}/{id}`, `GET /api/games/{user}`, `GET /api/analytics/{user}` |
| **Drills / SRS** | `GET /api/session/{user}`, `POST /api/session/complete` |
| **Analysis** | `GET /api/analyse?fen=…&depth=` |
| **Openings** | `GET /api/openings/explore`, `/eval`, `POST /api/openings/ideas`, `POST /api/openings/chat(/stream)`, `GET /api/openings/chat/suggestions` |
| **Endgames** | `GET /api/endgames/practice-position`, `POST /api/endgames/practice-position/by-config`, `GET /api/endgames/syzygy`, `POST /api/endgames/coach/chat(/stream)`, `GET /api/endgames/coach/suggestions` |
| **Play vs Maia** | `POST /api/bot-game/create`, `GET /api/bot-game/{id}`, `WS /ws/bot-game/{id}`, `POST /api/bot-game/accuracy`, `POST /api/bot-game/{id}/debrief` |
| **Live sync / alerts** | `GET /api/alerts/{user}`, `POST /api/alerts/{user}/mark-seen`, `GET /api/sync/status/{user}`, `POST /api/sync/trigger/{user}` |
| **Mistake Replay** | `GET /api/cluster/{user}/{id}/mistakes`, `/insight`, `POST /api/cluster/note`, `POST /api/cluster/explain` |
| **Counterfactual / DNA** | `GET /api/profile/{user}/counterfactual`, `POST /api/profile/{user}/compute-style`, `GET /api/profile/{user}/style`, `GET /api/profile/{user}/dna-card` |
| **Settings** | `GET/PUT /api/settings/{user}`, `GET /api/check/{user}` |

---

## Project structure

```
Forked/
├── requirements.txt
├── stage1.md                          # Detailed Stage 1 developer reference
├── planned_improvements/              # Backlog per stage
├── scripts/
│   ├── setup_stockfish.py             # Download Stockfish binary
│   ├── run_analysis.py                # Stage 1 CLI
│   ├── build_training_data.py         # Classifier training data from Lichess puzzles
│   ├── train_classifier.py            # Train LightGBM threat classifier
│   ├── evaluate_classifier.py         # Evaluate classifier on test set
│   ├── verify_category_alignment.py   # Assert rule-based + ML labels in sync
│   ├── run_puzzle_import.py           # Build the puzzle retrieval index
│   └── build_endgame_positions.py     # Build endgame.db (+ optional Syzygy verify)
├── ml/
│   ├── config.py                      # Paths, thresholds, feature flags
│   ├── pipeline.py                    # Stage 1 orchestrator
│   ├── ingestion/                     # fetcher, annotator, mistake_extractor,
│   │                                  #   threat_classifier, maia_annotator
│   ├── classifier/                    # hybrid_classifier, features, label_map
│   ├── clustering/                    # feature_extractor, blindspot, labeller,
│   │                                  #   pipeline, reclassify
│   ├── matching.py                    # event → UMAP → nearest cluster centroid
│   ├── style/extractor.py             # 5-axis Chess DNA style profile + archetype
│   ├── puzzles/                       # importer, retriever
│   └── srs/                           # scheduler (SM-2), session builder
├── models/                            # threat_lgbm.pkl, label_encoder.pkl
├── backend/
│   ├── main.py                        # Core API + bot-game WebSocket + debrief
│   ├── openings.py                    # Opening explorer router
│   ├── opening_chat.py                # Opening coach (RAG + streaming)
│   ├── endgames.py                    # Endgames router (practice / syzygy / coach)
│   ├── live_sync.py                   # Background sync + blindspot alerts
│   ├── replay.py                      # Mistake Replay (mistakes / insight / note / explain)
│   ├── counterfactual.py              # Counterfactual rating estimate
│   ├── card.py                        # Chess DNA card (Pillow PNG) + style endpoints
│   └── bot/
│       ├── maia_engine.py             # Maia2 move generator (+ first-move guard)
│       └── thinking_delay.py          # Human-like delay simulator
├── data/
│   ├── opening_cache.db               # Opening eval / ideas / lichess / suggestions
│   ├── opening_knowledge.json         # Curated opening coach corpus (47 entries)
│   ├── endgame.db                     # Practice positions + Syzygy + suggestions
│   ├── endgame_positions.json         # Curated practice positions (66)
│   ├── endgame_knowledge.json         # Curated endgame coach corpus (25 entries)
│   ├── puzzles/                       # Lichess puzzle index (npz + meta.json)
│   └── output/                        # Per-user state: mistakes / clusters / settings /
│                                      #   alerts / sync / style / counterfactual / dna_card.png
├── frontend/
│   └── src/
│       ├── pages/                     # Dashboard, PuzzleSession, OpeningExplorer,
│       │                              #   Endgames, BotGame, AnalysisBoard,
│       │                              #   MistakeReplay, DNAPage, …
│       ├── components/
│       │   ├── layout/                # AppShell, SectionHeader, ChessBackground
│       │   ├── openings/              # OpeningTree, OpeningDetail, OpeningCoachChat,
│       │   │                          #   MiniBoardThumbnail
│       │   ├── endgames/              # EndgameTree, EndgameDetail, EndgamePractice,
│       │   │                          #   EndgameCoach, PieceConfigurator
│       │   ├── dashboard/             # BlindspotAlerts, RatingImpact
│       │   ├── BotGameDebrief.tsx     # Post-game blindspot debrief
│       │   └── ChessDNACard.tsx       # Style archetype + axis bars
│       ├── hooks/                     # useGameReview (move-history navigation)
│       ├── data/                      # endgameTree.ts, openings_index.json
│       └── api/                       # index, openings, endgames, replay, insights, live
└── tests/
    └── test_hybrid_classifier.py      # 13 unit tests for known tactical positions
```

---

## Setup

### Prerequisites
- Python 3.10+, Node.js 18+, Windows / macOS / Linux

### 1 — Clone and install
```bash
git clone https://github.com/ShahuPatil07/Forked
cd Forked

python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux

pip install -r requirements.txt
```

> `torch` (Maia2 dependency) installs separately, CPU build:
> `pip install torch --index-url https://download.pytorch.org/whl/cpu`

### 2 — Environment
Create `.env` in the project root:
```
GROQ_API_KEY=gsk_...     # Free at console.groq.com — powers the LLM coaches + cluster naming
LICHESS_TOKEN=lip_...    # Free at lichess.org/account/oauth/token — needed for the Opening Explorer API
```

### 3 — Download Stockfish
```bash
python scripts/setup_stockfish.py
```

### 4 — Build data indexes (one-time)
```bash
python scripts/run_puzzle_import.py        # Lichess puzzle retrieval index (Drills + Endgame practice)
python scripts/build_endgame_positions.py  # Endgame practice DB  (add --verify for Syzygy check)
```

### 5 — Run
```bash
# Backend
uvicorn backend.main:app --reload --port 8000

# Frontend (separate terminal)
cd frontend && npm install && npm run dev    # http://localhost:5173
```

Open `http://localhost:5173`, enter your Lichess/Chess.com username, and click
Analyse. The Openings, Endgames and Play-vs-Maia sections work without a
profile.

---

## Standalone CLI (blindspot pipeline)

```bash
python scripts/run_analysis.py ShahuPatil07 --platform lichess --games 80
# → data/output/ShahuPatil07_mistakes.json

# Retrain the threat classifier from scratch:
python scripts/build_training_data.py --resume --max 2000000   # ~30 min, downloads puzzle DB
python scripts/train_classifier.py
python scripts/evaluate_classifier.py --no-plot
python scripts/verify_category_alignment.py
```

---

## Key configuration (`ml/config.py`)

| Variable | Default | Meaning |
|---|---|---|
| `MISTAKE_THRESHOLD_CP` | 100 | Min centipawn drop to record a mistake (blunders only) |
| `ANNOTATION_DEPTH_FAST` | 12 | Stockfish depth for initial screen |
| `ANNOTATION_DEPTH_FULL` | 18 | Stockfish depth for deep re-analysis |
| `USE_MAIA2` | True | Enable Maia2 human-probability filter |
| `MAIA2_MIN_PROB_BEST` | 0.04 | Discard events below this human probability |
| `EXCLUDE_OPENING_MISTAKES` | False | Include mistakes in moves 1–20 |

---

## Key design decisions

**No PCA on bitboards** — LightGBM splits on individual binary features; PCA destroys the sparse "white queen on d5" structure trees use. Raw 805-dim beats PCA-64 by +4.5pp.

**Hybrid classifier, not just rules** — rule-based covers ~65% at certainty 1.0; the rest goes through LightGBM with per-class confidence thresholds to minimise false positives in rare classes.

**Curated corpora, not a full RAG scrape** — both coaches are grounded in hand-curated JSON corpora (openings + endgames) injected by ECO/material/keyword match, plus live data (Lichess stats / Syzygy). No vector DB, no multi-hour scrape, sources still cited.

**Syzygy as ground truth** — endgame results and the post-game verdict are checked against the Lichess tablebase (≤7 pieces). The coach cites it as verified fact, not opinion — the unique trust signal vs generic chess AI.

**Instructive endgame positions** — practice positions come from real Lichess endgame puzzles first; rare configurations fall back to Stockfish-filtered random generation (balanced eval, long PV, enough legal moves) so positions reward technique instead of being trivially won.

**Maia first-move guard** — Maia2 is out-of-distribution when a piece is developed before any pawn move, so the bot's first move is forced to a central pawn; an OOD retreat filter catches the rest. The bot-game WebSocket decides who opens by side-to-move vs the user's colour (so endgame practice from any FEN works), not by assuming "user is black".

**Cluster identity is the ID, never the label** — the whole intelligence layer (live alerts, debrief, replay, counterfactual, DNA) matches fresh mistakes by projecting them through the persisted scaler + UMAP reducer and taking the nearest cluster centroid. The Groq-generated label is display-only and can change on re-cluster, so it's never used as a key.

**Bounded counterfactual rating** — the rating estimate uses a performance-rating model over real game results (re-fetched, since game metadata doesn't store outcomes) and is capped — an early flat per-game-Elo version produced fantasy +1000-point ratings.

**Chess DNA from the mistake set** — the 5 style axes are derived from the existing mistake/eval data with documented proxies rather than re-annotating every move; axes without enough data are omitted from the card instead of guessed.

**Groq, not Anthropic, for LLM** — free tier (30 RPM) is ample for coach turns + cluster naming; no cost in the core loop. Streaming via SSE.

**SQLite + numpy, not a database** — every cache (eval, ideas, Syzygy, suggestions, puzzle vectors) is a file under `data/`. Zero infra to run locally.

---

## Competitive context

| | Forked | Chess.com Learn | Lichess | Chessable |
|---|---|---|---|---|
| Uses your real games | Yes | No | No | No |
| Detects personal blindspots | Yes | No | No | No |
| Spaced repetition | Yes (per blindspot) | No | No | Yes (openings) |
| Resets on live blunders | Yes | No | No | No |
| Opening tree + AI ideas + eval per node | Yes | Partial | Partial | No |
| Endgame trainer vs human-like bot | Yes | Partial | No | No |
| Tablebase-verified endgame coach | Yes | No | No | No |
| Requires login | No (username only) | Yes | Yes | Yes |
| Focus | Whole-game improvement | General | Generic tactics | Openings |
```
