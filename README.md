<div align="center">
  <img src="frontend/public/logo.png" alt="Forked" width="180" />

  <h1>Forked</h1>
  <p><strong>"A coach who knows exactly how you lose."</strong></p>
  <p>
    A complete adaptive chess training platform. Forked watches your real game
    history and finds your personal recurring blindspots — each mistake tagged as
    a tactic you <em>allowed</em> or <em>missed</em>, classified by a multi-label
    chess transformer, and scored against players at your own level — then
    surrounds that loop with a Chess.com-calibrated game review, an evidence-based
    AI coach, an opening explorer, an endgame trainer, a human-like bot, and an
    intelligence layer that tracks repeats live, replays your mistakes, estimates
    the rating they cost you, and renders a shareable Chess DNA card.
  </p>
</div>

---

## What Forked is

**New in this release**

- **A new interface.** Black / white / one neon accent, and tree navigation in
  place of the sidebar: after importing your games you land on a hub of big
  blocks — **Dashboard**, **Theory** (Openings, Endgames), **Practice** (Drills,
  Play vs Maia), **AI Coach** (Chat, Screen Share), **Analyze** (Game Review,
  Analysis Board, Game History) and **OTB Scan** — each opening its sub-blocks,
  with breadcrumbs in a slim top bar.
- **Game Review calibrated to Chess.com.** Accuracy fitted to Chess.com's own
  stored accuracies is within **3.4 points on average** (was 6.7), with
  Chess.com's rules for Blunder / Miss / Great / Brilliant, a deeper book, a
  calibrated game rating, Retry, recent-games import and the official Chess.com
  accuracy shown alongside.
- **Stage 1/2 v2 blindspot pipeline.** On held-out real-game blunders the right
  skill family is found **87%** of the time (was 29%); profiles are peer-relative
  with a confidence status, and every mistake carries a structured multi-type
  description.

The Coach, voice and review work immediately without importing an account.

| Area | What it does |
|---|---|
| **Game Review** | Local Stockfish review calibrated toward Chess.com: move labels with its contextual rules, accuracy fitted to its stored values, a calibrated game rating, accuracy by phase, Retry, recent-games import, board icons and an advantage graph. No daily limit or hosted API needed. |
| **Forked Coach** | Bounded tool orchestration plus MultiPV investigation, alternative-move searches and checked evidence. Wide chat, concise explanations, inline puzzles, PGN/FEN analysis and opening/endgame knowledge. |
| **Share Screen** | Tutorial, exact Forked-board connection, playable board and English voice in one tab. Uses the same narrator as Coach, with a local fallback. |
| **Blindspot Profile / Drills** | Allowed-vs-missed mistake detection, a multi-label transformer + Lichess-tagger verifier, peer-relative skill-family profiles with confidence status, and spaced-repetition training from Lichess puzzles. |
| **Openings / Endgames** | Opening explorer, engine evaluations, curated theory, tablebase-backed endgame positions and practice. Separate section chats have been removed; ask the main Coach instead. |
| **Play vs Maia** | Human-like opponent, game report, blindspot debrief and analysis board. |
| **OTB Scan** | Live camera, uploaded video or scoresheet-to-PGN tools feeding the analysis board. |

Game Review is an **independent implementation**, not Chess.com's proprietary
CAPS2: it follows Chess.com's published bands and described rules, and its
accuracy and game-rating constants are fitted to Chess.com's stored accuracies
(Published-Data API). Move labels cannot be checked against Chess.com directly.
See [review methodology, calibration and tests](backend/GAME_REVIEW.md),
[Coach architecture and AIM handoff](backend/coach/README.md), and
[voice setup/testing](backend/coach/SHARE_SCREEN.md).

### Intelligence layer

