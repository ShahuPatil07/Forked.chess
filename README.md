# Pawnprint

> **"A coach who knows exactly how you lose."**

Pawnprint watches your real game history, finds your specific recurring tactical blindspots using ML clustering, and serves targeted drills that fix exactly those patterns — not generic puzzles.

---

## The Problem

Chess.com and Lichess both have puzzle trainers. Neither knows that *you* personally have missed a back-rank checkmate 23 times this month. They serve the same static puzzle pool to everyone. Pawnprint changes that.

---

## How It Works (Full Pipeline)

```
Your Lichess / Chess.com username
        |
        v
 [Stage 1: Ingestion]
  Fetch last 200 games via public API (no login needed)
  Annotate every position with Stockfish depth-18
  Extract "mistake events" where eval dropped >= 50cp
  Classify the tactical theme of each missed move
        |
        v
 [Stage 2: Clustering]
  Build 111-dim feature vectors per mistake event
  Reduce to 16-dim via UMAP
  Cluster with HDBSCAN (finds k automatically)
  Label each cluster with Claude: "Back-rank threats"
  Save fitted scaler + UMAP reducer for Stage 3
        |
        v
 [Stage 3: Drill Queue]
  Index 100K+ Lichess puzzles in the same UMAP space
  Query nearest puzzles per blindspot cluster centroid
  Filter by threat type + rating band + already-seen
  Serve in spaced-repetition order (SM-2 scheduler)
  Track mastery per cluster; reset on live-game blunders
```

**Real results on ShahuPatil07 (80 Lichess games):**
- 594 mistake events extracted
- 13 blindspot clusters found (96% of events covered, only 24 noise)
- Top cluster: 232 middlegame events — biggest recurring pattern
- 90,138 Lichess puzzles indexed and ready to serve

---

## Project Structure

```
PawnPrint/
├── requirements.txt
├── scripts/
│   ├── setup_stockfish.py        # Download Stockfish binary from GitHub
│   ├── run_analysis.py           # Stage 1 CLI
│   ├── run_clustering.py         # Stage 2 CLI
│   ├── run_puzzle_import.py      # Stage 3a CLI — download + index Lichess puzzles
│   └── run_session.py            # Stage 3b CLI — interactive drill session
├── ml/
│   ├── config.py                 # Paths, depths, thresholds
│   ├── pipeline.py               # Stage 1 orchestrator
│   ├── visualization.py          # Matplotlib plots
│   ├── ingestion/
│   │   ├── fetcher.py            # Chess.com + Lichess API clients
│   │   ├── annotator.py          # Two-pass Stockfish annotator
│   │   ├── mistake_extractor.py  # Mistake event builder
│   │   └── threat_classifier.py  # Rule-based tactical classifier
│   ├── clustering/
│   │   ├── feature_extractor.py  # 111-dim feature vectors
│   │   ├── blindspot.py          # BlindspotCluster dataclass + scoring
│   │   ├── labeller.py           # Claude API cluster naming
│   │   └── pipeline.py           # Stage 2 orchestrator
│   ├── puzzles/
│   │   ├── importer.py           # Lichess puzzle CSV downloader + feature extractor
│   │   └── retriever.py          # Nearest-neighbour puzzle search index
│   └── srs/
│       ├── scheduler.py          # SM-2 mastery + interval tracking per cluster
│       └── session.py            # Session builder (softmax-weighted cluster sampling)
└── data/
    ├── stockfish/
    │   └── stockfish.exe
    ├── output/
    │   ├── <username>_mistakes.json    # Stage 1 output
    │   ├── <username>_clusters.json   # Stage 2 output
    │   ├── <username>_scaler.pkl      # Saved StandardScaler (for Stage 3)
    │   ├── <username>_reducer.pkl     # Saved UMAP reducer (for Stage 3)
    │   └── <username>_srs.json        # SRS state (mastery + intervals)
    ├── puzzles/
    │   ├── index.npz                  # (N, 16) UMAP-projected puzzle vectors
    │   ├── meta.json                  # Puzzle metadata (FEN, moves, rating, themes)
    │   ├── ids.txt                    # Puzzle IDs
    │   └── themes.txt                 # Space-separated theme tags per puzzle
    └── seen/
        └── <username>_seen.json       # Puzzles already shown to user
```

---

## Code Files — Detailed

### `ml/config.py`

