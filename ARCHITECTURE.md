# Forked architecture

This is the map of how Forked is built: what runs where, what each module
owns, what it reads and writes, and the rules that keep the pieces consistent.
Read it before changing anything that crosses a module boundary. Deeper notes
live next to the code: `instructions/stage1.md` (blindspot pipeline),
`backend/GAME_REVIEW.md` (review method), `backend/coach/README.md` (coach
agent), `instructions/AGENT.md` (older backend reference).

## 1. The shape of the system

```
 Browser (React SPA, Vite)                        Python process (FastAPI, one app)
 ───────────────────────                          ─────────────────────────────────
 pages / features  ── fetch JSON ──────────────▶  routers (backend/*.py)
                   ── SSE (review, coach, ingest) ◀─ worker threads
                   ── WebSocket /ws/bot-game ────▶  bot game loop
                                                     │
                                  ┌──────────────────┼──────────────────────────┐
                                  ▼                  ▼                          ▼
                           Stockfish processes   PyTorch models            External APIs
                           (singleton + pools)   (Stage-1 transformer,     (Chess.com / Lichess public,
                                                  Maia-2, optional Maia-3)  Lichess explorer + tablebase,
                                                                            LLM providers)
                                  │
                                  ▼
                           data/  (JSON files + SQLite caches; no database server)
```

- **One FastAPI app** (`backend/main.py`) mounts every router. In production it
  also serves `frontend/dist` (single origin). In development Vite proxies
  `/api` and `/ws` to the API (`VITE_API_TARGET`, default `localhost:8000`).
- **No database, no queue.** Durable state is JSON under `data/` written
  atomically (`backend/storage.py`), plus SQLite files for caches. Background
  work runs on daemon threads; progress streams over SSE.
- **Engines are local.** Stockfish for every judgement of move quality; Maia
  only to play or predict human moves (never to decide what is "best").
- **LLMs are optional.** Every LLM feature has an engine-only or curated
  fallback; the app works with only free keys, or none.

## 2. Repository layout

```
backend/            FastAPI routers and services (section 4)
ml/                 the blindspot pipeline: ingestion, classifier, families, puzzles, SRS
frontend/           React + TypeScript SPA (section 6)
data/               runtime state and caches (section 5); mostly git-ignored
models/             Stage-1 transformer checkpoints (not in git)
scripts/            one-off builders, benchmarks and evaluations
tests/              pytest suites (section 8)
reports/            frozen evaluation results referenced by the docs
instructions/       design notes and older build prompts
```

## 3. Accounts, identity and ownership

**Module:** `backend/auth.py` (`/api/auth`). **Storage:** `data/users/users.json`,
`data/users/sessions.json`.

- Registration takes name, user ID, email, optional phone, password, and a
  Chess.com or Lichess username. The chess account is checked against the
  platform's public API; a 404 rejects, an unreachable API is allowed and
  stored as `chess_verified: false`.
- Passwords: scrypt (n=2^14, r=8, p=1) with a per-user salt. Sessions: random
  bearer tokens; only their SHA-256 is stored; 30-day expiry. Failed logins are
  throttled per identifier (8 per 15 minutes).
- **Developer sign-in** (`POST /dev-login`) opens the maintainer account
  `ShahuPatil27` (Chess.com) with a random password nobody knows. Disable with
  `FORKED_DEV_LOGIN=0`.
- **Developer auth skip** (`frontend/src/lib/devAuth.ts`, `components/auth/DevSignIn.tsx`):
  in `npm run dev`, `RequireAuth` calls dev-login instead of redirecting to
  `/auth`. An explicit sign-out pauses it for the tab (sessionStorage); `/dev`
  resumes it. `VITE_DEV_AUTH_SKIP=0|1` overrides the default (on in dev, off in
  builds). The backend flag still decides: if dev-login is refused, the normal
  sign-in page is shown.
- **Two identities.** The *account* (user ID) owns the login; the *chess
  username* keys every pipeline and library file. All per-player endpoints take
  the chess username in the path.
- **Ownership check.** `assert_owner(request, username)`: a signed-in request may
  only touch its own chess username (or user ID). Anonymous requests are still
  allowed so local scripts and older tools keep working; tightening that is in
  `PLANS.md`.
