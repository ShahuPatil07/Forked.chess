# Forked — Backend Architecture (AGENT.md)

A complete map of the backend for anyone (human or agent) who needs to extend or
debug it. Pairs with `../CLAUDE.md` (product overview) and `stage1.md` (classifier
detail, same folder). This file is the **how it's wired** reference.

---

## 1. Process model

One FastAPI app (`backend/main.py`) with **eight routers** mounted on it. Every
router is a flat `backend/*.py` module exposing an `APIRouter`, except the
capstone Coach which is a package (`backend/coach/`). There is no `routers/` or
`services/` directory — keep new routers flat (or as a package when large).

```
backend/main.py                 app = FastAPI(); include_router(...) ×8
  ├─ openings.py                /api/openings/{explore,eval,ideas}
  ├─ opening_chat.py            /api/openings/{chat,chat/stream,chat/suggestions}
  ├─ endgames.py                /api/endgames/{practice-position,syzygy,coach/...}
  ├─ replay.py                  /api/cluster/{u}/{cid}/{mistakes,insight} + /note + /explain
  ├─ counterfactual.py         /api/profile/{u}/counterfactual
  ├─ card.py                   /api/profile/{u}/{compute-style,style,dna-card,card}
  ├─ live_sync.py              /api/alerts/* + /api/sync/* + background scheduler
  └─ coach/  (package)          /api/coach/{chat,save-questionnaire,profile,update-memory}
main.py itself owns: ingestion, profile, analytics, drills/session, settings,
bot-game (+WebSocket), accuracy, debrief, /api/analyse.
```

### Concurrency & event loop
- **Windows + Python 3.12**: `main.py` forces `WindowsProactorEventLoopPolicy`
  at import time *and* inside worker threads, so `chess.engine.popen_uci` can
  spawn Stockfish. Do not remove this.
- Blocking work (Stockfish, Groq, Lichess, Maia2) runs off the event loop via
  `loop.run_in_executor(None, ...)` or daemon threads. SSE/streaming endpoints
  build their context in an executor, then stream.

### Shared singletons (in `main.py`, imported by other routers)
- **Stockfish**: `_sf_lock` (threading.Lock) + `_ensure_engine()`. Always hold
  `_sf_lock` around `engine.analyse(...)`. Other routers do
  `from backend.main import _sf_lock, _ensure_engine`.
- **Maia2**: module-level singleton in `backend/bot/maia_engine.py`.

---

## 2. Data layer — everything is files

No database, no auth. Identity = username string. State is JSON/SQLite/pickle on
disk. Never add a DB/vector store/Redis without asking.

### Per-user state — `data/output/{username}_*`
| File | Written by | Read by |
|---|---|---|
| `_mistakes.json` | ingestion + `run_clustering` (re-persists cluster_id) | profile, analytics, replay, counterfactual, coach, matching |
| `_clusters.json` | Stage 2 `run_clustering` | profile, replay, counterfactual, matching, coach |
| `_profile.json` | Stage 2 | dashboard enrichment (optional) |
| `_game_meta.json` | ingestion / `backfill_meta` | games, replay, counterfactual, coach |
| `_settings.json` | `/api/settings` | everywhere (elo, platform) |
| `_srs.json` | drills | session builder, coach context |
| `_alerts.json`, `_sync.json` | live_sync | alerts UI, coach context |
| `_style.json`, `_dna_card.png` | card.py | DNA card, dashboard, coach context |
| `_counterfactual.json` | counterfactual.py | dashboard |
| `_insight_{cid}.json`, `note_{hash}.json` | replay.py | replay UI |
| `_coach_profile.json`, `_coach_memory.json` | coach package | coach (Layers 1 & 2) |
| `_scaler.pkl`, `_reducer.pkl` | **legacy** (old UMAP Stage 2) | no longer required by matching |

### Shared caches & corpora — `data/`
- `opening_cache.db`, `endgame.db` — SQLite, auto-created on import via `_init_db`
  with idempotent `ALTER TABLE … ADD COLUMN` wrapped in try/except.
- `puzzles/` — `index.npz` (vectors+ratings) + `meta.json` (per-puzzle id, fen,
  moves, rating, **space-separated themes**, threat, game_url). Loaded once into
  memory (`ml/puzzles/retriever.py` singleton).
- `opening_knowledge.json` (47), `endgame_knowledge.json` (25),
  `endgame_positions.json` (66) — hand-curated; extend in place, keep FENs legal.
- `bot_games/{id}.json` (+ `_debrief.json`) — Maia game records.

---

## 3. The blindspot pipeline (ML core, `ml/`)

Three stages. Input is a username; output is a ranked blindspot profile + drills.

### Stage 1 — mistake extraction & classification
`ml/pipeline.py::run_ingestion` →
1. **Fetch** last N games from Lichess/Chess.com public API (username only).
2. **Two-pass Stockfish**: depth-12 screen, depth-18 on candidates. Mistake when
   `eval_drop_cp ≥ 100`.
