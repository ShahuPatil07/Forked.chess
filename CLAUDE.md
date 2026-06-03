# Forked — Claude Code context

## What this is (current reality)

Forked is a full adaptive chess training platform. It began as a personalised
blindspot trainer and now has six surfaces plus an intelligence layer, all
sharing one engine + data stack:

1. **Blindspot Profile + Drills** — pull a user's last 80–200 games, annotate
   with Stockfish, classify each mistake with a **chess transformer (83.1%)**,
   group them into **5 fixed skill families**, and serve theme-matched
   spaced-repetition puzzles targeting the top families.
2. **Forked Coach** (capstone) — a persistent agentic coach (Groq Llama-3.3-70B
   + 6 tools) that knows the user's games, blindspots, drills and history;
   streams answers, shows inline solvable puzzles, analyses pasted games,
   explains positions (C1→Stockfish fallback), remembers prior sessions, and
   talks (audio mode). Lives in `backend/coach/`; full map in **instructions/AGENT.md**.
3. **Openings** — interactive opening tree from the Lichess Explorer API +
   per-node eval/WDL/AI-ideas + a streaming RAG opening coach.
4. **Endgames** — Syzygy-verified theory tree + practice vs Maia from any
   material config + a tablebase-grounded endgame coach.
5. **Play vs Maia** — full games vs the Maia2 human-move model with a post-game
   Stockfish accuracy report, blindspot debrief, and analysis view.
6. **Analysis Board** — free-play board with live Stockfish eval.

**Intelligence layer** (all keyed on the family `cluster_id`, never the LLM label):
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

**Backend** — Python 3.10+, FastAPI (single app, **eight routers** mounted on
`main`), `python-chess` + Stockfish, a **PyTorch chess transformer** (Stage-1
classifier), Maia2 (PyTorch CPU), Groq for LLM (coaches + the agentic Forked
Coach with tool-calling), Pillow (DNA card PNG), **SQLite** for all caches.
Stage 2 is a **deterministic 5-family map** (no UMAP/HDBSCAN/LLM at request
time). Background annotation + live sync = worker/daemon threads + SSE progress
(no Celery/Redis). Puzzle retrieval = numpy over a local theme-tagged index (no
pgvector/Qdrant — never add a database without asking). Position explanation
prefers **C1** (CSSLab, via a vLLM endpoint when `C1_ENDPOINT` is set) and always
falls back to Stockfish.