Central configuration. Auto-discovers the Stockfish binary by globbing `data/stockfish/`. All other modules import from here.

Key constants:
- `ANNOTATION_DEPTH_FAST = 12` — depth for the pre-screening pass
- `ANNOTATION_DEPTH_FULL = 18` — depth for deep re-analysis of flagged positions
- `FAST_THRESHOLD_CP = 30` — flag for deep re-analysis if fast eval-drop >= this
- `MISTAKE_THRESHOLD_CP = 50` — record as a mistake event if eval-drop >= this

Override Stockfish path without editing code:
```bash
$env:STOCKFISH_PATH = "C:\path\to\your\stockfish.exe"
```

---

### `ml/ingestion/fetcher.py`

HTTP clients for the two chess platforms. Both APIs are **fully public** — no login, no OAuth, just a username.

**Chess.com** (`fetch_chesscom_games`):
- Hits `api.chess.com/pub/player/{username}/games/{year}/{month}` month by month, newest-first.
- Returns raw API dicts containing a `pgn` field with full PGN including clock comments.

**Lichess** (`fetch_lichess_games`):
- Hits `lichess.org/api/games/user/{username}` with `Accept: application/x-ndjson`.
- Streams newline-delimited JSON so large game lists don't require buffering the entire response.

Both expose a `parse_*_game()` function that normalises the raw API response into a flat dict: `game_id`, `pgn`, `user_color`, `white_elo`, `black_elo`, `time_control`, `played_at`.

---

### `ml/ingestion/annotator.py`

The core engine interface. Takes a PGN string and a live Stockfish process, returns one `PositionAnnotation` per move.

**Two-pass strategy** (key performance decision):

Naively annotating every position requires 2 engine calls per move (before + after). This module cuts that to **N+1 calls** for N moves by recognising that position i+1 is shared between moves i and i+1 — the "after" result for move i is the "before" result for move i+1 (with a sign flip for perspective change).

```
Pass 1 (depth 12, fast):
  Evaluate all N+1 board positions once.
  Compute implied eval-drop for each move.
  Flag moves where drop >= FAST_THRESHOLD_CP (30cp).

Pass 2 (depth 18, thorough):
  Re-evaluate only the flagged positions.
  All other positions keep their fast-pass values.
```

In practice ~15% of positions are flagged, giving roughly **5x speedup** over full-depth analysis everywhere.

**Key data structure — `PositionAnnotation`:**
```
fen              — board before the move (FEN string)
move_played_uci  — what the player did
move_played_san  — human-readable version (e.g. "Nf3")
eval_before_cp   — engine eval before the move (mover's perspective, centipawns)
eval_after_cp    — engine eval after the move (still mover's perspective)
eval_drop_cp     — max(0, eval_before - eval_after)  <- the key signal
best_move_uci    — what Stockfish would have played
clock_remaining_ms — clock time left (parsed from PGN comment "[%clk 0:05:32]")
```

---

### `ml/ingestion/threat_classifier.py`

Rule-based classifier that looks at the best move and asks: "what tactical pattern did the player fail to see?"

**Categories (checked in priority order):**

| Label | Detection logic |
|---|---|
| `back_rank` | Best move delivers checkmate or near-forced mate on rank 1 or 8 via rook/queen |
| `fork` | Best move attacks 2+ valuable enemy pieces simultaneously (excluding pawns) |
| `hanging_piece` | Best move captures a piece that is undefended OR worth more than the attacker |
| `pin` | Best move creates an absolute pin (opponent piece can't legally move without exposing king) |
| `king_attack` | Best move delivers check, OR attacks a square in the opponent king's zone |
| `passed_pawn` | Best move advances a passed pawn or promotes |
| `other` | None of the above — typically strategic mistakes |

**Diagnostic result on real games (ShahuPatil07, 80 Lichess games, 594 mistakes):**
- `other`: 53.4% — genuine strategic/non-tactical mistakes, not classifier failure
- `king_attack`: 24.1% — king-zone pressure dominates
- `hanging_piece`: 8.2%
- `pin`: 8.2%
- `back_rank`: 2.4%
- `fork`: 2.0%
- `passed_pawn`: 1.7%

The large "other" bucket is acceptable — the 64-dim board feature vector carries the geometric signal for clustering. `threat_type` is one of 7 categorical features, not the primary discriminator.

---

### `ml/ingestion/mistake_extractor.py`

Filters `PositionAnnotation` objects into `MistakeEvent` objects.

**Filtering rules:**
1. Must be the target user's move (not the opponent's)
2. `eval_drop_cp >= 50`
3. `eval_before_cp >= -300` — skip positions where the player was already badly losing (hopeless positions produce spurious "mistakes")