3. **Classify** each mistake via the **transformer** (`ml/classifier/transformer/`):
   - `classifier.py::TransformerThreatClassifier` is a **pure transformer** — the
     old rule→depth→LightGBM funnel was dropped. It loads
     `models/stage1_transformer.pt` + `stage1_reference.pkl`.
   - Returns `ClassificationResult(threat_type, confidence, method, eval_drop_category)`
     where `method ∈ {transformer, transformer_positional, skip}`.
   - OOD / positional positions (SupCon embedding distance) → `threat_type="other"`,
     method `transformer_positional`.
   - `< 50cp` drops are skipped (magnitude guard, the only non-NN filter kept).
   - 14 tactical `THREAT_TYPES` + positional buckets. Falls back to no-op if the
     model files are absent (pipeline still runs, classification degrades).
4. **Maia2 filter**: drop positions that are universally hard for humans.
Output: `MistakeEvent` dataclass list → `_mistakes.json`.

### Stage 2 — deterministic blindspot families (`ml/clustering/`)
Replaced UMAP+HDBSCAN+Groq. **No ML at request time, no LLM, no scaler/reducer.**
- `families.py` — fixed expert map of 14 threat types → **5 families**
  (`loose_pieces`, `alignment`, `defender_disruption`, `king_safety`,
  `positional`) + `unclassified` (positional/`other`). Exposes `family_of`,
  `family_info` (name + skill text), `family_lichess_themes()`.
- `profile.py::build_profile` — groups mistakes by family, scores each
  `frequency × recency × severity` (eval-drop capped at 1000cp; 14-day recency
  half-life). Emits one `BlindspotCluster` per non-empty family.
- `profile_pipeline.py::run_clustering(mistakes, username, output_dir)` — the
  drop-in Stage-2 entry point (same signature as the old pipeline). Sets each
  `mistake.cluster_id = family_of(threat_type)`, writes `_clusters.json`,
  `_profile.json`, **and re-persists `_mistakes.json` with cluster_ids** (critical:
  replay/counterfactual/coach filter mistakes by cluster_id). Also exposes
  `allocate_puzzles(clusters, total)` for Stage 3.

**Cluster identity rule (load-bearing):** a cluster is identified by
`cluster_id` (now the family-key string) + `centroid`, **never** the display
label. `ml/matching.py` projects a fresh mistake to a cluster purely via
`family_of(threat_type)` — `MatchContext` only needs `_clusters.json` (no pkl).
`match_events` returns matched for tactical families, unmatched for
`unclassified`. Consumers: live_sync (alerts, cosine-style threshold), replay,
counterfactual, debrief — all unchanged by the rewrite because the public API
was preserved.

### Stage 3 — drill retrieval (`ml/puzzles/`, `ml/srs/`)
- `allocate_puzzles` distributes the puzzle budget across families by blindspot
  score (`unclassified` excluded — no tactical puzzles train positional play).
- `retriever.query_by_themes(themes, rating band)` — filters the **local** puzzle
  index by Lichess theme intersection (no API call). `family_lichess_themes()`
  maps families → theme tags via `ml/classifier/label_map.py`.
- `srs/session.py::build_session` — per-family budget, SRS due-scheduling (SM-2),
  seen-tracking. Mastery resets on repeated live blunders (live_sync).

---

## 4. Feature routers

- **openings.py** — `explore` proxies the Lichess Opening Explorer (24h SQLite
  cache, ELO-bucketed; needs `LICHESS_TOKEN`); `eval` is Stockfish depth-16
  cached forever; `ideas` is Groq cached forever.
- **opening_chat.py / endgames coach** — curated-corpus RAG + live stats, streamed
  over SSE (`meta` then `token`s then `done`). Reused by the Coach's
  `get_opening_theory` / `get_endgame_theory` tools via their `_knowledge_lookup`.
- **endgames.py** — static theory tree (frontend) + `by-config` instructive
  position finder (Lichess endgame puzzles first, Stockfish-gen fallback), Syzygy
  verification (`tablebase.lichess.ovh`, ≤7 pieces), tablebase-grounded coach.
- **replay.py** — `/{u}/{cid}/mistakes` reconstructs cluster membership with
  `ml.matching.assign_nearest` (now family-exact), enriches with game_meta;
  `/insight` (Groq, cached), `/note` (per-FEN Groq, cached), `/explain` (Groq).
- **counterfactual.py** — re-fetches game results (chess.com archives / lichess
  export, since game_meta lacks result), then a **bounded performance-rating**
  model (never flat per-game Elo).
- **card.py** — 5-axis style archetype + DNA card PNG via Pillow (the only image
  dep). Axes computed from the mistake dataset with documented proxies; sparse
  axes reported `None`.
- **live_sync.py** — background daemon polls for new games, re-runs Stage 1,
  matches new mistakes against the user's clusters (cosine > 0.72 → alert),
  resets mastery on repeats. `start_scheduler()` is launched from `main.py`.
- **bot-game (main.py + bot/)** — Maia2 move generator (first-move-forced-to-pawn
  guard + OOD-retreat filter), WebSocket play, chess.com-style accuracy, post-game
  blindspot debrief. WS decides who opens by **side-to-move vs user_color**.

