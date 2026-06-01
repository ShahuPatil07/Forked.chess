# Forked — Claude Code context

## What this is (current reality)

Forked is a full adaptive chess training platform. It began as a personalised
blindspot trainer and now has five surfaces plus an intelligence layer, all
sharing one engine + data stack:

1. **Blindspot Profile + Drills** — pull a user's last 80–200 games, annotate
   with Stockfish, cluster their mistakes with ML, name the top blindspots, and
   serve spaced-repetition puzzles targeting them.
2. **Openings** — interactive opening tree from the Lichess Explorer API +
   per-node eval/WDL/AI-ideas + a streaming RAG opening coach.
3. **Endgames** — Syzygy-verified theory tree + practice vs Maia from any
   material config + a tablebase-grounded endgame coach.
4. **Play vs Maia** — full games vs the Maia2 human-move model with a post-game
   Stockfish accuracy report, blindspot debrief, and analysis view.
5. **Analysis Board** — free-play board with live Stockfish eval.

**Intelligence layer** (all keyed on `cluster_id` + centroid, never the LLM label):
- **Live sync + alerts** — background poll for new games, re-run Stage 1, and
  alert when a known blindspot cluster is repeated (cosine > 0.72).
- **Post-game debrief** — cross-references Maia-game mistakes against the user's
  clusters ("you triggered 1 known weakness").
- **Mistake Replay** — walk every real-game position in a cluster, with eval
  bar, free exploration, per-position "Notice", and a Groq pattern insight.
- **Counterfactual rating** — bounded performance-rating estimate of the points
  recoverable by fixing each cluster.
- **Chess DNA card** — shareable PNG: 5-axis style archetype + blindspots +
  counterfactual, with a public `/dna/{user}` landing page.

Product name: **Forked**. Tagline: *"A coach who knows exactly how you lose."*

> This file describes the product **as built**. An earlier version of this file
> contained a 6-week MVP plan with aspirational tech (pgvector, Celery/Redis,
> Leela embeddings). That plan was superseded — see "Actual stack" below.

---

## Actual stack (what's really used)

**Backend** — Python 3.10+, FastAPI (single app, seven routers mounted on
`main`), `python-chess` + Stockfish, LightGBM, scikit-learn (HDBSCAN),
umap-learn, Maia2 (PyTorch CPU), Groq for LLM, Pillow (DNA card PNG),
**SQLite** for all caches. Background annotation + live sync = worker/daemon
threads + SSE progress (no Celery/Redis). Embeddings = 16-dim UMAP, searched
with numpy L2 in memory (no pgvector/Qdrant — never add a database without
asking).