Each `MistakeEvent` fields:
```
game_id, user_id, fen, move_played_uci, move_played_san
best_move_uci, eval_before_cp, eval_after_cp, eval_drop_cp
threat_type, game_phase, time_remaining_ms, move_number
played_at_unix, cluster_id (None until Stage 2)
```

---

### `ml/pipeline.py`

Stage 1 orchestrator. Ties fetcher → annotator → extractor into one call:

```python
from ml.pipeline import run_ingestion
mistakes = run_ingestion("ShahuPatil07", platform="lichess", min_games=80)
```

Outputs `data/output/<username>_mistakes.json` and prints a threat/phase breakdown summary.

---

### `ml/visualization.py`

Two matplotlib plots for post-analysis inspection:

**`plot_eval_curve_for_game(annotations, game_meta)`** — 3 panels for a single game:
- Panel 1: `eval_before` vs `eval_after` line chart with mistake markers (red triangles at >=50cp drops)
- Panel 2: `eval_drop` bar chart per move, annotated with best-move UCI for top blunders
- Panel 3: best-move eval vs played-move eval step chart

**`plot_mistake_overview(mistakes, username)`** — 4-panel dashboard across all games:
- Threat-type horizontal bar chart
- Eval-drop histogram with mean/median lines
- Game-phase pie chart
- Eval-drop vs move-number scatter coloured by threat type

---

### `ml/clustering/feature_extractor.py`

Converts each `MistakeEvent` into a **111-dimensional float32 vector**.

```
[0:64]   Piece map (64-dim)
         Each square: piece value / 9.0, from mover's perspective.
         +1.0 = own queen, negative for enemy pieces, 0 = empty.

[64:74]  Material balance (10-dim)
         Per-piece-type balance + aggregate metrics (own_material/39, etc.)

[74:86]  Pawn structure (12-dim)
         Doubled/isolated/passed pawns, open files, pawn advancement.

[86:94]  King safety (8-dim)
         King position, pawn shield count, enemy attacks on king zone.

[94:96]  Eval metrics (2-dim)
         eval_drop_norm, eval_before_norm (both clamped to [-1, 1])

[96:99]  Game phase one-hot (3-dim): [opening, middlegame, endgame]

[99:106] Threat type one-hot (7-dim): [back_rank, fork, hanging_piece, pin,
                                        king_attack, passed_pawn, other]

[106]    Time pressure (1-dim): 0 = no pressure, 1 = near flag

[107]    Move number / 60, capped at 1.0

[108]    Best move is capture (0/1)
[109]    Best move gives check (0/1)

[110]    Mobility ratio: mover's legal moves / total legal moves
```

---

### `ml/clustering/blindspot.py`

**`BlindspotCluster` dataclass** — the core product output:

```python
cluster_id            int      — HDBSCAN cluster index
user_id               str
label                 str      — "Back-rank threats" (LLM-generated)
size                  int      — how many times this pattern appeared
centroid              list     — 16-dim UMAP centroid (for puzzle retrieval)
dominant_threat_type  str      — most common threat_type in this cluster
dominant_game_phase   str
mastery               float    — 0.0 -> 1.0 as puzzles are solved correctly
last_occurrence_unix  int
next_review_unix      int      — filled by Stage 3 SRS scheduler
score                 float    — urgency score
representative_events list     — 5 positions closest to centroid (for UI context)
```

**Urgency score:**
```
score = frequency * recency_weight * (1 - mastery)

frequency      = cluster.size / total_mistake_events
recency_weight = exp(-0.05 * days_since_last_occurrence)   # half-life ~14 days
mastery        = 0.0 at start
```

---

### `ml/clustering/labeller.py`

Sends each cluster's 5 representative positions to `claude-haiku-4-5-20251001` and asks for a <=5-word blindspot name.

**What gets sent per cluster:**
```
Dominant tactical theme: king_attack
Game phase: middlegame
Occurrences: 34

1. FEN: r1bq1rk1/pp3ppp/...
   Played: Nd4  |  Engine best: f2f4  |  Eval drop: 187cp
...
```