Five features that turn the blindspot graph into a living feedback loop. All
identify clusters by their **family `cluster_id`** (a stable skill-family key,
never a mutable LLM label):

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
  Fetch your last 80–200 rated rapid games via public API (no login)
  Stockfish depth-12 screen → depth-18 on flagged moves, lines kept, cached per game
  Mistakes = win-probability loss (Lichess curve), for you AND your opponents
  Tag each: did you ALLOW a tactic, MISS one, both, or neither (quiet)?
  Classify in the matching position — allowed: (after your move, their refutation)
  = the Lichess puzzle format — with a multi-label transformer + verifier
  Collapse cascades; Maia2 at your real rating weights how avoidable it was
        |
        v
 [Stage 2 — Blindspot family profile]
  5 skill families: loose_pieces · alignment · defender_disruption · king_safety · positional
  Rate per 100 moves vs your opponents in the same games (the peer baseline)
  Shrinkage + P(worse than peers) → confirmed / emerging / typical / strength
  Plus: tactics found vs available, allowed/missed split, points lost per 10 games
        |
        v
 [Stage 3 — Puzzle Retrieval & SRS]
  100K+ Lichess puzzles indexed locally with their Lichess theme tags
  Allocate a puzzle budget across families by blindspot score
  Query each family's themes within the user's rating band
  SM-2 spaced repetition — mastery per family, resets on live blunders
```

### Chess transformer classifier (Stage 1)

A **Chessformer** (64 square-tokens, side-to-move oriented, Shaw relative
attention, 6 layers) fine-tuned into a **17-way multi-label** model whose labels
come from the real Lichess theme names (the previous label map keyed classes on
names that don't exist in the puzzle DB), with a learned **no-tactic** class
mined from real games. A **port of Lichess's own puzzle tagger** proves motifs on
the board and adds them as evidence. Each mistake is shown to the model in the
position that matches how puzzles are built. Results (`reports/stage12_eval/`):

| | Before | v2 |
|---|---|---|
| Held-out puzzles, motif right | 82.2% | **88.0%** |
| Real-game blunders that **allowed** a tactic, family right | 29.4% | **86.7%** |
| Real-game positions where a tactic was **missed**, family right | 74.5% | **89.6%** |
| Profile predicts where the next games' points go (Spearman) | 0.78 | **0.84** |

Hand-labelled check on 150 of the author's own mistakes: the human's family is
among the families attached to a mistake 59% of the time (a fork *with check* is
both loose pieces and king safety — so each mistake carries several types).

### Blindspot families (Stage 2)

Mistakes collapse into a **fixed 5-family taxonomy** by shared skill — clustering
on board geometry produced motif-agnostic clusters (ARI ≈ 0), whereas grouping by
the skill that failed is coherent and trainable. Each family gets a rate per 100
moves **compared with your own opponents** (rating-matched, same games), a
confidence status, the allowed/missed split, your hit rate on available tactics,
and the expected points it costs. Losses of 5–10% count as positional. The family
`cluster_id` string stays the key for the whole intelligence layer. Details in
**instructions/stage1.md**; full backend map in **instructions/AGENT.md**.

---

## The learning surfaces

### The hub (`/home`) — tree navigation
After you import your games you land on a hub of big blocks rather than a
sidebar: **Dashboard**, **Theory → Openings · Endgames**, **Practice → Drills ·
Play vs Maia**, **AI Coach → Chat · Screen Share**, **Analyze → Game Review ·
Analysis Board · Game History**, and **OTB Scan**. Each block opens a page of
sub-blocks with a one-line description; a slim top bar carries the wordmark
(back to the hub), breadcrumbs, blindspot alerts and Settings. The whole tree is
defined once in `frontend/src/nav.ts`. The look is black / white / one neon
(`#C8FF2A`), with graphite chessboards.

### Forked Coach (`/coach`)
- Wide workspace with Coach, Position, Puzzle, Import and Theory modes; optional browser audio.
- Five active tools: investigate a position, fetch a puzzle, analyze supplied PGN/FEN, consult opening theory and consult endgame theory.
- Local investigation validates legal moves, compares candidates and counterfactuals, checks opponent replies and returns an inspectable evidence ledger.
- Shared text/voice narrator uses the existing Groq `openai/gpt-oss-120b` default (overridable with `FORKED_COACH_MODEL`), with local fallback for position explanations.
- Typical answer: verdict, one or two ideas, relevant defense and a concrete continuation up to 3-4 moves when useful.
- No questionnaire gating, stored-profile prompting, personal mistake retrieval or cross-session memory in the active Coach. Those storage modules remain for future work.