- Frontend: `src/api/auth.ts` installs a `fetch` wrapper that adds
  `Authorization: Bearer …` to same-origin `/api` calls and signs out when
  `/api/auth/me` answers 401 (expired or revoked session).
  `src/store/userStore.ts` (Zustand, persisted to localStorage) holds the token,
  the account, the chess username, platform and rating. `App.tsx` guards app
  routes with `RequireAuth` and revalidates the session on load.

## 4. Backend modules

### 4.1 Shared infrastructure

| Module | Responsibility |
|---|---|
| `backend/storage.py` | `read_json`, `write_json` (temp file + `os.replace`, retried on Windows sharing errors), `locked_update(path, default, fn)` (read-modify-write under a per-path `RLock`), `safe_name`. Use it for every JSON file that more than one request can write. |
| `backend/main.py` | App setup, router mounting, the **Stockfish singleton** (`_ensure_engine`, `_sf_lock`; always hold the lock around `engine.analyse`), ingestion jobs, profile/analytics/cluster endpoints, drill sessions, settings, bot games and their WebSocket, `/api/analyse`, static serving. Forces `WindowsProactorEventLoopPolicy` (top of file and in worker threads) so Stockfish can be spawned on Windows. |
| `ml/config.py` | Paths (`DATA_DIR`, `STOCKFISH_PATH`), thresholds, time classes, request headers. |

### 4.2 The blindspot pipeline (`ml/`)

**Stage 1, ingest and classify** (`ml/pipeline.py`, `ml/ingestion/`):
fetch rated standard games (rapid by default, `FORKED_TIME_CLASSES`) →
two-pass Stockfish on a process pool (depth 12, depth 18 on flagged moves; PVs
cached per game in `data/annotation_cache.db`) → mistakes by win-probability loss
(Lichess curve: inaccuracy ≥5%, mistake ≥10%) for both sides → each tagged
`allowed` / `missed` / `both` / `quiet` (`mechanism.py`) → classified in the
matching frame by the v2 multi-label transformer plus the lichess-puzzler
verifier (`classify_events.py`) → cascades collapsed → Maia-2 personal weight.
Writes `{user}_mistakes.json`, `_peer_mistakes.json`, `_opportunities.json`,
`_exposure.json`, `_ingest_stats.json`, `game_meta.json`.

**Stage 2, families and peer comparison** (`ml/clustering/`): five fixed
families (`loose_pieces`, `alignment`, `defender_disruption`, `king_safety`,
`positional`) plus `unclassified`. Per family: incidents per 100 moves vs the
opponents' rate in the same games, Gamma–Poisson shrinkage, P(worse than
peers) → status (confirmed / emerging / typical / strength /
insufficient_data), impact and excess in game points per 10 games,
`score = 0.75·excess + 0.25·impact`, allowed/missed split, tactic hit rate,
context. Writes `_clusters.json`, `_profile.json`, and re-persists
`_mistakes.json` with each event's family `cluster_id`.

**Stage 3, puzzles and spacing** (`ml/puzzles/`, `ml/srs/`): a local
theme-tagged Lichess puzzle index; `allocate_puzzles` splits a session's budget
by family score; `query_by_themes` pulls unseen puzzles within ±200 of the
player's rating; SM-2 scheduling per family; mastery resets when live sync sees
the pattern again.

**The identity rule.** Everything downstream (alerts, debrief, replay,
counterfactual, drills, coach) identifies a pattern by the family `cluster_id`
string, which is `family_of(threat_type)`. Never match on a display label.
`ml/matching.py` maps fresh events to families; positional, unclassified and
inaccuracies never count as a "known tactical blindspot".

### 4.3 Player data services