**Prompt caching:** The system prompt is marked `cache_control: ephemeral` — identical across all cluster calls in a session, so calls after the first hit the Anthropic cache (~10x cost reduction).

**Fallback (no API key):** Generates `"King Attack in the middlegame"` style labels from cluster metadata. Clustering still works; only label quality degrades.

---

### `ml/clustering/pipeline.py`

Stage 2 orchestrator. Four steps + artifact saving:

1. **Feature extraction** — builds the (N, 111) matrix
2. **Normalisation** — `StandardScaler` (mean-centre + unit variance)
3. **UMAP** — 111-dim -> 16-dim (`n_neighbors=15`, `min_dist=0.1`, `random_state=42`)
4. **HDBSCAN** — `min_cluster_size`, `min_samples = max(1, min_cluster_size // 3)`, `eom` selection
5. **Save** — clusters JSON + `<username>_scaler.pkl` + `<username>_reducer.pkl`

The saved scaler and reducer are **required by Stage 3** to embed new puzzle positions in the same space as the cluster centroids.

---

### `ml/puzzles/importer.py`

Downloads the Lichess puzzle database (`.zst` compressed CSV), extracts features for each puzzle position, projects them through the user's saved scaler + UMAP reducer, and saves a numpy search index.

**Theme -> threat_type mapping** (30+ Lichess theme tags mapped to our 7 categories):
```python
"backRankMate" -> "back_rank"
"fork"         -> "fork"
"pin"          -> "pin"
"hangingPiece" -> "hanging_piece"
"kingsideAttack", "mateIn1..5", "mate" -> "king_attack"
"promotion", "passedPawn"              -> "passed_pawn"
```

**Index files saved to `data/puzzles/`:**
- `index.npz` — `(N, 16)` float32 vectors + `(N,)` int16 ratings
- `meta.json` — full puzzle metadata (FEN, moves, rating, themes, game URL)
- `ids.txt`, `themes.txt` — fast lookup lists

**Converting a puzzle to a MistakeEvent for feature extraction:**
The puzzle FEN is the position *before* the opponent's last move. The importer applies that move first (reconstructing the position the user would face), then extracts features from the resulting board. This ensures puzzle embeddings are in the same FEN space as mistake events.

---

### `ml/puzzles/retriever.py`

`PuzzleIndex` — lazy-loaded in-memory index over the 90K+ puzzle vectors.

**`query(centroid, threat_type, min_rating, max_rating, seen_ids, top_k)`:**
1. Apply rating band mask: keep only puzzles in `[min_rating, max_rating]`
2. Apply threat filter: keep only puzzles matching `threat_type` (skipped if "other")
3. Apply seen filter: remove puzzles already shown to this user
4. L2 distance from `centroid` across remaining vectors
5. Return top-k nearest as `PuzzleResult` objects

Fallback: if the filtered set is empty (e.g. no unseen puzzles in that theme), drops the threat filter and retries with rating + seen filters only.

Query speed: <50ms for 90K puzzles using numpy broadcasting.

---

### `ml/srs/scheduler.py`

SM-2 variant mastery tracker. State persists in `data/output/<username>_srs.json`.

**`ClusterState` fields:** `cluster_id`, `label`, `mastery`, `interval_days`, `ease_factor`, `last_review`, `next_review`, `score`, `size`

**`record_attempt(cluster_id, correct, time_taken_s)`:**

| Outcome | Mastery delta | Interval |
|---|---|---|
| Correct + fast (<30s) | +0.05 | `interval *= ease_factor` (up to 2.5) |
| Correct + slow | +0.02 | `interval *= 1.5` |
| Wrong | -0.03 | Reset to 1 day |

**`reset_cluster(cluster_id)`:** Called when a user blunders the same pattern in a real game. Drops mastery by 0.10, resets interval to 1 day. This is the core feedback loop — live game detection that no static puzzle platform can replicate.

---

### `ml/srs/session.py`

Assembles a drill session from the puzzle index.

**Session building algorithm:**
1. Load `SRSState` for the user; sync with latest cluster list
2. Filter to clusters whose `next_review <= now` (or all clusters if `due_only=False`)
3. Compute `softmax(scores * temperature=2.0)` weights — concentrates on top blindspot while occasionally sampling others
4. For each puzzle slot: sample a cluster by weight, query the index for the nearest unseen puzzle within `[user_elo - 200, user_elo + 200]`
5. Persist seen puzzle IDs to `data/seen/<username>_seen.json` so repeats don't occur across sessions

