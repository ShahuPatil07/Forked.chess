# Forked — Claude Code context

## What this is (current reality)

Forked is a full adaptive chess training platform. It began as a personalised
blindspot trainer and now has nine surfaces plus an intelligence layer, all
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
5. **Play vs Maia** — 600–2800 on the player's own platform scale (`bot/engines.py`:
   Maia-2 sampled below 2000, "Maia+" = Maia candidates vetted by Stockfish from 2000,
   full-strength Stockfish, Maia-3 if `maia3-uci` is installed), an "analysed" mode that
   labels every move live with an always-on eval bar, a post-game debrief, and one-click
   Game Review (the game is saved to the library).
6. **Analysis Board** — PGN/FEN input, branching move tree (`lib/moveTree.ts`), live
   Stockfish MultiPV, a background "Review this game" that keeps running while you
   analyse, and a board editor (Construct mode). Accepts `{moves}` / `{pgn}` /
   `{fen}` / `{positions}` router state.
7. **OTB Scan** — photograph the **scoresheet** of an over-the-board game: a vision
   model reads every cell, a beam-search decoder rebuilds the legal game (fixing misreads
   and the player's own notation slips), every move is proofread, and the user reviews
   flagged moves before handing off to **Game Review** or the **Analysis Board**. Live camera
   and video upload are shown as "beta / coming soon" (code kept, not mounted).
   Lives in `frontend/src/features/otb-scan/` + `backend/scoresheet*.py`.
8. **Puzzle Themes** (Practice → Puzzle Themes, `/puzzles`) — Lichess's
   training/themes catalog (same 10 categories + openings) over a balanced
   313K-puzzle sample of the full 5.9M DB, plus Forked-only sub-themes (knight /
   pawn / queen / royal forks, queen & exchange sacs, opposition, breakthroughs,
   material endgames), a Glicko-2 rating per theme seeded from the real rating,
   puzzles built from the user's own missed tactics, a spaced review queue,
   theme-filtered Rush / Streak, multi-theme custom sets, a 3-step hint ladder
   and a board-proven "why it works". Live Lichess API is the fallback.
9. **Warm-Up** (Practice → Warm-Up, `/warmup`) — a 3/5/10-minute pre-game routine:
   setup check → (breathing reset after a loss / tilt) → fast perception drills on real
   board geometry → thinking drills → easy tactic sprint → "Play now". Time caps scale
   with time control and rating band; drills adapt to stay ~80–90% right. Deliberately
   **independent of the blindspot profile and the threat classifier** (board truth only:
   SEE, attack maps, null-move threats, Stockfish). Logs every item, links the next game
   (≤30 min) to a Stockfish review, and runs an opt-in randomized warm-up vs control
   comparison with an internal dashboard at `/warmup/lab`.

**Intelligence layer** (all keyed on the family `cluster_id`, never the LLM label):
- **Live sync + alerts** — background poll for new games, re-run Stage 1, and
  alert when a real mistake (not an inaccuracy, not positional) lands in a
  confirmed/emerging family, or one of the two costliest tactical families if
  none is flagged (`live_sync._alert_families`).
- **Post-game debrief** — cross-references Maia-game mistakes against the user's
  clusters ("you triggered 1 known weakness").
- **Mistake Replay** — walk every real-game position in a cluster, with eval
  bar, free exploration, per-position "Notice", and a Groq pattern insight.
- **Counterfactual rating** — turning-point model (`counterfactual.py`, MODEL
  `turning-point-v2`): the biggest mistake of each non-won game re-scored at its
  pre-mistake expected score → performance-rating gain on the live rapid rating,
  capped at +400, split per family as a ladder that sums to the total.

**Platform layer (Oct 2026)** — accounts (`auth.py`: scrypt, hashed bearer sessions,
developer shortcut to `ShahuPatil27`, `FORKED_DEV_LOGIN=0` disables it), live ratings
(`ratings.py`, Chess.com↔Lichess rapid table from ChessGoals, mirrored in
`frontend/src/lib/ratings.ts`), the game library (`library.py`: every game + stored
reviews + scans, background review jobs with replayable SSE), platform history
(`history.py`), dashboard analytics (`insights.py`), saved coach chats
(`coach_chats.py`) and drill stats (`drills.py`). All JSON writes go through
`backend/storage.py`. The Chess DNA card was removed (Oct 2026). Full map:
**ARCHITECTURE.md**; roadmap: **PLANS.md**.

Product name: **Forked**. Tagline: *"A coach who knows exactly how you lose."*

> This file describes the product **as built**. An earlier version of this file
> contained a 6-week MVP plan with aspirational tech (pgvector, Celery/Redis,
> Leela embeddings). That plan was superseded — see "Actual stack" below.

---

## Actual stack (what's really used)

**Backend** — Python 3.10+, FastAPI (single app, **~18 routers** mounted on
`main`), `python-chess` + Stockfish, a **PyTorch chess transformer** (Stage-1
classifier), Maia2 (PyTorch CPU), Groq for LLM (coaches + the agentic Forked
Coach with tool-calling), Pillow (scoresheet images), **SQLite** for all caches.
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
backend/                 (all routers mounted on main's FastAPI app; ARCHITECTURE.md has the full map)
  main.py          ingestion, profile, analytics, drills, analysis, settings, bot-game (+WS), accuracy
                   (+ single-origin static serving of frontend/dist in prod)
  openings.py      /api/openings/explore | /eval | /ideas   (SQLite cache: opening_cache.db)
  opening_chat.py  /api/openings/chat(/stream) | /chat/suggestions   (curated corpus + Lichess stats)
  endgames.py      /api/endgames/practice-position(/by-config) | /syzygy | /coach/chat(/stream) | /coach/suggestions
  live_sync.py     background per-user sync; /api/alerts | /api/sync/{status,trigger}
  replay.py        /api/cluster/{u}/{cid}/mistakes | /insight | /note | /explain   (Mistake Replay)
  counterfactual.py  /api/profile/{u}/counterfactual   (bounded perf-rating estimate)
  storage.py       atomic JSON writes + per-path locks (read_json / write_json / locked_update)
  auth.py          /api/auth/{config,register,login,dev-login,me,change-password,logout}; assert_owner
  ratings.py       /api/ratings/{u} (live Chess.com/Lichess ratings) | /scale/convert (RAPID_SCALE)
  library.py       /api/library/{u}/games | /reviews(/{id}(/stream)) | /lookup  (data/library/{u}/)
  history.py       /api/history/{u}?platform&time_class   (platform games + Stage-1 + library merge)
  insights.py      /api/insights/{u}   (dashboard analytics, cached _insights.json)
  coach_chats.py   /api/coach-chats/{u}(/{id})   (saved coach conversations + board snapshots)
  drills.py        /api/drills/attempt | /stats/{u}   (_drill_stats.json)
  bot/engines.py   choose_move: Maia-2 / Maia+ / Stockfish / optional Maia-3
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
  puzzle_themes.py /api/themes/catalog | next | run | attempt | run-result | stats | explain | check-move | daily
                   (Puzzle Themes: themes.db + Lichess API fallback; per-user _puzzle_themes.json)
  warmup/          Warm-Up: /api/warmup/profile | moment | session | items | events | finish | routine | consent
                   | link | stats | lab.  config.py (reads data/warmup_config.json), chesskit.py (SEE, threats,
                   attack maps, legal mini-positions), drills/*.py (one generator per drill), positions.py,
                   games.py (recent games, band, tilt), signals.py (own-game facts), composer.py (session plan),
                   outcomes.py (next-game Stockfish review), store.py (SQLite data/warmup.db)
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
  puzzles/subthemes.py  Forked sub-theme detectors (fork piece/royal, sacs, opposition, breakthrough, material)
  puzzles/explain.py    deterministic "why it works" narration of a puzzle line (python-chess only)
  srs/             SM-2 scheduler + session builder (per-family puzzle allocation)

data/
  opening_cache.db, endgame.db          SQLite caches (auto-created)
  opening_knowledge.json                curated opening coach corpus (47 entries)
  endgame_knowledge.json                curated endgame coach corpus (25 entries)
  endgame_positions.json                curated practice positions (66)
  puzzles/                              Lichess puzzle index (index.npz + meta.json w/ themes) — Drills
  puzzles/themes.db                     Puzzle Themes index (SQLite, ~126MB, gitignored) — scripts/build_theme_index.py
  puzzle_themes.json                    curated theme catalog: categories, names, "how to spot it", hints, family focus
  warmup_config.json                    Warm-Up's ONE config: bands, time-control multipliers, drill caps/levels,
                                        session budgets, adaptivity, tilt, outcome window, experiment, copy
  warmup.db                             Warm-Up events / sessions / moments (arms) / outcomes (runtime, gitignored)
  puzzles/warmup_bank.db                Two Candidates bank (Stockfish-mined, gitignored) — scripts/build_warmup_bank.py
  output/{user}_{mistakes,peer_mistakes,opportunities,exposure,ingest_stats,clusters,profile,
         settings,ratings,insights,srs,drill_stats,alerts,sync,counterfactual,recent_games,
         coach_profile,coach_memory,puzzle_themes,...}
  users/                                accounts + hashed sessions (gitignored)
  library/{user}/                       games.json, reviews/, scans/, chats/ (gitignored)
  annotation_cache.db                   per-game Stockfish lines (Stage-1 cache, auto-created)
  bench/, gold/                         frozen benchmark games / hand-labelled gold set (eval only)
models/  stage1_transformer_v2.pt + stage1_reference_v2.pkl (live), stage1_transformer.pt (v1 fallback)
reports/stage12_eval/   Stage-1/2 evaluation (scripts/eval_stage12.py) — summary.md

frontend/src/
  pages/           Dashboard, Coach, PuzzleSession, PuzzleThemes (catalog), PuzzleTrainer (/puzzles/:angle),
                   OpeningExplorer, Endgames, BotGame,
                   AnalysisBoard, MistakeReplay, GameHistory, GameReview, AuthPage, Settings, …
  features/otb-scan/   OTB Scan (lazy-loaded; TFJS vision). OTBScanPage + screens/
                   (Home, Setup, Calibration, LiveGame, VideoUpload, ScoresheetUpload,
                   MoveReview, GameFinished), cv/ game/ hooks/ — public/models/ holds the
                   two ~8MB TFJS models. Hands off to AnalysisBoard via {moves}.
  features/warmup/     Warm-Up: WarmupPage (/warmup), SessionRunner, ReadyScreen, RoutineBuilder,
                   WarmupLab (/warmup/lab, hidden), drills/ (one component per drill, shared DrillProps),
                   state/ (setup, breathing, worry dump, move nudge), components/DrillBoard, meta.ts, api.ts
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
  components/dashboard/ BlindspotAlerts (live-sync banner), RatingImpact (counterfactual ladder), charts
  components/analysis/ BoardEditor (Construct mode)   components/auth/ AuthPanel
  components/review/   KeyMoments (mistakes / blunders dropdowns)
  components/       BotGameDebrief
  lib/format.ts     evaluations in POINTS (pts / lossPts / evalText / whiteShare) — never print centipawns
  lib/moveTree.ts   branching move tree + PGN/FEN parsing     lib/ratings.ts  platform rating scale
  hooks/useElementWidth.ts  responsive board sizing (measure a min-w-0 wrapper)
  store/openingsStore.ts    opening tree position kept across navigation
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

**Puzzle Themes** — `backend/puzzle_themes.py`. Puzzles come from
`data/puzzles/themes.db`, built in one ~8-min pass over
`data/raw/lichess_db_puzzle.csv.zst` by `python scripts/build_theme_index.py`
(`--download` fetches a fresh DB): per (theme, 200-pt rating band) reservoirs
that prefer well-voted puzzles, every kept puzzle tagged with ALL its themes
(so "fork AND endgame" combos are exact), Forked sub-themes from
`ml/puzzles/subthemes.py` (fork detection = the lichess-puzzler port in
`classifier/verifier.py`). If the DB is missing or a band is empty, `/next`
falls back to the anonymous Lichess `/api/puzzle/batch/{angle}` (Forked
sub-themes ask for the parent and filter). Names, descriptions, "how to spot
it" cues and hint nudges live in the hand-maintained `data/puzzle_themes.json`
— extend it there; the catalog endpoint merges it with DB counts. Ratings are
Glicko-2 (global + per theme, seeded from the user's game Elo, hinted solve =
0.5, replays unrated). Special angles: `mix`, `weak` (blindspot families +
own-game motif counts + low theme ratings), `game` (own missed tactics from
`_mistakes.json`/`_opportunities.json`, PV trimmed by `_cut_line`, unrated,
alternatives accepted via Stockfish `/check-move`), `review` (spaced queue),
`custom` (`themes=a,b&match=all|any`), `daily`, or any opening tag.
The board (`components/puzzles/ThemePuzzleBoard.tsx`) accepts any checkmate,
handles promotion via the react-chessboard dialog, and emits mistake / solved /
revealed events; the page decides results. Tests: `tests/test_puzzle_themes.py`.

**Warm-Up** — `backend/warmup/` + `frontend/src/features/warmup/`. Rules that matter:
- **Independent by design**: nothing in `backend/warmup` may import the clustering / threat
  classifier / Maia (`tests/test_warmup.py` greps for it). Own-game data is used only as raw
  facts (`signals.py`: hung pieces, missed threats, mates, missed wins, time trouble — each
  re-checked on the board with python-chess from `_mistakes.json` positions/lines) and positions
  (`positions.py`), never as classifier labels.
- **Best moves are always Stockfish** (the user's rule: "Maia is useless" here). Two Candidates =
  positions where Stockfish depth 3 picks a "tempting" move ≥150cp worse than depth-14 MultiPV best.
- **Config is single-sourced** in `data/warmup_config.json`; don't hard-code caps or budgets.
- Warm-up puzzles **never** touch SM-2 or Puzzle Themes ratings/review (config flags are false;
  `EasySprint` uses the themes board but never calls the themes attempt API).
- **Experiment**: `/moment` assigns arm with `secrets.SystemRandom` only for opted-in users
  (everyone else always warms up); outcomes = next game(s) within 30 min after `play_at`,
  Stockfish quick review → blunders per 40 moves. Never show users effect claims below
  `min_games_per_arm`; honesty copy says no study has tested chess warm-ups.
- Tilt gate is **advisory only**; the worry-dump text stays in component memory (never sent).
- Flashes use requestAnimationFrame; reduced motion (OS or the page toggle, localStorage
  `forked-warmup-reduced-motion`) switches What Changed? to side-by-side; every drill has keys.
- Coach tools `get_warmup_plan` / `get_warmup_stats` (`coach/agent/tools.py`, `WARMUP_RE`).
- No paid API calls anywhere in Warm-Up. Tests: `tests/test_warmup.py` (1,000 items per generator,
  independently verified). If `warmup_bank.db` is missing, Two Candidates is skipped, not broken.

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
flat per-game Elo (that produced fantasy +1000 ratings).

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

**OTB Scan** — `frontend/src/features/otb-scan/` (lazy route `/otb-scan`) +
`backend/scoresheet*.py`. Only the **scoresheet** flow is live; camera/video screens and the
TFJS CV pipeline stay in the folder but aren't mounted. Pipeline (`scoresheet_pipeline.scan_image`,
used by both the API and the eval): (1) **read** — `scoresheet_reader.py`, DeepSeek-V4.1-Flash
vision (`deepseek-flash`, thinking off) does a full-page pass + four contrast-enhanced **row
bands**, concurrently, transcribing cells *literally* (never "fix" or fill from theory — the model
otherwise recites opening theory); independent passes **vote** per cell. (2) **decode** —
`scoresheet_decoder.py`, beam search over legal games aligning cells to moves (match / drop a
junk cell / infer an unwritten move), handwriting-confusion edit distance + amateur shorthand
("de", "NxN", "R6"), blank rows/cells inferred, **Maia2 prior** (`scoresheet_prior.py`) only to
break ties where the ink fits no legal move; every ply gets a status (exact / corrected /
uncertain / inferred / confirmed) + ranked legal alternatives. (3) **proofread** every decoded
move as a multiple choice against its band, re-decode, one more targeted round. Review screen
(`screens/MoveReview.tsx`): photo + board + colour-coded moves; a fix is sent as a **pin** to
`/api/ocr/scoresheet/redecode` and the rest of the game re-aligns; a "Game ready" panel slides in
with **Game Review** (`/game-review`, nav state `{pgn}`) and **Analysis Board** (`{moves}`).
Cost ~9 calls ≈ $0.004/sheet, own ledger `data/ocr_spend.json` (`OCR_SPEND_LIMIT_USD`);
`SCORESHEET_SAMPLES=2` adds a second voting sample. Fallback without any vision model: Google
Vision / Tesseract → grid parser → same decoder. **Accuracy is measured**, not guessed:
`scripts/build_scoresheet_bench.py` freezes 120 real HCS sheets (`data/bench/scoresheets/`),
`scripts/eval_scoresheets.py` (cached calls) → `reports/scoresheet_eval/summary.md`; decoder
tests `tests/test_scoresheet_decoder.py`. Money matters: don't run paid eval sweeps without asking.

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
  curated JSON. Prefer curated corpora over scraping. (Pillow is the only image dep,
  used by OTB Scan.)
- **Cluster identity**: never match/compare on the LLM label string — always the
  family `cluster_id` (`family_of(threat_type)`). Per-user state files under
  `data/output/`: `_alerts.json`, `_sync.json`, `_ratings.json`, `_insights.json`,
  `_counterfactual.json`, `_drill_stats.json`, `_recent_games.json`, `_coach_profile.json`,
  `_coach_memory.json`, `_puzzle_themes.json` (puzzle ratings, history, review queue). After Stage 2, `_mistakes.json` carries each event's
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
