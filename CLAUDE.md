# Pawnprint — Claude Code context

## What we're building

Adaptive chess curriculum app. The core insight: Chess.com and Lichess give you puzzles, but they're static and disconnected from your actual games. Pawnprint watches your game history, detects *your specific recurring blindspots* using ML clustering, and generates targeted drills that fix exactly those patterns.

The user connects their Chess.com or Lichess account (username only — no OAuth needed, both have public APIs), we pull their last 200+ games, annotate every move with Stockfish, cluster the mistake events, surface their top blindspots by name ("Back-rank threats — missed 23 times"), and serve personalized puzzle sequences with spaced repetition.

Product name: **Pawnprint**. Working tagline: "A coach who knows exactly how you lose."

---

## Why this is defensible

- Chess.com could build this but won't — their Learn section is a revenue line, not a priority. Engineering goes to matchmaking and social features.
- The moat is the per-user blindspot graph. It gets richer with every game played and can't be replicated by a fresh account.
- The feedback loop is the key: when a user blunders the same pattern in a real game, the system detects it and resets that cluster's mastery score. No static puzzle platform can do this.
- Realistic exit: acquisition by Chess.com at ~50K paying users.

---

## ML pipeline (3 stages)

### Stage 1 — Ingestion and annotation

1. **PGN parser** — fetch games from Chess.com API (`api.chess.com/pub/player/{username}/games/{year}/{month}`) or Lichess API (`lichess.org/api/games/user/{username}`). Both require only a username, no auth.
2. **Stockfish annotation** — run every position through Stockfish depth-20. Extract: `eval_before` (centipawns), `eval_after`, `eval_drop`, `best_move`, `best_move_eval`.
3. **Mistake extractor** — flag moves where `eval_drop > 50cp` as mistake events. A player with 500 games yields ~3,000–8,000 events.

### Stage 2 — Failure mode detection

Feature vector per mistake event (~120-dim):
- Board features (64-dim): piece map one-hot, material balance, pawn structure, king safety
- Contextual features (~56-dim): game phase, time pressure (clock data), eval_drop, move complexity, `threat_type` (categorical: fork / pin / skewer / back-rank / passed-pawn / king-attack / zugzwang)

Pipeline:
1. Embed positions using Leela Chess Zero's policy net (penultimate layer → 256-dim). Open source, no training needed.
2. Concatenate contextual features → 312-dim final vector.
3. UMAP to 16-dim (preserves local structure, ~5s per 5,000 points).
4. HDBSCAN clustering (`min_cluster_size=15`). Handles noise, no need to specify k.
5. Label clusters with an LLM: send 5 nearest real game positions + dominant threat_type → "Name this chess weakness in 5 words or fewer."

Blindspot scoring:
```
score(cluster) = frequency × recency_weight × (1 - mastery)

frequency      = cluster_size / total_mistakes
recency_weight = exp(-λ × days_since_last_occurrence)
mastery        = puzzle_accuracy_on_this_cluster  # 0→1, starts at 0
```

Cold start: HDBSCAN needs ~200+ mistake events (~30–50 games). Before that, fall back to rating-band priors clustered from community data.

### Stage 3 — Puzzle generation and scheduling

**Path A — Retrieval (covers ~80% of serves):**
- Vector DB (Qdrant or pgvector) of ~5M positions from Lichess open puzzle database + annotated games.
- Query by blindspot cluster centroid, filter by `threat_type` and `difficulty: user_elo ± 150`.
- Re-rank by: closest to centroid + highest engine validation score + not seen by this user.

**Path B — Synthesis (rare blindspot types or exhausted pool):**
- Start from a real game position near the cluster centroid.
- Apply random legal moves with rollout guided by a policy net biased toward the target threat type.
- Stop when Stockfish confirms: eval_delta > 200cp for exactly one move.
- Validation: best move gap > 1.5 pawns, second-best clearly inferior, < 3 winning moves.
- Expect to reject ~60% of candidates.

**Spaced repetition scheduler:**
```python
session_weights = softmax(blindspot_scores * temperature)
# temperature=2.0 → concentrate on top blindspot
# temperature=0.5 → distributed practice

# After each puzzle attempt:
if correct and fast:
    cluster.mastery += 0.05
    cluster.next_review = now + interval * ease_factor
elif correct and slow:
    cluster.mastery += 0.02
else:
    cluster.mastery -= 0.03
    cluster.next_review = now + short_interval
```

SM-2 as base for interval calculation. Mastery decay is cluster-wide, not per-puzzle. Intervals reset if user blunders the same pattern in a live game.

---

## Data model (outline)