---

## Setup & Running

### Prerequisites

- Python 3.10+
- Windows / macOS / Linux
- Internet connection (game fetching, Stockfish download, puzzle CSV stream)

### Step 1 — Virtual environment

```powershell
cd PawnPrint
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
```

### Step 2 — Install dependencies

```powershell
pip install -r requirements.txt
```

### Step 3 — Download Stockfish

```powershell
python scripts/setup_stockfish.py
```

Downloads ~110 MB from GitHub to `data/stockfish/stockfish.exe`. Run once.

### Step 4 — Stage 1: Game ingestion

```powershell
# Lichess
python scripts/run_analysis.py ShahuPatil07 --platform lichess --games 80

# Chess.com
python scripts/run_analysis.py hikaru --platform chesscom --games 200

# With plots
python scripts/run_analysis.py ShahuPatil07 --platform lichess --games 80 --plot
```

**Time:** ~20-40s per game at depth 18. 80 games ≈ 30-60 minutes.

**Output:** `data/output/<username>_mistakes.json`

### Step 5 — Stage 2: Clustering

```powershell
# Without API key (fallback labels)
python scripts/run_clustering.py ShahuPatil07 --min-cluster-size 8

# With Anthropic API key (LLM labels)
$env:ANTHROPIC_API_KEY = "sk-ant-..."
python scripts/run_clustering.py ShahuPatil07 --min-cluster-size 8
```

**Output:** `data/output/<username>_clusters.json`, `_scaler.pkl`, `_reducer.pkl`

### Step 6 — Stage 3a: Import puzzles (run once)

```powershell
# Downloads and indexes 100K Lichess puzzles (~10 minutes)
python scripts/run_puzzle_import.py ShahuPatil07

# Smaller set for testing
python scripts/run_puzzle_import.py ShahuPatil07 --puzzles 10000
```

**Output:** `data/puzzles/index.npz`, `meta.json`, `ids.txt`, `themes.txt`

### Step 7 — Stage 3b: Run a drill session

```powershell
python scripts/run_session.py ShahuPatil07 --elo 1400 --puzzles 12
```

```
============================================================
  Drill session for ShahuPatil07
  12 puzzles  |  ELO band: 1200-1600
============================================================

Puzzle 1/12
  Blindspot #1: Other in the middlegame  (missed 232 times)
  Rating: 1443  |  Themes: crushing kingsideAttack middlegame
  FEN: 5rk1/2q1bppp/...
  Opponent played: Rd1  |  Solution: Qxg2 -> Rxg2

  Did you solve it? [y/n/skip]:
```

After the session, SRS state is updated: correct answers extend the review interval, wrong answers reset it to 1 day.

---

## Output Files Reference

**`data/output/<username>_mistakes.json`** — array of mistake events:
```json
{
  "game_id": "2EmW8Yx6",
  "fen": "r1bq1rk1/pp2ppbp/2np1np1/...",
  "move_played_uci": "f8e8",
  "best_move_uci": "f7f5",
  "eval_drop_cp": 123,
  "threat_type": "king_attack",
  "game_phase": "middlegame",
  "cluster_id": "2"
}
```

**`data/output/<username>_clusters.json`** — array of blindspot clusters:
```json
{
  "cluster_id": 2,
  "label": "Back-rank vulnerability",
  "size": 67,
  "dominant_threat_type": "king_attack",
  "score": 0.071,
  "mastery": 0.0,
  "representative_events": [...]
}
```

**`data/output/<username>_srs.json`** — SRS state:
```json
{
  "cluster_id": "2",
  "mastery": 0.12,
  "interval_days": 3.75,
  "ease_factor": 2.6,
  "next_review": 1748822400
}
```

---

## Design Decisions

**No OAuth / no passwords** — Chess.com and Lichess both have fully public game APIs. A username is all we need.

**Two-pass annotation** — Annotating at depth 18 everywhere: ~60 min for 80 games. Two-pass (depth 12 pre-screen → depth 18 only on flagged ~15%): ~30-45 min. Same accuracy, 2x faster.

**HDBSCAN over K-means** — K-means requires specifying k and assumes spherical clusters. Blindspot patterns are not spherical in position space, and we don't know how many a player has. HDBSCAN finds natural density structure and marks one-off mistakes as noise.