**Frontend** — React + TypeScript + Vite, `chess.js` + `react-chessboard`,
TanStack Query, Zustand (`useUserStore`, persisted to localStorage), Tailwind,
Framer Motion. Live games over WebSocket; streaming coach responses over SSE
parsed manually (EventSource can't POST).

**External data** — Lichess Opening Explorer API (needs `LICHESS_TOKEN`),
Syzygy tablebase API (`tablebase.lichess.ovh`, ≤7 pieces), Lichess puzzle DB
(100K sample indexed locally), Groq (`GROQ_API_KEY`, model
`llama-3.3-70b-versatile`).

---

## Repo map

```
backend/                 (7 routers, all mounted on main's FastAPI app)
  main.py          ingestion, profile, drills, analysis, settings, bot-game (+WS), accuracy
  openings.py      /api/openings/explore | /eval | /ideas   (SQLite cache: opening_cache.db)
  opening_chat.py  /api/openings/chat(/stream) | /chat/suggestions   (curated corpus + Lichess stats)
  endgames.py      /api/endgames/practice-position(/by-config) | /syzygy | /coach/chat(/stream) | /coach/suggestions
  live_sync.py     background per-user sync; /api/alerts | /api/sync/{status,trigger}
  replay.py        /api/cluster/{u}/{cid}/mistakes | /insight | /note | /explain   (Mistake Replay)
  counterfactual.py  /api/profile/{u}/counterfactual   (bounded perf-rating estimate)
  card.py          /api/profile/{u}/{compute-style,style,dna-card,card}   (Chess DNA PNG via Pillow)
  bot/maia_engine.py     Maia2 move generator (singleton, first-move guard, OOD retreat filter)
  bot/thinking_delay.py  human-like async delay
  (debrief lives in main.py: POST /api/bot-game/{id}/debrief)

ml/                core blindspot pipeline (ingestion → clustering → puzzles → srs)
  config.py        paths, thresholds, feature flags, STOCKFISH_PATH, REQUEST_HEADERS
  classifier/      HybridThreatClassifier (rule → depth → LightGBM)
  matching.py      project a fresh event → UMAP → nearest cluster centroid (cosine)
  style/extractor.py  5-axis style profile + archetype (Chess DNA), run after clustering

data/
  opening_cache.db, endgame.db          SQLite caches (auto-created)
  opening_knowledge.json                curated opening coach corpus (47 entries)
  endgame_knowledge.json                curated endgame coach corpus (25 entries)
  endgame_positions.json                curated practice positions (66)
  puzzles/                              Lichess puzzle index (index.npz + meta.json)
  output/{user}_{mistakes,clusters,settings,scaler.pkl,reducer.pkl,
         alerts,sync,style,counterfactual,dna_card.png,...}   per-user state

frontend/src/
  pages/           Dashboard, PuzzleSession, OpeningExplorer, Endgames, BotGame,
                   AnalysisBoard, MistakeReplay, DNAPage, GameHistory, Settings, …
  components/layout/   AppShell (nav), SectionHeader (shared page header), ChessBackground
  components/openings/ OpeningTree, OpeningDetail, OpeningCoachChat, MiniBoardThumbnail
  components/endgames/ EndgameTree, EndgameDetail, EndgamePractice, EndgameCoach, PieceConfigurator
  components/dashboard/ BlindspotAlerts (live-sync banner), RatingImpact (counterfactual + DNA share)
  components/       BotGameDebrief, ChessDNACard
  hooks/useGameReview.ts    move-history review (click + ← / →), used by practice + bot game
  data/endgameTree.ts       hardcoded endgame theory tree (canonical FENs)
  data/openings_index.json  named openings for fuzzy search
  api/                      typed clients (index, openings, endgames, replay, insights, live)
```

---

## Core pipeline facts (blindspot loop)

- **Stage 1** — fetch (Lichess/Chess.com public API, username only) → two-pass
  Stockfish (depth-12 screen, depth-18 on mistakes) → mistake events at
  `eval_drop ≥ 100cp` → `HybridThreatClassifier` (rule-based → depth lookahead →
  LightGBM) → Maia2 filter (drop universally-hard positions).
- **Stage 2** — 122-dim feature vector per event (64 board + 10 material + 12
  pawn + 8 king-safety + 28 context) → StandardScaler → UMAP-16 → HDBSCAN →
  Groq names each cluster. Score = frequency × recency × (1 − mastery).
- **Stage 3** — 100K Lichess puzzles in the same UMAP space; nearest-neighbour
  per cluster centroid, filtered by threat type + rating; SM-2 SRS, mastery
  resets on repeated live blunders.
- Classifier: 14 threat types, 63.5% F1, 805-dim raw bitboard features (no PCA).
  Full reference in `stage1.md`.

---

## Feature-specific notes

**Openings** — `explore` proxies the Lichess Explorer (24h SQLite cache, ELO
bucketed); `eval` is Stockfish depth-16 cached forever; `ideas` is Groq cached
forever. The coach (`opening_chat.py`) injects a curated corpus by ECO/keyword +
live Lichess stats, streams via SSE, cites sources.

**Endgames** — theory tree is static (`frontend/src/data/endgameTree.ts`, all
FENs validated legal). Practice: `by-config` finds an instructive position —
Lichess endgame puzzles first (exact material match, post-trigger position),
Stockfish-filtered generation as fallback — then enriches with depth-12 eval for
the auto-description. Reuses the bot-game WebSocket by passing `starting_fen`.
Outcome is judged vs the Syzygy/eval objective. Coach injects Syzygy as verified
fact ("Tablebase verified" badge).

**Play vs Maia** — `bot/maia_engine.py` is a module-level Maia2 singleton.
Critical: Maia2 is OOD when a piece is developed before any pawn move, so the
**first move is forced to a central pawn**, and an OOD retreat filter rejects
"put the piece back" predictions. `bot-game/create` accepts `starting_fen` +
`target_elo`. Accuracy endpoint = chess.com-style % from win-prob loss per move.
The WS handler decides who moves first by **side-to-move vs user_color**
(`side_to_move != user_color → bot opens`), NOT "user is black" — that older
assumption deadlocked endgame practice when Black was to move from a custom FEN.

**Intelligence layer (cluster identity rule)** — live-sync, debrief, replay,
and counterfactual all identify clusters by **`cluster_id` + centroid only**;
the LLM label is display-only and may change on re-cluster. A fresh mistake is
matched by projecting its 122-dim vector through the persisted scaler + UMAP
reducer (`ml/matching.py`) and taking the nearest centroid (alert threshold
cosine > 0.72; replay/counterfactual use nearest-without-threshold). The
counterfactual re-fetches game results (chess.com via the archives-list
endpoint, lichess via export) since `game_meta.json` lacks result/opponent-elo,
then uses a **bounded performance-rating** model — never flat per-game Elo
(that produced fantasy +1000 ratings). Chess DNA style axes are computed from
the mistake dataset with documented proxies (no full-game re-annotation);
axes with too little data are reported `None` and omitted from the card.

**Shared frontend** — every page uses `SectionHeader` (gradient ForkedWordmark +
icon + description). `useGameReview` powers clickable / arrow-key move history.
`MiniBoardThumbnail` is a pure-CSS board for dense tree rows (don't use
`react-chessboard` for many small boards).

---

## Conventions & gotchas

- **Windows + Python 3.12**: `backend/main.py` forces
  `WindowsProactorEventLoopPolicy` (top of file *and* inside worker threads) so
  `chess.engine.popen_uci` can spawn Stockfish. Keep that.
- **Stockfish singleton** lives in `backend/main.py` (`_sf_lock`, `_ensure_engine`).
  Other routers import it. Always hold `_sf_lock` around `engine.analyse`.
- **SQLite caches auto-create** on import (`_init_db`); columns are added with
  idempotent `ALTER TABLE … ADD COLUMN` wrapped in try/except.
- **Coaches stream over SSE** with a `meta` event first (sources, flags), then
  `token` events, then `done`. Frontend parses with a manual `ReadableStream`
  reader (not EventSource).
- **`.env`** needs `GROQ_API_KEY` (coaches + cluster naming) and `LICHESS_TOKEN`
  (Opening Explorer returns 401 without it on many networks).
- **Verify after edits**: `cd frontend && npx tsc --noEmit` (must be 0 errors)
  and `npx vite build` for runtime integrity. For backend, import-check
  `backend/main.py` and confirm routes register.
- **Don't add new heavy deps** (pgvector, a vector DB, sentence-transformers,
  Celery/Redis) without asking — the project is deliberately SQLite + numpy +
  curated JSON. Prefer curated corpora over scraping. (Pillow is in for the DNA
  card; it's the only image dep.)
- **Cluster identity**: never match/compare on the LLM label string — always
  `cluster_id` + centroid. New per-user state files: `_alerts.json`, `_sync.json`,
  `_style.json`, `_counterfactual.json`, `_dna_card.png` (all under `data/output/`).
- Curated corpora (`opening_knowledge.json`, `endgame_knowledge.json`,
  `endgame_positions.json`) and `endgameTree.ts` are hand-maintained — extend
  them in place; keep all FENs legal (validate with `python-chess`).

---

## What we are NOT building (still out of scope)

- Puzzle synthesis (retrieval only — Lichess has 50M puzzles)
- Social / multiplayer, coaching marketplace
- Native mobile app (web-responsive only)
- A real database / auth system (username-only, file-backed by design)