| Router | Endpoints | Reads / writes | Notes |
|---|---|---|---|
| `ratings.py` `/api/ratings` | `GET /{user}`, `GET /scale/convert` | `{user}_ratings.json` (1 h cache), settings `elo` | Live ratings from Chess.com/Lichess. Rapid becomes the profile rating unless the player set it manually (`elo_manual`). `RAPID_SCALE` maps Chess.com rapid ↔ Lichess rapid (ChessGoals survey); the frontend copy in `src/lib/ratings.ts` must match (tested). |
| `insights.py` `/api/insights` | `GET /{user}` | annotation cache, `_exposure`, `_mistakes`, `_peer_mistakes`, `_profile` → `_insights.json` | Dashboard analytics: overview, mistake probability vs % of game, eval arc, conversion, situations, radar (peers = 50), clock, pieces, trend, colours, severity, findings. Accuracy uses Game Review's calibrated formula. Cache invalidated by file mtimes. |
| `counterfactual.py` `/api/profile` | `GET /{user}/counterfactual` | `_mistakes`, `_exposure`, `_ratings` → `_counterfactual.json` | Turning-point model: in each non-won game, the biggest mistake made from a reasonable position is re-scored at its pre-mistake expected score; the performance-rating difference, capped at +400, is the gain. Split per family as a ladder that sums to the total. Base = live rapid rating. |
| `history.py` `/api/history` | `GET /{user}?platform&time_class` | platform APIs → `{user}_recent_games.json` (15 min) | Recent platform games merged with Stage-1 moments and library reviews (`analysed`, `reviewed`, mistakes, blunders per game). |
| `library.py` `/api/library` | games CRUD, `POST /{user}/reviews`, `GET /reviews/{id}` and `/stream`, `POST /lookup`, scan image | `data/library/{user}/games.json`, `reviews/{id}.json`, `scans/{id}.jpg` | Every game that reaches Forked (Maia, practice, review, OTB scan, analysis). Game id = SHA-1 of normalised start position + UCI moves, so the same game from any route is one record. Reviews run on one worker thread with replayable SSE event logs; a stored review is reused unless a higher quality is requested. |
| `drills.py` `/api/drills` | `POST /attempt`, `GET /stats/{user}` | `{user}_drill_stats.json` | Solved, accuracy, streaks, day streaks (the browser sends its local date), last 14 days, and per family how many real-game mistakes have been drilled. |
| `coach_chats.py` `/api/coach-chats` | list / get / put / patch / delete | `data/library/{user}/chats/` | Saved coach conversations, each with its board snapshot. |
| `live_sync.py` | `/api/alerts/*`, `/api/sync/*` (on `main`) | `_alerts.json`, `_sync.json`, appends to `_mistakes.json` | Scheduler thread polls every 15 minutes per user, runs Stage 1 on new games, raises an alert when a mistake lands in a confirmed/emerging family (or, if none, the two costliest tactical families). |
| `replay.py` `/api/cluster` | mistakes, insight, note, explain | `_mistakes.json` | Mistake Replay: every real position in a family, with LLM one-liners (optional). |

### 4.4 Training surfaces

| Module | What it does | Key rules |
|---|---|---|
| `game_review.py` `/api/game-review` | `POST /analyse` (SSE), `GET /recent`, `POST /check-move`. Chess.com-style labels on a human expected-points curve, accuracy and game rating calibrated to Chess.com data (`review_calibration.json`). | Once a move leaves book, no later move is book. Dedicated Stockfish process. |
| `openings.py` `/api/openings` | `GET /explore` (Lichess explorer proxy with `db=lichess|masters`, rating buckets and speeds; 24 h SQLite cache), `GET /eval`, `POST /evals` (≤12 FENs, depth 16, cached forever), `POST /ideas`. | Rating buckets are the average rating of both players on Lichess. The frontend's typical ideas are hand-written (`src/data/openingIdeas.ts`) with sources, not generated. |
| `endgames.py` `/api/endgames` | Practice positions by config (Lichess endgame puzzles first, Stockfish-filtered generation second), Syzygy proxy, endgame coach. | Results are judged against the tablebase. `scripts/verify_endgame_tree.py` checks every theory leaf (39/39). |
| `bot/engines.py` + bot routes in `main.py` | `choose_move(board, engine, target_elo, opp_elo)`: Maia-2 sampled with rating-dependent temperature below 2000; "Maia+" from 2000 (Maia candidates vetted by Stockfish, tolerance shrinking with rating); full-strength Stockfish; Maia-3 when `maia3-uci` is available. | Ratings arrive on the player's platform scale and are converted to Lichess before reaching Maia. First move from the standard start is a central pawn (Maia-2 is out of distribution otherwise). Who moves first = side to move vs the player's colour. Finished games are saved to the library with their source (maia / opening / endgame). |
| `puzzle_themes.py` `/api/themes` | Catalogue, next, run (Rush/Streak), attempt (Glicko-2 per theme), explain, check-move. Own-game angles: `game`, `game-blunders`, `game-missed`. | `data/puzzles/themes.db` built by `scripts/build_theme_index.py`; live Lichess API fallback. Own-game puzzles are unrated and accept any move within ~5% expected score of best (Stockfish). |
| `warmup/` `/api/warmup` | Pre-game routine: composer, drill generators, events, outcomes, experiment. | Independent of the classifier and clustering (a test greps for imports). Best moves always from Stockfish. All caps, budgets and the timer schedule live in `data/warmup_config.json`. Threat drills count only real threats (attacked by a cheaper piece or insufficiently defended). |
| `scoresheet*.py` `/api/ocr` | OTB Scan: vision read (full page + four row bands, voted) → beam-search decoder over legal games (Maia-2 prior for ties) → proofreading round → `/redecode` with user pins. | Spend ledger `data/ocr_spend.json`, limit `OCR_SPEND_LIMIT_USD`. Ask before paid evaluation sweeps. |
| `coach/` `/api/coach` | Agent loop with request routing (position / create / general), grounded tools (Stockfish MultiPV, counterfactuals, board features, explorer, tablebase, puzzles, play vs Maia), a verifier that repairs illegal or false claims, and an LLM failover chain. | Never write "cp" to the player. Engine-only fallback must keep working. See `backend/coach/README.md`. |