### Game Review (`/game-review`)
- Pick one of your **recent Chess.com / Lichess games** in one click, or upload/paste a PGN; Quick/Standard/Deep, streamed move by move.
- Book, Best, Excellent, Good, Inaccuracy, Mistake, Blunder, Miss, Great and Brilliant — Chess.com's bands on a human expected-points curve, plus its described rules: Blunder needs a concrete punishment (material or mate), Miss when a chance was let slip, Great excludes obvious recaptures, Brilliant is a sound near-best sacrifice that was needed. Book = named lines or moves strong Lichess players play often.
- **Accuracy calibrated to Chess.com's stored accuracies** — 3.4 points mean error on held-out games (was 6.7), no bias — and, for Chess.com games, the **official figure shown alongside**. Accuracy by phase.
- **Game rating** from 11K Chess.com rating/accuracy pairs, anchored on the PGN rating when present, with an 80% range.
- Label icon on the destination square, advantage graph with key-moment dots, **Retry** a mistake on the board, best/played lines, export and **Explain the idea**; the board faces the signed-in player.
- Dedicated Stockfish process, cancellation, no paid review API and no daily limit.

### Share Screen (`/share-screen`)
- Tutorial first, then a playable Analysis Board beside the voice controls in the same tab.
- Share the current browser tab, wait 2.5 seconds, then ask about your move or the current position.
- Exact FEN and last move come from Forked's board state; video is not uploaded or interpreted with OCR.
- English spoken replies only, with mute, interrupt, repeat and stale-answer cancellation.
- Defaults to the same configured Groq narrator as text Coach. Disable Coach explanations for local wording. Desktop Chrome/Edge support and speech-service availability are required.

### Openings Explorer  (`/openings`)
- Lazy-loaded tree from the live **Lichess Opening Explorer API**, filtered to your rating band.
- Every node shows a mini-board thumbnail, engine eval, popularity and a WDL bar.
- Detail panel: full board, ECO + name, Stockfish eval, AI-generated "typical ideas".
- Fuzzy opening search ("veina" → Vienna) jumps the tree to any named line.

### Endgames  (`/endgames`) — Theory and Practice
- **Theory** — a hardcoded tree of canonical positions (K+P, K+R, K+Q, minor-piece, rook, pawn endings). Each leaf is **Syzygy-verified** (≤7-piece tablebase) with result, difficulty and key idea.
- **Practice** — a piece configurator (pick exact material or type "queen pawn endgame") fetches an *instructive* position (Lichess puzzle DB first, Stockfish-filtered generation as fallback), then you play it out vs Maia. The result is judged against the theoretical objective ("Correct draw!" / "You drew a winning position").

### Play vs Maia  (`/bot-game`)
- Full games against the **Maia2** human-move model, tuned near your rating, with human-like thinking delays.
- Move history is navigable (click or ← / →), board flips to your colour, check highlighting, promotion dialogue.
- After the game: a **Stockfish accuracy report** (chess.com-style %) and an **Analyse Game** view with engine eval on every move.

### Analysis Board  (`/analysis`)
- Free-play board with live Stockfish eval bar, best-move arrows, move list, flip, FEN copy.
- Opens directly from any position via `?fen=`, from the endgame theory panel, or with a **full game** (`{moves}`/`{pgn}` router state) loaded into the move list — step move-by-move and branch from any point.

### OTB Scan  (`/otb-scan`)  — three ways in
- **Record live** — point your phone at the board; on-device **TFJS** vision (board-corner + piece detectors) calibrates, then tracks every move as you play.
- **Upload a video** — already filmed the game from a steady angle? Upload it and the same CV pipeline calibrates on the first frame and auto-plays through, recording the moves.
- **Upload a scoresheet** — a photo of the written moves is read by a **vision-LLM** (Qwen2.5-VL via Ollama/OpenRouter) with Google Vision / Tesseract fallbacks, into a reviewed PGN. Multi-column sheets are read with a two-pass (full image + right-half crop) strategy; SAN formatting noise (`Qx C7`→`Qxc7`) is auto-repaired and a legality-constrained corrector snaps the rest.
- All three hand the recorded game to the **Analysis Board** as one continuous, playable game.

---

## Tech stack