---

## 5. The Forked Coach (`backend/coach/`)

Persistent agentic coach. Groq `llama-3.3-70b-versatile` with 6 tools, streamed
over SSE with mid-conversation tool orchestration. Three personalisation layers.

```
coach/
  router.py     /api/coach/{chat,save-questionnaire,profile,update-memory}
  profile.py    Layer 1 — questionnaire + memory file IO
  context.py    Layer 3 — live user-context block (built every session)
  memory.py     Layer 2 — rolling Groq prose summary, updated after a session
  tools.py      6 tool schemas + dispatch (all grounded in real data/corpora)
  explain.py    explain_position: C1 (vLLM endpoint) → Stockfish fallback
```

### Layers
1. **Questionnaire** (`_coach_profile.json`) — 5 cold-start answers; gated once.
2. **Memory** (`_coach_memory.json`) — ~500-token rolling summary; `memory.py`
   re-summarises the transcript via Groq when a session ends (frontend calls
   `/update-memory` on unmount for sessions ≥3 messages).
3. **Context block** (`context.py::build_user_context`) — rating, archetype, goal,
   ranked blindspots, recent games, unread alerts, drill perf, memory summary,
   breakthroughs. ~300-400 tokens, embedded in the system prompt. **Theory mode
   omits it** (universal answers).

### Chat orchestration (`router.py::_chat_stream`)
SSE events: `meta` → (`tool`, `tool_result`)\* → `token`\* → `done` | `error`.
Bounded loop (`MAX_TOOL_ROUNDS=4`): call Groq with `tools` + `tool_choice=auto`;
if the message has `tool_calls`, emit a `tool` event, run `dispatch_tool`, emit
`tool_result` (board-bearing tools only), append the tool result, loop; else
stream the final text. Empty `message` = personalised greeting (tools disabled).

**Groq + Llama gotcha:** Llama-3.3 sometimes emits a malformed inline tool call
that Groq rejects with `tool_use_failed` (HTTP 400). `_create()` salvages the
model's prose from `failed_generation` (stripping the broken `<function=…>` tag),
else retries once with tools disabled. Keep this guard.

### Tools (`tools.py`) — all return JSON-serialisable dicts, never raise
| Tool | Source of truth |
|---|---|
| `get_mistake_positions` | `_mistakes.json` filtered by cluster_id |
| `explain_position` | `explain.py` (C1 → Stockfish) |
| `get_puzzle` | `ml/puzzles` index by family themes, rating-banded |
| `analyze_pgn` | FEN → explain; PGN → per-ply Stockfish depth-12 mistake scan |
| `get_opening_theory` | `opening_chat._knowledge_lookup` |
| `get_endgame_theory` | `endgames._knowledge_lookup` |

### C1 (`explain.py`)
C1 (CSSLab) is a Qwen3 SFT/RL model needing GPU + vLLM; **no public weights** as
of writing. `explain.py` calls a C1 **OpenAI-compatible endpoint** when
`C1_ENDPOINT` (+ optional `C1_API_KEY`, `C1_MODEL`) is set, with a 3s timeout;
otherwise it uses **Stockfish depth-18 + a structured template** (always works,
names the motif via the Stage-1 classifier). The fallback must never be removed.

---

## 6. Environment & conventions

- `.env`: `GROQ_API_KEY` (coaches, cluster naming, insights), `LICHESS_TOKEN`
  (Opening Explorer 401s without it on many networks). Optional `C1_ENDPOINT`.
- Models in `models/`: `stage1_transformer.pt` (~17MB), `stage1_reference.pkl`.
- **Coaches stream SSE**: `meta` event first (sources/flags), then `token`s, then
  `done`. Frontend parses with a manual `ReadableStream` reader (EventSource
  can't POST).
- **SQLite caches auto-create** on import; add columns idempotently.
- **No heavy deps** (pgvector, vector DB, sentence-transformers, Celery/Redis,
  large local models) without asking. Prefer curated corpora + numpy + SQLite.
- **Verify after backend edits**: import-check `backend.main`, confirm routes
  register (`len(app.routes)`), and exercise the touched endpoint with
  `fastapi.testclient.TestClient`.

---

## 7. Request flow cheat-sheet

- **Onboard a user**: `POST /api/ingest` → background Stage 1 → `run_clustering`
  (Stage 2) → SSE progress on `/api/ingest/status/{job}` → profile ready.
- **Dashboard**: `/api/profile/{u}` (clusters + per-cluster enrichment) +
  `/api/analytics/{u}` (severity, time-pressure, Maia difficulty) +
  `/api/profile/{u}/counterfactual` + `/api/profile/{u}/style`.
- **Drill**: `/api/session/{u}` (Stage 3 retrieval) → `/api/session/complete` (SRS).
- **Coach**: `/api/coach/profile/{u}` (gate) → `/api/coach/chat` (SSE) →
  `/api/coach/update-memory/{u}` on exit.
- **Replay**: `/api/cluster/{u}/{cid}/mistakes` → `/note`, `/explain` per position.