> `scikit-learn`/`umap-learn`/`LightGBM` are legacy (old Stage 1/2); the live
> path no longer uses them. The old `ml/clustering/pipeline.py` and LightGBM
> scripts are kept for rollback only.

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
backend/                 (8 routers, all mounted on main's FastAPI app)
  main.py          ingestion, profile, analytics, drills, analysis, settings, bot-game (+WS), accuracy
  openings.py      /api/openings/explore | /eval | /ideas   (SQLite cache: opening_cache.db)
  opening_chat.py  /api/openings/chat(/stream) | /chat/suggestions   (curated corpus + Lichess stats)
  endgames.py      /api/endgames/practice-position(/by-config) | /syzygy | /coach/chat(/stream) | /coach/suggestions
  live_sync.py     background per-user sync; /api/alerts | /api/sync/{status,trigger}
  replay.py        /api/cluster/{u}/{cid}/mistakes | /insight | /note | /explain   (Mistake Replay)
  counterfactual.py  /api/profile/{u}/counterfactual   (bounded perf-rating estimate)
  card.py          /api/profile/{u}/{compute-style,style,dna-card,card}   (Chess DNA PNG via Pillow)
  coach/           Forked Coach package (capstone) — see instructions/AGENT.md §5
    router.py      /api/coach/chat (SSE+tools) | save-questionnaire | profile | update-memory
    profile.py     questionnaire + rolling memory file IO (Layers 1 & 2)
    context.py     live user-context block (Layer 3), built every session
    memory.py      Groq session-summary updater
    tools.py       6 agent tools (schemas + dispatch)
    explain.py     explain_position: C1 (vLLM endpoint) → Stockfish fallback
  bot/maia_engine.py     Maia2 move generator (singleton, first-move guard, OOD retreat filter)
  bot/thinking_delay.py  human-like async delay
  (debrief lives in main.py: POST /api/bot-game/{id}/debrief)

ml/                core blindspot pipeline (ingestion → families → puzzles → srs)
  config.py        paths, thresholds, feature flags, STOCKFISH_PATH, REQUEST_HEADERS
  classifier/transformer/  Chessformer (board_encoding, model, predict, classifier) — Stage 1
  clustering/      families.py (5-family map), profile.py, profile_pipeline.py (run_clustering)
  matching.py      project a fresh event → family_of(threat_type)  (no scaler/reducer/centroid)
  puzzles/retriever.py  local theme-tagged puzzle index + query_by_themes (Stage 3)
  srs/             SM-2 scheduler + session builder (per-family puzzle allocation)
  style/extractor.py  5-axis style profile + archetype (Chess DNA), run after clustering

data/
  opening_cache.db, endgame.db          SQLite caches (auto-created)
  opening_knowledge.json                curated opening coach corpus (47 entries)
  endgame_knowledge.json                curated endgame coach corpus (25 entries)
  endgame_positions.json                curated practice positions (66)
  puzzles/                              Lichess puzzle index (index.npz + meta.json w/ themes)
  output/{user}_{mistakes,clusters,profile,settings,srs,alerts,sync,style,
         counterfactual,dna_card.png,coach_profile,coach_memory,...}   per-user state
models/  stage1_transformer.pt, stage1_reference.pkl   (Stage-1 transformer)

frontend/src/
  pages/           Dashboard, Coach, PuzzleSession, OpeningExplorer, Endgames, BotGame,
                   AnalysisBoard, MistakeReplay, DNAPage, GameHistory, Settings, …
  components/layout/   AppShell (nav, Coach has an "AI" badge), SectionHeader, ChessBackground
  components/coach/    CoachBoard (inline puzzle / view / navigable-review board)
  components/openings/ OpeningTree, OpeningDetail, OpeningCoachChat, MiniBoardThumbnail
  components/endgames/ EndgameTree, EndgameDetail, EndgamePractice, EndgameCoach, PieceConfigurator
  components/dashboard/ BlindspotAlerts (live-sync banner), RatingImpact (counterfactual + DNA share)
  components/       BotGameDebrief, ChessDNACard
  hooks/useGameReview.ts    move-history review (click + ← / →), used by practice + bot game
  hooks/useAudioCoach.ts    Web Speech STT/TTS for the coach's audio mode
  data/endgameTree.ts       hardcoded endgame theory tree (canonical FENs)
  data/openings_index.json  named openings for fuzzy search
  api/                      typed clients (index, coach, openings, endgames, replay, insights, live)
```

---

## Core pipeline facts (blindspot loop)

- **Stage 1** — fetch (Lichess/Chess.com public API, username only) → two-pass
  Stockfish (depth-12 screen, depth-18 on mistakes) → mistake events at
  `eval_drop ≥ 100cp` → **transformer classifier** (`ml/classifier/transformer/`,
  pure Chessformer — the rule→depth→LightGBM funnel was dropped) → Maia2 filter
  (drop universally-hard positions). Positional/OOD positions route to `other`.
- **Stage 2** — `family_of(threat_type)` maps each mistake to 1 of **5 fixed
  skill families** (loose_pieces, alignment, defender_disruption, king_safety,
  positional) + an `unclassified` bucket. `run_clustering` scores each family
  `frequency × recency × severity` (eval-drop capped at 1000cp), writes
  `_clusters.json` + `_profile.json`, and **re-persists `_mistakes.json` with the
  family `cluster_id`** (downstream consumers filter mistakes by it). No
  UMAP/HDBSCAN/LLM, no scaler/reducer.
- **Stage 3** — local puzzle index tagged with Lichess themes; `allocate_puzzles`
  splits the budget across families by score, `query_by_themes` pulls matching
  puzzles in the user's rating band; SM-2 SRS, mastery resets on live blunders.
- Classifier: 14 threat types, **83.1% accuracy** (was 63.5% with LightGBM).
  Stage-1 detail in `instructions/stage1.md`; full backend architecture in **instructions/AGENT.md**.

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
and counterfactual all identify clusters by the **family `cluster_id`** (the
skill-family key string); the LLM label is display-only. A fresh mistake is
matched simply by `family_of(threat_type)` (`ml/matching.py`) — no embedding
projection, no scaler/reducer, no centroid distance. `match_events` returns
matched for tactical families, unmatched for `unclassified`/positional (the
alert threshold/cosine API is preserved for compatibility but matching is now
exact). The counterfactual re-fetches game results (chess.com via the
archives-list endpoint, lichess via export) since `game_meta.json` lacks
result/opponent-elo, then uses a **bounded performance-rating** model — never
flat per-game Elo (that produced fantasy +1000 ratings). Chess DNA style axes
are computed from the mistake dataset with documented proxies (no full-game
re-annotation); axes with too little data are reported `None` and omitted.

**Forked Coach** — `backend/coach/` package (see instructions/AGENT.md §5). Groq
`llama-3.3-70b-versatile` + 6 tools, streamed over SSE with a bounded
tool-call loop (`meta` → `tool`/`tool_result` → `token` → `done`). Three layers:
questionnaire (`_coach_profile.json`), rolling memory (`_coach_memory.json`),
and a live context block built every session (theory mode omits it). `explain.py`
prefers C1 (vLLM endpoint via `C1_ENDPOINT`) and **always** falls back to
Stockfish — never block the feature on C1. Guard against Llama's `tool_use_failed`
(salvage `failed_generation`, else retry without tools) stays in `router._create`.
Dashboard `/api/profile` carries per-cluster `enrichment` (severity, time-pressure,
phases, recency) and `/api/analytics` carries severity/time-pressure/Maia
summaries — both derived from `_mistakes.json`, robust to missing fields.

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
- **`.env`** needs `GROQ_API_KEY` (coaches, Forked Coach, insights) and
  `LICHESS_TOKEN` (Opening Explorer returns 401 without it on many networks).
  Optional `C1_ENDPOINT` (+ `C1_API_KEY`, `C1_MODEL`) points `explain_position`
  at a vLLM C1 server; omit it and Stockfish is used.
- **Verify after edits**: `cd frontend && npx tsc --noEmit` (must be 0 errors)
  and `npx vite build` for runtime integrity. For backend, import-check
  `backend/main.py` and confirm routes register.
- **Don't add new heavy deps** (pgvector, a vector DB, sentence-transformers,
  Celery/Redis) without asking — the project is deliberately SQLite + numpy +
  curated JSON. Prefer curated corpora over scraping. (Pillow is in for the DNA
  card; it's the only image dep.)
- **Cluster identity**: never match/compare on the LLM label string — always the
  family `cluster_id` (`family_of(threat_type)`). Per-user state files under
  `data/output/`: `_alerts.json`, `_sync.json`, `_style.json`,
  `_counterfactual.json`, `_dna_card.png`, `_coach_profile.json`,
  `_coach_memory.json`. After Stage 2, `_mistakes.json` carries each event's
  family `cluster_id` — `run_clustering` re-persists it.
- Curated corpora (`opening_knowledge.json`, `endgame_knowledge.json`,
  `endgame_positions.json`) and `endgameTree.ts` are hand-maintained — extend
  them in place; keep all FENs legal (validate with `python-chess`).

---

## What we are NOT building (still out of scope)

- Puzzle synthesis (retrieval only — Lichess has 50M puzzles)
- Social / multiplayer, coaching marketplace
- Native mobile app (web-responsive only)
- A real database / auth system (username-only, file-backed by design)