**Backend** — Python 3.10+, FastAPI, `python-chess` + Stockfish, a **PyTorch
chess transformer** (Stage 1 classifier), Maia2 (PyTorch), Groq (LLM coaches +
the agentic Forked Coach with tool-calling), Pillow (DNA card PNG), SQLite for
caches. Stage 2 is a deterministic family map (no UMAP/HDBSCAN/LLM at request
time). Background annotation + live sync run in worker threads with SSE progress.
Position chat and voice share a Groq narrator and a local evidence fallback.
The optional C1 adapter remains for research scripts, outside these active paths. **OTB Scan** scoresheet OCR uses a vision-LLM
(Qwen2.5-VL via Ollama/OpenRouter) with Google Vision + Tesseract fallbacks and a
python-chess legality layer. In production one process serves both the API and
the built frontend (single-origin).

**Frontend** — React + TypeScript, Vite, `chess.js` + `react-chessboard`,
TanStack Query, Zustand, Tailwind, Framer Motion, **TensorFlow.js** (lazy-loaded,
on-device board/piece detection for OTB Scan). WebSockets for live games,
manual SSE parsing for streaming coach responses.

**Data** — Lichess puzzle DB (100K sample indexed), Lichess Opening Explorer
API, Syzygy tablebase API (`tablebase.lichess.ovh`), curated JSON corpora for
the coaches.

> **No PostgreSQL / pgvector.** Puzzle retrieval filters a local theme-tagged
> index with numpy. All caches (per-game Stockfish lines, eval, ideas, Syzygy,
> suggestions) are SQLite files under `data/`.

---

## Backend API (`backend/`, FastAPI)

The backend is split into nine routers, all mounted on one app (see **instructions/AGENT.md**
for the full architecture):