**Rule-based threat classifier** — A learned classifier needs labelled training data we don't have. The rules are interpretable and good enough; the LLM sees actual board positions at labelling time so a wrong `threat_type` tag doesn't break the cluster name.

**Hand-crafted 111-dim features (current)** — Interpretable, no model dependency, runs at 10K positions/second. To be replaced with Maia2 embeddings (see Planned Improvements).

**UMAP reducer saved as pkl** — Stage 3 must embed puzzle positions in the *exact same* latent space as the cluster centroids. Saving the fitted scaler + reducer ensures this. Without it, puzzle vectors and centroids would live in incompatible spaces.

**L2 search over pgvector/Qdrant** — For 100K puzzles, numpy L2 in memory runs in <50ms. No database needed for MVP. At 1M+ puzzles, swap retriever for Qdrant or pgvector.

---

## Planned Improvements

These are the prioritised next tasks — not features to add but quality improvements to what exists. Grouped by stage.

---

### Stage 1 — Maia2 Integration (Highest Priority)

**What Maia2 is:** Maia2 (NeurIPS 2024, CSSLab Toronto) is a single unified chess model trained on 169M Lichess games. Unlike Stockfish which finds the objectively best move, Maia2 predicts the probability distribution over moves that *a human at a given ELO* would actually play. It accepts `elo_self` and `elo_oppo` as inputs and outputs a probability for every legal move.

**Why this matters for Stage 1:** Currently we flag any move with `eval_drop > 50cp` as a mistake. This is engine-centric. Some of those 50cp drops are positions where *even strong players* would miss the best move — they're universally hard, not personal blindspots. And some of our most important blindspots might be moves where Maia2 at the user's ELO assigns near-zero probability to the best move — meaning humans at this level almost never see it, but the eval drop might only be 60cp.

**Concrete improvements:**

1. **Add Maia2 annotation pass (after Stockfish):**
   For each mistake event, query Maia2 with the position and `elo_self = user_elo`:
   - `maia2_prob_best` — probability Maia2 assigns to Stockfish's best move at the user's ELO
   - `maia2_prob_played` — probability Maia2 assigns to the move the user actually played

2. **Human surprise score:**
   ```python
   surprise = log(maia2_prob_best / max(maia2_prob_played, 1e-6))
   ```
   High surprise = this player did something unusual *even for their level*. Low surprise = this is a universally hard position. Only high-surprise mistakes are true personal blindspots.

3. **Improved mistake filter:**
   Filter out events where `maia2_prob_best < 0.15` — positions so hard that players at this ELO almost never find the best move. These are not personal blindspots; they're just hard chess. Removing them reduces noise in the cluster inputs.

4. **ELO-relative difficulty score:**
   ```python
   difficulty = 1 - maia2_prob_best   # at the user's ELO
   ```
   A position where Maia2 assigns 80% to the best move but the user still missed it is a strong blindspot signal. A position where Maia2 assigns 5% is just a hard position.

**Installation:** `pip install maia2` — weights available via `model.from_pretrained(type="rapid")` from the CSSLab GitHub repo.

---

### Stage 2 — Maia2 Embeddings Replace Hand-Crafted Features

**Current bottleneck:** The 111-dim hand-crafted features are interpretable but can't capture subtle positional patterns — the kind a 1400-player consistently misses but a 1700-player consistently finds. The geometry is right but the semantics are shallow.

**Maia2 position embeddings:**
Maia2's ResNet backbone converts the board into patch embeddings before the skill-aware attention module runs. These learned representations already encode what *human players notice* at different skill levels — they were trained to predict 9 billion human moves.

**Concrete improvements:**

1. **Extract Maia2 backbone embeddings:**
   Expose the penultimate layer activations (post-ResNet, pre-skill-attention) as position embeddings. These are ~256-dim vectors that encode the board in a human-perception space, not an engine-search space.

2. **Augment or replace the 111-dim feature vector:**
   - Option A (safer): concatenate Maia2 embeddings with the existing features → richer 367-dim vector, then UMAP
   - Option B (cleaner): replace hand-crafted features entirely with Maia2 embeddings
   Recommendation: start with Option A, ablate to see if the hand-crafted features add signal.

3. **Add Maia2 features to the context dimensions:**
   The current context block `[94:111]` has 17 dims. Add:
   - `maia2_surprise` (1-dim)
   - `maia2_prob_best` (1-dim)
   - `maia2_difficulty` (1-dim)
   These three directly encode *how human-typical this mistake was*, which is exactly what HDBSCAN should cluster on.