```
User
  id, username, chess_com_handle, lichess_handle
  elo_rapid, elo_blitz, created_at

Game
  id, user_id, pgn, platform, played_at, time_control
  annotated: bool, annotated_at

MistakeEvent
  id, game_id, user_id
  fen, move_played, best_move
  eval_before, eval_after, eval_drop
  threat_type, game_phase, time_remaining
  cluster_id (nullable until clustered)

BlindspotCluster
  id, user_id
  label (LLM-generated, e.g. "Back-rank threats")
  size, centroid_vector
  mastery (0.0–1.0)
  last_occurrence_at, next_review_at
  score (computed)

Puzzle
  id, fen, solution_move, threat_type
  source: "retrieved" | "synthesized"
  difficulty_elo, engine_validated: bool
  embedding_vector

PuzzleAttempt
  id, user_id, puzzle_id, cluster_id
  correct: bool, time_taken_ms
  attempted_at
```

---

## Product / UX decisions

**Onboarding:**
- Step 1: pick platform (Chess.com / Lichess) and enter username. No password, no OAuth.
- Step 2: background job pulls last 200 games and annotates (~40 seconds).
- Step 3: show first blindspot profile. This is the "aha" moment — user sees their weaknesses named for the first time.

**Home dashboard:**
- Stat cards: games analysed, blindspots found, estimated rating gain if top 2 fixed.
- Blindspot profile: ranked list with urgency bars, "Drill now" per blindspot.
- Today's drill queue: ~12 puzzles, ~15 min, grouped by blindspot.

**Puzzle session UX — key decisions:**
- No puzzle rating shown. Ratings turn practice into ego management. Show urgency instead ("your #1 blindspot, missed 23 times").
- Context panel stays visible during the puzzle. Shows which blindspot it targets and a reference to a real game where the user missed this exact pattern.
- "From your game vs. Priya_84 · 18 days ago · move 31 — you played Qe4, Rd8# was available." This emotional hook is the main differentiator from static puzzles.
- Hint available but costs a small mastery penalty.

---

## Tech stack (recommended starting point)

**Backend:**
- Python (FastAPI)
- PostgreSQL with pgvector extension for position embeddings
- Stockfish via `python-chess` library
- Celery + Redis for background annotation jobs
- Leela Chess Zero policy net for position embeddings (ONNX export)

**Frontend:**
- React + TypeScript
- Chess board: `chess.js` + `react-chessboard`
- Tailwind CSS

**ML / data:**
- `python-chess` for PGN parsing and board manipulation
- `umap-learn` for dimensionality reduction
- `hdbscan` for clustering
- `qdrant-client` or pgvector for vector search

**Infrastructure (MVP):**
- Single VPS is fine to start (annotation is CPU-bound, not GPU)
- Stockfish runs locally on the server — no external API cost
- Lichess puzzle DB is free and downloadable (~50M puzzles, ~7GB)

---

## MVP scope (6-week target)

Week 1–2: Game ingestion pipeline. PGN fetch → Stockfish annotation → mistake extraction. Ship as a background job that works end-to-end for Chess.com and Lichess usernames.

Week 3: Clustering pipeline. Feature extraction → UMAP → HDBSCAN → LLM labelling. Get blindspot profiles generating for real users.

Week 4: Puzzle retrieval. Import Lichess puzzle DB into pgvector. Build retrieval endpoint that takes a cluster centroid and returns 10 matching puzzles.

Week 5: Frontend. Onboarding flow, dashboard, puzzle session screen. Functional but not polished.

Week 6: SRS scheduler + feedback loop. Mastery tracking, spaced repetition scheduling, game re-sync detecting repeated blindspot patterns.

---

## What we're explicitly NOT building in MVP

- Puzzle synthesis (use retrieval only — Lichess has 50M puzzles, you won't exhaust them)
- Opening preparation
- Social / multiplayer features
- Mobile app (web-responsive is fine)
- Coaching marketplace

---

## Competitive context

- Chess.com: dominant player, weak Learn section, static puzzles with no connection to your games
- Lichess: free, open-source, excellent puzzles but zero personalization
- Chessable: MoveTrainer is strong for openings, not for tactical blindspots
- Neither Chess.com nor Lichess has the game-history → blindspot → targeted drill loop

---

## Notes for Claude Code

- When building the annotation pipeline, use `python-chess` engine wrapper. Stockfish should run at depth 18–20 for accuracy, depth 12 for fast pre-screening.
- The Lichess puzzle DB is available at `database.lichess.org` — it's a CSV with FEN, moves, themes, rating. Import into pgvector with a batch embedding job.
- `threat_type` classification can be done with a simple rule-based system first (check for fork geometry, back-rank configuration, etc.) before investing in learned classification.
- HDBSCAN `min_cluster_size=15` is a starting point — tune based on how many games the user has. For users with < 100 games, lower to 8.
- The LLM labelling step (cluster → human-readable name) can be a simple Claude API call with the 5 representative positions as FEN strings.