```
backend/main.py          — ingestion, profile, analytics, drills, analysis, bot-game (+ WS), debrief
backend/openings.py      — opening explorer: explore / eval / ideas
backend/opening_chat.py  — opening coach: chat / chat/stream / suggestions
backend/endgames.py      — endgames: practice-position(/by-config) / syzygy / coach
backend/live_sync.py     — background sync + blindspot alerts
backend/replay.py        — mistake replay: per-cluster mistakes / insight / note / explain
backend/counterfactual.py— counterfactual rating estimate
backend/card.py          — Chess DNA: compute-style / style / dna-card (Pillow PNG)
backend/coach/           — Forked Coach package: chat (SSE+tools) / investigation / live voice; legacy profile storage retained
backend/scoresheet.py    — OTB Scan OCR: /api/ocr/scoresheet (VLM 2-pass / Vision / Tesseract)
backend/scoresheet_parser.py — grid + legality-constrained SAN parser/corrector
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
| **Forked Coach** | `POST /api/coach/chat` (SSE), `POST /api/coach/investigate`, `POST /api/coach/live-turn` |
| **Game Review** | `POST /api/game-review/analyse` (SSE: start/move/done/error), `GET /api/game-review/recent`, `POST /api/game-review/check-move` |
| **OTB Scan** | `POST /api/ocr/scoresheet` (multipart image → reviewed PGN) |
| **Settings** | `GET/PUT /api/settings/{user}`, `GET /api/check/{user}` |

---

## Project structure

```
Forked/
├── requirements.txt
├── CLAUDE.md                          # Project context for Claude Code (kept at root)
├── instructions/                      # All docs + build prompts
│   ├── AGENT.md                       #   Full backend architecture reference
│   ├── stage1.md                      #   Detailed Stage 1 developer reference
│   └── *_PROMPT.md                    #   Feature build prompts (coach, homepage, …)
├── planned_improvements/              # Backlog per stage
├── scripts/
│   ├── setup_stockfish.py             # Download Stockfish binary
│   ├── run_analysis.py                # Stage 1 CLI
│   ├── build_training_data.py         # Classifier training data from Lichess puzzles
│   ├── train_classifier.py            # Train LightGBM threat classifier
│   ├── evaluate_classifier.py         # Evaluate classifier on test set
│   ├── verify_category_alignment.py   # Assert rule-based + ML labels in sync
│   ├── run_puzzle_import.py           # Build the puzzle retrieval index
│   ├── build_endgame_positions.py     # Build endgame.db (+ optional Syzygy verify)
│   ├── run_stage12_bench.py           # Stage 1/2 on frozen benchmark accounts
│   ├── eval_stage12.py                # Stage 1/2 evaluation (legacy vs v2) → reports/stage12_eval/
│   ├── build_gold_set.py              # Hand-labelling page for real mistakes (gold set)
│   ├── collect_accuracy_ratings.py    # Chess.com PubAPI accuracy/rating samples
│   └── calibrate_review.py            # Fit Game Review → backend/review_calibration.json
├── ml/
│   ├── config.py                      # Paths, thresholds, feature flags
│   ├── pipeline.py                    # Stage 1 orchestrator
│   ├── ingestion/                     # fetcher, annotator (+cache, engine pool), winprob,
│   │                                  #   mechanism (allowed/missed), mistake_extractor,
│   │                                  #   maia_annotator, classify_events
│   ├── classifier/                    # transformer/ (Chessformer + v2 training: prepare_data,
│   │                                  #   mine_negatives, train_mt), label_map_v2, verifier
│   ├── clustering/                    # families, profile (peer-relative), profile_pipeline,
│   │                                  #   reclassify, blindspot
│   ├── eval/                          # pre-v2 logic kept only for comparisons
│   ├── matching.py                    # event → family_of(threat_type) (no scaler/reducer)
│   ├── style/extractor.py             # 5-axis Chess DNA style profile + archetype
│   ├── puzzles/                       # importer, retriever (query_by_themes)
│   └── srs/                           # scheduler (SM-2), session builder (family allocation)
├── models/                            # stage1_transformer_v2.pt + _reference_v2.pkl (v1 fallback)
├── backend/
│   ├── main.py                        # Core API + bot-game WebSocket + debrief
│   ├── openings.py                    # Opening explorer router
│   ├── opening_chat.py                # Opening coach (RAG + streaming)
│   ├── endgames.py                    # Endgames router (practice / syzygy / coach)
│   ├── live_sync.py                   # Background sync + blindspot alerts
│   ├── replay.py                      # Mistake Replay (mistakes / insight / note / explain)
│   ├── counterfactual.py              # Counterfactual rating estimate
│   ├── card.py                        # Chess DNA card (Pillow PNG) + style endpoints
│   ├── game_review.py                 # Game Review (+ review_calibration.json, GAME_REVIEW.md)
│   ├── coach/                         # Forked Coach (capstone agentic coach)
│   │   ├── router.py                  #   /api/coach chat (SSE + tools) + endpoints
│   │   ├── profile.py                 #   questionnaire + memory file IO (Layers 1 & 2)
│   │   ├── context.py                 #   live user-context block (Layer 3)
│   │   ├── memory.py                  #   rolling Groq session summary
│   │   ├── tools.py                   #   6 agent tools + dispatch
│   │   └── explain.py                 #   explain_position: C1 → Stockfish fallback
│   ├── scoresheet.py                  # OTB Scan OCR endpoint (VLM 2-pass / Vision / Tesseract)
│   ├── scoresheet_parser.py           # Grid + legality-constrained SAN parser/corrector
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
│       ├── nav.ts                     # Navigation tree (hub blocks → sub-blocks)
│       ├── theme.ts                   # Neon / graphite colour constants
│       ├── pages/                     # Hub, Dashboard, Coach, GameReview, PuzzleSession, OpeningExplorer,
│       │                              #   Endgames, BotGame, AnalysisBoard,
│       │                              #   MistakeReplay, DNAPage, …
│       ├── features/otb-scan/         # OTB Scan (lazy; TFJS): OTBScanPage + screens/cv/game/hooks
│       ├── components/
│       │   ├── layout/                # AppShell (top bar + breadcrumbs), SectionHeader, ChessBackground
│       │   ├── review/                # ReviewGraph, RecentGames
│       │   ├── coach/                 # CoachBoard (inline puzzle / view / review board)
│       │   ├── openings/              # OpeningTree, OpeningDetail, OpeningCoachChat,
│       │   │                          #   MiniBoardThumbnail
│       │   ├── endgames/              # EndgameTree, EndgameDetail, EndgamePractice,
│       │   │                          #   EndgameCoach, PieceConfigurator
│       │   ├── dashboard/             # BlindspotAlerts, RatingImpact
│       │   ├── BotGameDebrief.tsx     # Post-game blindspot debrief
│       │   └── ChessDNACard.tsx       # Style archetype + axis bars
│       ├── hooks/                     # useGameReview, useAudioCoach (STT/TTS)
│       ├── data/                      # endgameTree.ts, openings_index.json
│       └── api/                       # index, coach, openings, endgames, replay, insights, live, ws
└── tests/                             # test_stage12 (pipeline v2), test_game_review, coach tests, …
```

---

## Setup

### Prerequisites
- Python 3.10+, Node.js 18+, Windows / macOS / Linux

### 1 — Clone and install
```bash
git clone https://github.com/ShahuPatil07/Forked.chess.git
cd Forked.chess

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
GROQ_API_KEY=gsk_...     # Free at console.groq.com — powers the LLM coaches, the Forked Coach + insights
LICHESS_TOKEN=lip_...    # Free at lichess.org/account/oauth/token — needed for the Opening Explorer API
FORKED_COACH_MODEL=openai/gpt-oss-120b  # Existing Groq-hosted narrator; no OpenAI key
# C1_ENDPOINT=http://... # Optional research adapter, not used by active chat/voice
# OTB Scan scoresheet OCR (optional; pick one). Vision-LLM is best for handwriting:
# VLM_OCR_BASE=http://localhost:11434/v1   # local Ollama (free/offline)
# VLM_OCR_MODEL=qwen2.5vl:7b
# GOOGLE_VISION_API_KEY=...                # fallback; else local Tesseract is used
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