## 5. Data layout (`data/`)

| Path | Kind | Owner |
|---|---|---|
| `users/users.json`, `users/sessions.json` | accounts, hashed sessions | auth |
| `library/{user}/games.json`, `reviews/`, `scans/`, `chats/` | the player's saved games, reviews, scoresheet photos, coach chats | library, coach_chats |
| `output/{user}_mistakes.json` … `_profile.json` | pipeline state (section 4.2) | ml |
| `output/{user}_settings.json` | platform, rating, `elo_manual` | main |
| `output/{user}_ratings.json`, `_insights.json`, `_counterfactual.json`, `_recent_games.json` | caches | ratings, insights, counterfactual, history |
| `output/{user}_drill_stats.json`, `_srs.json`, `_puzzle_themes.json` | training progress | drills, srs, puzzle_themes |
| `output/{user}_alerts.json`, `_sync.json` | live sync | live_sync |
| `annotation_cache.db` | per-game Stockfish lines (key includes depths) | Stage 1 |
| `opening_cache.db`, `endgame.db` | explorer, eval, ideas, tablebase caches | openings, endgames |
| `puzzles/`, `puzzles/themes.db`, `puzzles/warmup_bank.db` | puzzle indexes | Stage 3, themes, warm-up |
| `warmup.db`, `warmup_config.json` | warm-up events / config | warmup |
| `bot_games/` | in-flight bot game state and debriefs | main |

`users/`, `library/`, `bot_games/` and the per-user outputs are git-ignored.

## 6. Frontend

**Stack:** React 18 + TypeScript, Vite, TanStack Query, Zustand, Tailwind,
Framer Motion, `chess.js`, `react-chessboard`.

### 6.1 Structure

```
src/
  App.tsx            routes, RequireAuth, session check
  nav.ts             THE navigation tree (hub blocks → sub-blocks, breadcrumbs)
  theme.ts           literal colours (neon, graphite board, chart palette)
  api/               one typed client per backend router (auth, library, insights, drills, themes, …)
  store/             userStore (account, token, chess identity, rating), openingsStore (tree position, session)
  lib/               format.ts (points, dates), moveTree.ts (branching move trees, PGN/FEN), ratings.ts, review.ts
  hooks/             useElementWidth (responsive boards), useGameReview, useAudioCoach
  pages/             one page per route (Dashboard, GameReview, AnalysisBoard, BotGame, …)
  features/          self-contained sections: otb-scan/, warmup/, share-screen/
  components/        layout/, dashboard/, review/, analysis/, openings/, endgames/, coach/, puzzles/, auth/
  data/              endgameTree.ts (theory, tablebase-checked), openingIdeas.ts (curated ideas + sources)
```

### 6.2 Conventions

- **Navigation** is defined only in `nav.ts`; the hub, section pages and
  breadcrumbs render from it.
- **Theme:** black / white / one neon (`#C8FF2A`). Use Tailwind tokens
  (`bg-bg-*`, `text-text-*`, `accent`, `text-accent-ink` on neon) and
  `theme.ts` for literal colours. Charts use `CHART` (you, peer, win, loss): no
  dual axes, a table view toggle on every chart.