4. **ELO-conditioned cluster labelling:**
   Currently the LLM prompt just shows FEN + eval drop. Add `maia2_prob_best` to the prompt:
   > "At this player's rating (1400), Maia2 assigns only 3% probability to the correct move — players at this level almost always miss it."
   This gives Claude richer context for naming clusters.

---

### Stage 1 & 2 — Non-Maia2 Improvements

1. **Multi-move tactic detection:**
   Currently we flag the move where the eval dropped. But some blindspots are set-up failures — the player missed a tactic 2-3 moves before it crystallised. Track sequences: if move N is a mistake and move N-2 was the last "safe" moment to prevent it, annotate N-2 as the true mistake event.

2. **Better game phase detection:**
   Current heuristic (move <= 12 = opening) is crude. Improve: use combined non-pawn material count. Opening ends when both sides have castled and developed. Endgame starts when queens are off or total material < 20 points.

3. **More threat types:**
   Add: `discovered_attack`, `zwischenzug`, `deflection`, `overloaded_piece`. These are common tactical motifs that currently land in "other" and bloat the largest cluster.

4. **Time pressure segmentation:**
   Flag games with `time_remaining_ms < 10000` as time-scramble separately. Mistakes under time pressure may form spurious clusters — a player blundering in flag-hanging situations isn't the same blindspot as blundering in a slow game.

5. **Opening exclusion filter:**
   Option to exclude moves in known opening theory (use a small ECO database). Theory deviations are not blindspots; they're study gaps.

---

### Stage 3 — Puzzle Retrieval & Scheduling Improvements

1. **Maia2-based puzzle difficulty rating:**
   Re-score every indexed puzzle using `1 - maia2_prob_best(elo=user_elo)`. This replaces Lichess's engine-based rating with a *human difficulty score at the user's level*. A puzzle rated 1800 but trivially solved by Maia2 at 1400 should not be in the 1400 queue.

2. **Game re-sync loop:**
   After each session, fetch the user's games from the past 24 hours, run Stage 1 annotation, check if any new mistake events match an existing cluster centroid (cosine similarity > 0.85). If yes, call `srs.reset_cluster()` — the live-game blunder detection that resets mastery. This is the core retention mechanism no static platform can replicate.

3. **FastAPI backend:**
   Wrap the full pipeline in a FastAPI app:
   - `POST /ingest/{username}` — trigger Stage 1 as a Celery background job
   - `GET /clusters/{username}` — return blindspot profile
   - `GET /session/{username}?elo=1400&n=12` — build and return a drill session
   - `POST /attempt` — record a puzzle attempt and update SRS state

4. **Puzzle synthesis (Path B):**
   When the retrieval pool for a cluster is exhausted (user has seen all nearby puzzles), synthesise new positions using Maia2 as a verifier:
   - Start from a real game position near the cluster centroid
   - Apply random legal moves guided by Maia2 toward the target threat type
   - Stop when Stockfish confirms: eval_delta > 200cp for exactly one move
   - Validation: Maia2 at user's ELO gives the solution move < 20% probability (it's hard for them), Maia2 at +300 ELO gives it > 70% (it's findable for stronger players)

5. **React frontend:**
   - Onboarding: username input → background ingestion → blindspot reveal
   - Dashboard: ranked blindspot profile with urgency bars, "Drill now" per blindspot
   - Puzzle session: board with react-chessboard, context panel showing "From your game vs. X · 18 days ago · move 31 — you played Qe4, Rd8# was available"
   - No puzzle ratings shown — show "Your #1 blindspot, missed 23 times" instead

---

## Competitive Context

| | Pawnprint | Chess.com Learn | Lichess Puzzles | Chessable |
|---|---|---|---|---|
| Uses your real games | Yes | No | No | No |
| Detects personal blindspots | Yes | No | No | No |
| Spaced repetition | Yes (cluster-level) | No | No | Yes (opening lines) |
| Resets on live blunders | Yes (planned) | No | No | No |
| Requires login | No (username only) | Yes | Yes | Yes |
| Focus | Tactical blindspots | General improvement | Generic tactics | Openings |

The moat is the per-user blindspot graph. It gets richer with every game played and cannot be replicated by a fresh account.