Open `http://localhost:5173`, enter your Lichess/Chess.com username and import
your games; you land on the hub when the import finishes (about 25 minutes for
150 games on a typical laptop, cached per game afterwards). The Openings,
Endgames, Coach, Game Review and Play-vs-Maia sections work without a profile.

> `models/` and `data/` are not in git. The trained Stage-1 checkpoints
> (`models/stage1_transformer_v2.pt` + `stage1_reference_v2.pkl`, or the v1
> fallback) must be copied in or retrained (below).

---

## Standalone CLI (blindspot pipeline)

```bash
python scripts/run_analysis.py ShahuPatil07 --platform lichess --games 80
# → data/output/ShahuPatil07_mistakes.json

# Relabel saved mistakes with the current model + rebuild the profile (no Stockfish):
python -m ml.clustering.reclassify ShahuPatil07

# Rebuild the v2 classifier (CPU is fine; ~3 h fine-tune from v1):
python -m ml.classifier.transformer.prepare_data      # needs data/raw/lichess_db_puzzle.csv.zst
python -m ml.classifier.transformer.mine_negatives
python -m ml.classifier.transformer.train_mt --minutes 170
python -m ml.classifier.transformer.predict --fit-v2

# Evaluate Stage 1/2 (legacy vs v2) and recalibrate Game Review:
python scripts/run_stage12_bench.py && python scripts/eval_stage12.py --all
python scripts/collect_accuracy_ratings.py --save-pgn && python scripts/calibrate_review.py
```

---

## Key configuration (`ml/config.py`)

| Variable | Default | Meaning |
|---|---|---|
| `GAME_TIME_CLASSES` | `rapid` | Rated standard games that feed the profile (`FORKED_TIME_CLASSES`) |
| `ANNOTATION_DEPTH_FAST` | 12 | Stockfish depth for the screen of every position |
| `ANNOTATION_DEPTH_FULL` | 18 | Depth for flagged moves and possible tactics |
| `MISTAKE_ES` / `INACCURACY_ES` (`ml/ingestion/winprob.py`) | 0.10 / 0.05 | Win-probability loss for a mistake / a positional inaccuracy |
| `USE_MAIA2` | True | Maia2 "how avoidable at your rating" weight |
| `FORKED_SF_WORKERS` (env) | min(6, cores−2) | Stockfish processes for ingestion |

---

## Key design decisions

**Show the classifier the right position** — Lichess puzzles are "the position after a blunder + the winning reply". A mistake that *allowed* a tactic is therefore classified on the position after your move with the opponent's refutation; one that *missed* a tactic on the position before it. Doing this took real-game family accuracy on allowed mistakes from 29% to 87%.

**Win probability, not centipawns** — +9 → +6 is not a mistake; 0 → −1.5 is. Mistakes use Lichess's win-probability curve, and Game Review uses a human expected-points curve fitted to real results instead of Stockfish's engine-game model.

**Your opponents are the baseline** — everyone at 1200 hangs pieces; a blindspot is what you do *more* than players at your level. Opponents' moves are already analysed, so the rating-matched peer rate costs nothing.