- **Evaluations in points.** Use `lib/format.ts` (`pts`, `lossPts`, `evalText`,
  `whiteShare`); never print centipawns.
- **Responsive boards.** Size boards from `useElementWidth` on a wrapper in a
  `min-w-0` track; never hard-code a board width wider than a phone.
- **Every page** starts with `SectionHeader`. Pages must work at 390 px width.
- **Server state** goes through TanStack Query keys named after the endpoint
  (`['drill-stats', user]`); mutate, then invalidate.
- **Streaming:** SSE responses are parsed with a manual `ReadableStream`
  reader (EventSource cannot POST). Library review streams are replayable, so a
  page can reconnect after navigation or a StrictMode remount.

### 6.3 How sections hand off

| From | To | Payload |
|---|---|---|
| Analysis Board, OTB Scan, Play vs Maia, Game History | Game Review | library review id → `/game-review/{id}` (stored review or live stream) |
| Game Review, Mistake Replay, Blindspot detail | Analysis Board | router state `{fen}`, `{moves}`, `{pgn}` or `{positions, index}` |
| Openings tree | Play vs Maia / Analysis Board | `starting_moves` from the tree path; tree state kept in `openingsStore` |
| Dashboard, Blindspot detail | Drills | router state `{clusterId}` |
| Any page | Coach | `?chat=` deep link restores a saved conversation and its board |

## 7. Request flows worth knowing

**Sign-up → first dashboard.** `AuthPanel` registers or signs in, stores the
token, fetches live ratings (`/api/ratings`), checks for a profile
(`/api/check`), and starts ingestion (`/api/ingest`) if there is none; the
loading page follows the job's SSE progress. Stage 1 → Stage 2 → the hub.

**Reviewing a game from anywhere.** The page posts the PGN to
`/api/library/{user}/reviews`. The library upserts the game (stable id),
returns at once with a review id, and queues the job. The page navigates to
`/game-review/{id}`, which either loads the stored review or follows
`/reviews/{id}/stream`; events are kept server-side so the stream can be
replayed. When done, `key_moments` (mistakes/blunders for the player's side)
are stored on the game record for Game History.

**A Maia game.** `POST /api/bot-game/create` (rating on the player's scale,
engine, starting FEN or moves, analysed mode) → WebSocket loop: the server
validates the player's move, asks `bot/engines.choose_move`, optionally
annotates both moves (`/api/bot-game/annotate`), detects game end (mate,
stalemate, insufficient material, threefold, fifty-move) → saves the game to
the library → "Game review" opens it via the library flow.

**Live sync alert.** Scheduler tick → new games fetched → Stage 1 on them →
`match_events` → alert if the family is one the player is flagged for →
dashboard banner via `/api/alerts`.

## 8. Testing and verification

| Command | Covers |
|---|---|
| `python -m pytest tests -q -p no:cacheprovider --ignore=tests/test_coach_live.py` | Stage 1/2, Game Review, coach tools and verifier, Puzzle Themes, Warm-Up generators (independently re-verified), scoresheet decoder, accounts/ratings/library/drills/matching (`test_platform.py`) |
| `cd frontend && npx tsc --noEmit && npx vite build` | types and production build (must be clean) |
| `python scripts/verify_endgame_tree.py` | every endgame theory leaf vs Syzygy |
| `python scripts/eval_stage12.py --all` | Stage 1/2 accuracy on frozen benchmarks |
| `python scripts/eval_coach_agent.py` | coach answer quality (paced for free tiers) |

Paid-model evaluations (OTB Scan, DeepSeek coach) cost money: ask before
running sweeps.

## 9. Rules that must not break

1. Stockfish decides move quality everywhere; Maia only plays or predicts humans.
2. Families are matched by `cluster_id`, never by label.
3. Warm-Up never imports the classifier, clustering or Maia.
4. No new database, queue or heavy dependency without agreement; JSON + SQLite + numpy.
5. Every JSON file with concurrent writers goes through `backend/storage.py`.
6. Ratings shown to the player are on their platform's scale; Maia gets Lichess-scale numbers.
7. Every LLM path has a non-LLM fallback; nothing blocks on a paid key.
8. Curated content (opening ideas, endgame tree, corpora) is hand-maintained and checked (legal FENs, tablebase results, sources).
