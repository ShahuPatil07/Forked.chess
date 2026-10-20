# Forked — Claude Code context

## What this is (current reality)

Forked is a full adaptive chess training platform. It began as a personalised
blindspot trainer and now has seven surfaces plus an intelligence layer, all
sharing one engine + data stack:

1. **Blindspot Profile + Drills** — pull a user's last 80–200 rated rapid games,
   annotate with Stockfish (cached), find mistakes by win-probability loss, tag
   each as **allowed vs missed**, classify it in the matching position with a
   **multi-label chess transformer + Lichess-tagger verifier** (87% right family
   on held-out real-game blunders it allowed, vs 29% before v2), group into
   **5 fixed skill families** scored **against rating-matched peers** (the
   user's own opponents), and serve theme-matched spaced-repetition puzzles
   targeting the top families.
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
6. **Analysis Board** — free-play board with live Stockfish eval. Also accepts a
   full game via router state (`{moves}` / `{pgn}`) — loads it into the move list
   as one continuous, steppable, branchable game (used by the OTB Scan hand-off).
7. **OTB Scan** — digitise an over-the-board game three ways: record live (phone
   camera + on-device TFJS vision), **upload a video** of the game, or photograph
   a **scoresheet** (VLM/OCR → PGN). All three hand off to the Analysis Board.
   Lives in `frontend/src/features/otb-scan/` + `backend/scoresheet*.py`.

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
backend/                 (9 routers, all mounted on main's FastAPI app)
  main.py          ingestion, profile, analytics, drills, analysis, settings, bot-game (+WS), accuracy
                   (+ single-origin static serving of frontend/dist in prod)
  openings.py      /api/openings/explore | /eval | /ideas   (SQLite cache: opening_cache.db)
  opening_chat.py  /api/openings/chat(/stream) | /chat/suggestions   (curated corpus + Lichess stats)
  endgames.py      /api/endgames/practice-position(/by-config) | /syzygy | /coach/chat(/stream) | /coach/suggestions
  live_sync.py     background per-user sync; /api/alerts | /api/sync/{status,trigger}
  replay.py        /api/cluster/{u}/{cid}/mistakes | /insight | /note | /explain   (Mistake Replay)
  counterfactual.py  /api/profile/{u}/counterfactual   (bounded perf-rating estimate)
  card.py          /api/profile/{u}/{compute-style,style,dna-card,card}   (Chess DNA PNG via Pillow)
  coach/           Forked Coach package (capstone) — see backend/coach/README.md
    agent/         v2 agent: llm (free provider chain), engine, features, tools, prompt, verify, loop
    router.py      /api/coach/chat (SSE+tools) | save-questionnaire | profile | update-memory
    profile.py     questionnaire + rolling memory file IO (Layers 1 & 2)
    context.py     live user-context block (Layer 3), built every session
    memory.py      Groq session-summary updater
    tools.py       6 agent tools (schemas + dispatch)
    explain.py     explain_position: C1 (vLLM endpoint) → Stockfish fallback
  scoresheet.py    /api/ocr/scoresheet  (OTB Scan OCR: VLM 2-pass → Google Vision → Tesseract)
  scoresheet_parser.py  grid + legality-constrained SAN parser/corrector
  bot/maia_engine.py     Maia2 move generator (singleton, first-move guard, OOD retreat filter)
  bot/thinking_delay.py  human-like async delay
  (debrief lives in main.py: POST /api/bot-game/{id}/debrief)

ml/                core blindspot pipeline (ingestion → families → puzzles → srs)
  config.py        paths, thresholds, GAME_TIME_CLASSES (rapid), STOCKFISH_PATH, REQUEST_HEADERS
  pipeline.py      Stage-1 orchestration: fetch → engine pool → extract → Maia2 → classify → save
  ingestion/       fetcher, annotator (+annotation_cache.py SQLite, engine_pool.py), winprob.py,
                   mechanism.py (allowed/missed), mistake_extractor.py (both sides, opportunities,
                   cascades), maia_annotator.py (personalness), classify_events.py (framing + verifier)
  classifier/transformer/  Chessformer (board_encoding, model, predict, classifier) + v2 training
                   (prepare_data, mine_negatives, train_mt) — Stage 1
  classifier/label_map_v2.py  17 multi-label motif classes from the REAL Lichess theme names
  classifier/verifier.py      port of lichess-puzzler cook.py motif detectors (evidence + silver labels)
  clustering/      families.py (5-family map), profile.py (peer-relative v2 scoring),
                   profile_pipeline.py (run_clustering), reclassify.py (relabel without Stockfish)
  eval/            legacy.py + legacy_profile.py — the pre-v2 logic, kept only for comparisons
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
  output/{user}_{mistakes,peer_mistakes,opportunities,exposure,ingest_stats,clusters,profile,
         settings,srs,alerts,sync,style,counterfactual,dna_card.png,coach_profile,coach_memory,...}
  annotation_cache.db                   per-game Stockfish lines (Stage-1 cache, auto-created)
  bench/, gold/                         frozen benchmark games / hand-labelled gold set (eval only)
models/  stage1_transformer_v2.pt + stage1_reference_v2.pkl (live), stage1_transformer.pt (v1 fallback)
reports/stage12_eval/   Stage-1/2 evaluation (scripts/eval_stage12.py) — summary.md

frontend/src/
  pages/           Dashboard, Coach, PuzzleSession, OpeningExplorer, Endgames, BotGame,
                   AnalysisBoard, MistakeReplay, DNAPage, GameHistory, Settings, …
  features/otb-scan/   OTB Scan (lazy-loaded; TFJS vision). OTBScanPage + screens/
                   (Home, Setup, Calibration, LiveGame, VideoUpload, ScoresheetUpload,
                   MoveReview, GameFinished), cv/ game/ hooks/ — public/models/ holds the
                   two ~8MB TFJS models. Hands off to AnalysisBoard via {moves}.
  public/models/   480M_pieces_float16 + 480L_xcorners_float16 (board/piece detectors)
  nav.ts           THE navigation tree (sections → sub-blocks, blurbs, icons, routes); hub + breadcrumbs render from it
  pages/Hub.tsx    /home (big section blocks) and /home/:section (sub-blocks) — the post-login landing
  theme.ts         literal colour constants (neon, graphite board) for chessboard props / SVG / canvas
  components/layout/   AppShell (top bar: wordmark → /home, breadcrumbs, alerts bell, settings), SectionHeader, ChessBackground
  components/review/   ReviewGraph, RecentGames (Game Review)
  components/coach/    CoachWorkspaceBoard (board the agent sees + play mode), AnswerText (clickable
                   moves), LevelQuestionnaire, CoachBoard (inline puzzle / view board)
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

- **Stage 1 (v2)** — fetch **rated standard rapid** games (Lichess/Chess.com,
  username only) → two-pass Stockfish (depth 12, depth 18 on flagged moves and
  possible tactics) on a process pool, **PVs kept and cached per game** →
  mistakes = **≥10% win-probability loss** (Lichess curve; not cp) for BOTH sides
  (opponents = rating-matched peer baseline) → each tagged **allowed / missed /
  both / quiet** → classified in the **right framing**: an allowed mistake is
  (position after the move, opponent's refutation) = exactly the Lichess puzzle
  format the model was trained on; a missed one is (position before, best move)
  → **v2 multi-label transformer + lichess-puzzler verifier** → soft
  `family_probs` + a structured multi-type `description` (primary family,
  every attached family incl. king safety when the punishing line checks the
  king, motifs, tags); 5–10% losses are kept but counted as positional; cascades (one oversight over several moves) collapse to one
  incident; Maia2 at real ratings gives a `personal_weight` (no hard filter).
  Tactical opportunities are recorded found/missed for hit rates.
- **Stage 2 (v2)** — 5 fixed skill families (loose_pieces, alignment,
  defender_disruption, king_safety, positional) + `unclassified`. Per family:
  incidents per 100 moves (recency by game, half-life 50) vs the **peer rate**
  from the same games, Gamma–Poisson shrinkage, P(worse than peers) →
  **status** (confirmed / emerging / typical / strength / insufficient_data;
  also raised when you find available tactics of that family less often than
  peers — Beta test on opportunities, `status_reasons` says which),
  impact & excess in points per 10 games, `score = 0.75·excess + 0.25·impact`,
  allowed/missed split, hit rate, context. Metrics ride on
  `BlindspotCluster.profile`. `run_clustering` writes `_clusters.json` +
  `_profile.json` and **re-persists `_mistakes.json` with the family
  `cluster_id`** (= top of `family_probs` = `family_of(threat_type)`). No
  UMAP/HDBSCAN/LLM.
- **Stage 3** — local puzzle index tagged with Lichess themes; `allocate_puzzles`
  splits the budget across families by score, `query_by_themes` pulls matching
  puzzles in the user's rating band; SM-2 SRS, mastery resets on live blunders.
- Classifier: v2 = 17 multi-label motifs mapped to the 14 threat types (v1:
  16-way softmax, 83.1% on its own puzzle split; v0 LightGBM 63.5%). Measured
  Stage-1/2 results (legacy vs v2, incl. real-game end-to-end accuracy) are in
  `reports/stage12_eval/summary.md`; regenerate with `python scripts/eval_stage12.py --all`.
  Stage-1/2 detail in `instructions/stage1.md`; full backend architecture in **instructions/AGENT.md**.

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

**Forked Coach v3 (current, Oct 2026)** — v2 below plus: paid **DeepSeek `deepseek-flash`**
first (free chain = fallback; spend ledger + `COACH_SPEND_LIMIT_USD`), a **request router**
(`agent/intent.py`: position / create / general — general never sees the board), the 7-question
profile, create tools (puzzles, tablebase-verified named positions, material editor → equal
position via `positions.py`, play always vs **Maia**), Wikipedia grounding, arrows, and **board
tabs** shared by Coach and Share Screen. Details: top section of `backend/coach/README.md`.

**Forked Coach (agent v2)** — `backend/coach/agent/` (full map in
`backend/coach/README.md`). The Coach page and Game Review's move
explainer use `mode: "agent"`: a board-aware investigate → verify → explain loop
over 13 grounded tools (Stockfish MultiPV, move-vs-best counterfactuals, null-move
threats, exact board features, what-if lines, Lichess explorer + Masters game
verification, Syzygy, game review, puzzles, play mode). The client sends the
board FEN/moves/PGN, a static questionnaire level, and each prior answer's
analysis `notes` so follow-ups stay grounded. A verifier repairs illegal moves,
wrong piece placements and false file/pin claims before streaming. LLMs come from
a failover chain (`agent/llm.py`: DeepSeek if keyed, then Gemini/Cerebras, then Groq
`gpt-oss-120b → qwen3.8-27b → gpt-oss-20b`); the app must still work with only the
free keys, and keep the engine-only fallback. Free Groq ≈ 8K tokens/min + 200K tokens/day per model,
so keep tool outputs compact and only send relevant tool schemas.

**Forked Coach (v1 pipeline, still used by Share Screen voice + `/investigate`)** —
streamed over SSE with a bounded
tool-call loop (`meta` → `tool`/`tool_result` → `token` → `done`). Three layers:
questionnaire (`_coach_profile.json`), rolling memory (`_coach_memory.json`),
and a live context block built every session (theory mode omits it). `explain.py`
prefers C1 (vLLM endpoint via `C1_ENDPOINT`) and **always** falls back to
Stockfish — never block the feature on C1. Guard against Llama's `tool_use_failed`
(salvage `failed_generation`, else retry without tools) stays in `router._create`.
Dashboard `/api/profile` carries per-cluster `enrichment` (severity, time-pressure,
phases, recency) and `/api/analytics` carries severity/time-pressure/Maia
summaries — both derived from `_mistakes.json`, robust to missing fields.

**OTB Scan** — `frontend/src/features/otb-scan/` (lazy route `/otb-scan`, keeps
TFJS out of the main bundle) + `backend/scoresheet*.py`. Three inputs: live
camera (TFJS board/piece detection, calibrate → track), **uploaded video** (same
CV pipeline, sourced from a file via `CameraFeed`'s `srcUrl`: calibrate on the
first frame then auto-play through), and **scoresheet photo** (OCR). Scoresheet
OCR engine priority: **VLM** (Qwen2.5-VL via Ollama / OpenRouter, `VLM_OCR_BASE`)
→ Google Vision → Tesseract. **Multi-column scoresheets**: small VLMs read the
left table but skip the right — so `run_vlm_ocr` does a **two-pass** read (full
image, then a right-half crop with an enumeration prompt) and merges
higher-numbered moves. **SAN normalisation** (`clean_move` backend +
`normalizeSan` in `MoveReview`) repairs OCR formatting (`Qx C7`/`QxC7`→`Qxc7`,
spaces, file/piece case) so valid moves aren't flagged for manual fixing; a
legality-constrained corrector then snaps remaining tokens to legal moves. All
three flows hand off to the Analysis Board as a full playable game (nav state
`{moves}` → loaded into its move list). WS URLs are env-aware (`api/ws.ts`):
`ws://localhost:8000` in dev, same-origin `wss://` in prod.

**Shared frontend** — **tree navigation, no sidebar**: after import the user lands
on the hub (`/home`) of big blocks — Dashboard, Theory (Openings, Endgames),
Practice (Drills, Play vs Maia), AI Coach (Chat, Screen Share), Analyze (Game
Review, Analysis Board, Game History), OTB Scan; Settings is a small button.
Add or move a feature in `src/nav.ts` only — the hub, section pages and the top
bar's breadcrumbs all render from it. **Theme = black / white / one neon**
(`#C8FF2A`): use Tailwind tokens (`bg-bg-*`, `text-text-*`, `accent`,
`text-accent-ink` for text ON neon — never white on neon) and `src/theme.ts` for
literal colours (graphite chessboards `BOARD_DARK`/`BOARD_LIGHT`); no purple,
no hard-coded hex in components. Headings use the `font-display` (Sora) face.
Every page uses `SectionHeader` (icon + title + description; the wordmark lives
only in the top bar).
`useGameReview` powers clickable / arrow-key move history. `MiniBoardThumbnail`
is a pure-CSS board for dense tree rows (don't use `react-chessboard` for many
small boards).

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
- **Coach evaluation**: `python scripts/eval_coach_agent.py` (paced for free-tier
  limits, resumable) → `reports/coach_eval/`. Unit tests: `tests/test_coach_agent.py`.
- **`.env`** optional free keys `GEMINI_API_KEY` / `CEREBRAS_API_KEY` boost the Coach
  (used first; enable the critic pass). `COACH_LLM_CHAIN`, `COACH_CRITIC` override.
- **`.env`** needs `GROQ_API_KEY` (coaches, Forked Coach, insights) and
  `LICHESS_TOKEN` (Opening Explorer returns 401 without it on many networks).
  Optional `C1_ENDPOINT` (+ `C1_API_KEY`, `C1_MODEL`) points `explain_position`
  at a vLLM C1 server; omit it and Stockfish is used.
- **Stage-1 engine work is cached** per game in `data/annotation_cache.db` (key
  includes depths, so changing them invalidates rows). Re-label saved events with
  `python -m ml.clustering.reclassify <user>` instead of re-ingesting. Engine pool
  size: `FORKED_SF_WORKERS`; time classes: `FORKED_TIME_CLASSES` (default `rapid`).
  Live sync and the bot-game debrief use the same v2 Stage-1 path — keep it that
  way (matching compares families, so labels must come from one classifier).
- **Stage-1/2 checks**: `.venv/Scripts/python -m pytest tests/test_stage12.py -q -p no:cacheprovider`;
  before/after evaluation `python scripts/eval_stage12.py --all` (benchmark games
  frozen in `data/bench/` via `scripts/run_stage12_bench.py`).
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