**Calibrate against real targets** — Game Review accuracy and game rating are fitted to Chess.com's stored accuracies from its public API, and every claim in this README comes from a reproducible script under `scripts/` with results in `reports/`.

**Curated corpora, not a full RAG scrape** — both coaches are grounded in hand-curated JSON corpora (openings + endgames) injected by ECO/material/keyword match, plus live data (Lichess stats / Syzygy). No vector DB, no multi-hour scrape, sources still cited.

**Syzygy as ground truth** — endgame results and the post-game verdict are checked against the Lichess tablebase (≤7 pieces). The coach cites it as verified fact, not opinion — the unique trust signal vs generic chess AI.

**Instructive endgame positions** — practice positions come from real Lichess endgame puzzles first; rare configurations fall back to Stockfish-filtered random generation (balanced eval, long PV, enough legal moves) so positions reward technique instead of being trivially won.

**Maia first-move guard** — Maia2 is out-of-distribution when a piece is developed before any pawn move, so the bot's first move is forced to a central pawn; an OOD retreat filter catches the rest. The bot-game WebSocket decides who opens by side-to-move vs the user's colour (so endgame practice from any FEN works), not by assuming "user is black".

**Deterministic blindspot families, not learned clustering** — Stage 2 maps each mistake's threat type to one of 5 fixed skill families (no UMAP/HDBSCAN/LLM at request time). Clustering on board geometry produced motif-agnostic clusters (ARI ≈ 0); grouping by the failed skill is coherent, instant, and gives **stable keys**. The whole intelligence layer (live alerts, debrief, replay, counterfactual, DNA, coach) matches a fresh mistake by `family_of(threat_type)` — the family `cluster_id` is the key; the display label is never used for matching.

**Evidence-based coaching with a local fallback** - position investigation runs before narration. MultiPV, constrained alternatives, independent defenses and legal board facts feed the shared Coach/voice narrator. A bounded five-tool loop handles general questions; local position explanations remain available without a hosted provider. Prose guards are conservative checks, not a general proof of strategic correctness.

**Bounded counterfactual rating** — the rating estimate uses a performance-rating model over real game results (re-fetched, since game metadata doesn't store outcomes) and is capped — an early flat per-game-Elo version produced fantasy +1000-point ratings.

**Chess DNA from the mistake set** — the 5 style axes are derived from the existing mistake/eval data with documented proxies rather than re-annotating every move; axes without enough data are omitted from the card instead of guessed.

**Free tools** - review runs entirely on local Stockfish and bundled CC0 opening data. Coach uses the existing configured Groq free-tier workflow, subject to account/model quotas, with local position fallback. Browser speech adds no paid API. No new paid service is introduced.

**SQLite + numpy, not a database** — every cache (eval, ideas, Syzygy, suggestions, puzzle vectors) is a file under `data/`. Zero infra to run locally.

---

## Competitive context

| | Forked | Chess.com Learn | Lichess | Chessable |
|---|---|---|---|---|
| Uses your real games | Yes | No | No | No |
| Detects personal blindspots | Yes | No | No | No |
| Agentic coach that knows your games | Yes | No | No | No |
| Spaced repetition | Yes (per blindspot) | No | No | Yes (openings) |
| Resets on live blunders | Yes | No | No | No |
| Opening tree + AI ideas + eval per node | Yes | Partial | Partial | No |
| Endgame trainer vs human-like bot | Yes | Partial | No | No |
| Tablebase-verified endgame coach | Yes | No | No | No |
| Requires login | No (username only) | Yes | Yes | Yes |
| Focus | Whole-game improvement | General | Generic tactics | Openings |

## Validate the current coaching/review slice

```powershell
.venv/Scripts/python.exe -m pytest tests/test_stage12.py tests/test_game_review.py tests/test_coach_investigation.py tests/test_coach_live.py -q -p no:cacheprovider
npm.cmd --prefix frontend run build
# With both local servers running and Chrome installed:
node scripts/test_share_screen.cjs
node scripts/test_game_review.cjs
```

For hands-on validation, try the Opera Game sample in Game Review, upload a game
containing a known blunder, compare a quiet developing move in Coach and voice,
and move again while a voice answer is being calculated. Detailed procedures and
known limitations are in the linked Coach/voice/review handoffs above.
