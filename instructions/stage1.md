# Stage 1 — Ingestion & Classification Pipeline

Complete reference for a developer picking up Stage 1 with no prior context.

---

## Overview

Stage 1 takes a chess player's username and platform, fetches their recent games, annotates every position with Stockfish, extracts the moves where they blundered, classifies what tactical theme they missed, and (optionally) filters out positions that are universally hard using Maia2.

The output is a list of `MistakeEvent` objects saved to `data/output/<username>_mistakes.json`.

---

## Data-flow diagram

```
  username + platform
        |
        v
  [1] Game Fetcher        ml/ingestion/fetcher.py
      Lichess / Chess.com APIs (no auth needed)
        |
        v
  [2] PGN Annotator       ml/ingestion/annotator.py
      Two-pass Stockfish:
        Pass A — depth 12 (fast screen, every move)
        Pass B — depth 18 (deep re-analysis, only flagged positions)
        |
        v
  [3] Mistake Extractor   ml/ingestion/mistake_extractor.py
      Filter: eval_drop >= 100cp, eval_before >= -300cp
      Enriches each event with game_phase + threat_type
        |
        v
  [4] HybridThreatClassifier   ml/classifier/hybrid_classifier.py
      Stage 0: eval_drop guard
      Stage 1: rule-based (threat_classifier.py)
      Stage 2: depth lookahead (Stockfish PV)
      Stage 3: LightGBM ML model
      Stage 4: uncertain — log, return "other"
        |
        v
  [5] Maia2 filter        ml/ingestion/maia_annotator.py
      Annotate with human-move probabilities.
      Discard positions where even strong humans miss it (prob_best < 0.04).
        |
        v
  [6] Save                data/output/<username>_mistakes.json
      List of MistakeEvent dicts (all fields serialised)
```

---

## Step 1 — Game Fetching

**File:** `ml/ingestion/fetcher.py`

**What:** Fetches PGN game data from the public Lichess or Chess.com APIs.
No API keys or OAuth required — both APIs are publicly accessible by username.

**Why:** We need the raw PGN strings to drive Stockfish annotation.
Clock data (if available) is also extracted for time-pressure analysis.

**Lichess endpoint:** `https://lichess.org/api/games/user/{username}?max={n}&clocks=true&perfType=rapid,blitz`

**Chess.com endpoint:** `https://api.chess.com/pub/player/{username}/games/{year}/{month}`

**Output:** List of normalised game dicts:
```python
{
    "game_id":        str,   # Lichess game ID or Chess.com UUID
    "pgn":            str,   # full PGN string
    "user_color":     str,   # "white" | "black"
    "white_username": str,
    "black_username": str,
    "played_at":      int,   # Unix timestamp (ms for Lichess, s for Chess.com)
    "time_control":   str,   # e.g. "600+5"
    "url":            str,   # game URL
}
```

**Edge cases:**
- Lichess returns NDJSON; Chess.com returns monthly JSON pages. Both are normalised to the same dict schema.
- Very old Chess.com games may lack clock data (`time_remaining_ms = None`).
- Lichess timestamps are in milliseconds; the pipeline normalises to seconds.

---

## Step 2 — Stockfish Annotation

**File:** `ml/ingestion/annotator.py`

**What:** Runs every position in a game through Stockfish and records the evaluation before and after the move that was played, plus the engine's best move.

**Why:** To identify positions where the eval dropped significantly (blunders) and to know what the engine preferred.

**Two-pass strategy:**
1. **Pass A (depth 12):** Annotate every position quickly. Flag positions where `eval_drop >= 30cp`.
2. **Pass B (depth 18):** Re-analyse only the flagged positions deeply. Overwrites the shallow annotation.

This gives full accuracy on the positions that matter while keeping the total annotation time reasonable (~1 second per game on a modern CPU).

**Key output per position — `PositionAnnotation`:**
```python
@dataclass
class PositionAnnotation:
    fen:               str    # board FEN after the opponent's last move
    move_played_uci:   str    # the move this player actually played
    move_played_san:   str
    best_move_uci:     str    # Stockfish's top choice
    eval_before_cp:    int    # centipawn eval before the move (from this player's POV)
    eval_after_cp:     int    # centipawn eval after the move
    eval_drop_cp:      int    # eval_before - eval_after (positive = blunder)
    is_white_move:     bool
    move_number:       int
    clock_remaining_ms: Optional[int]
```

**Performance:** ~30–60 games/minute on a laptop with a single Stockfish thread.

---

## Step 3 — Mistake Extraction

**File:** `ml/ingestion/mistake_extractor.py`

**What:** Filters the annotations to only positions where the user made a significant error, then enriches each with game phase and threat classification.

**Filters applied (in order):**
1. Only the target user's moves (skip opponent moves).
2. `eval_drop_cp >= MISTAKE_THRESHOLD_CP` (default: 100cp — blunders only).
3. `eval_before_cp >= -300` — skip already-losing positions to avoid noise.
4. Optionally skip opening moves (move_number <= 20) when `EXCLUDE_OPENING_MISTAKES=True`.

**Game phase detection:**
- Move 1–20 → `"opening"`
- Combined non-pawn material ≤ 15 → `"endgame"`
- Otherwise → `"middlegame"`

**MistakeEvent fields:**
```python
@dataclass
class MistakeEvent:
    game_id, user_id, fen, move_played_uci, move_played_san
    best_move_uci, eval_before_cp, eval_after_cp, eval_drop_cp
    threat_type          # from HybridThreatClassifier
    game_phase           # "opening" | "middlegame" | "endgame"
    time_remaining_ms    # from PGN clock comments
    move_number
    played_at_unix       # game timestamp
    cluster_id           # filled in Stage 2
    # Classification metadata
    classification_confidence  # float [0,1] — how sure the classifier was
    classification_method      # "rule_based"|"depth_lookahead"|"ml_model"|"ml_uncertain"|"skip"
    eval_drop_category         # "skip"|"inaccuracy"|"blunder"
    # Maia2 fields (populated separately)
    maia2_prob_best, maia2_prob_played, maia2_surprise, maia2_difficulty
```

---

## Step 4 — Hybrid Threat Classification

**File:** `ml/classifier/hybrid_classifier.py`

**What:** Classifies what tactical theme the player missed. Returns one of 14 threat types.

**Why a hybrid funnel?** Rule-based classification is deterministic and fast but only covers clear tactical motifs. The ML model handles ambiguous positions. The funnel minimises ML calls (expensive) while maximising accuracy.

### Threat types (14)

```
back_rank       fork            pin             skewer
hanging_piece   discovered_attack  removing_defender  deflection
trapped_piece   king_attack     passed_pawn     piece_activity
endgame_technique  other
```

### 4-Stage funnel

```
Stage 0 — eval_drop guard
  < 50cp  → method="skip", threat="other"  (not a real mistake)
  50–99cp → eval_drop_category="inaccuracy"
  >= 100cp → eval_drop_category="blunder"

Stage 1 — Rule-based  (ml/ingestion/threat_classifier.py)
  Always runs. Priority order (highest precision first):
    back_rank → fork → pin → skewer → hanging_piece → discovered_attack
    → removing_defender → deflection → trapped_piece → king_attack
    → passed_pawn → piece_activity → endgame_technique → other
  If result != "other" AND pv_length < 3:
    → method="rule_based", confidence=1.0, DONE

Stage 2 — Depth lookahead  (requires Stockfish engine)
  Plays out engine PV up to 4 half-moves.
  Stops early if position stops being forcing (> 10 legal moves).
  Classifies terminal position with rule-based classifier.
  If result != "other":
    → method="depth_lookahead", confidence=0.85, DONE

Stage 3 — LightGBM ML model  (ml/classifier/hybrid_classifier.py)
  Extracts 805-dim raw feature vector (bitboard + move + context).
  Gets class probabilities from LightGBM.
  Applies per-class confidence thresholds:
    removing_defender → 0.75
    deflection, trapped_piece → 0.65
    skewer → 0.60
    all others → 0.55
  If max probability >= threshold:
    → method="ml_model", confidence=max_prob, DONE

Stage 4 — Uncertain
  Logs (FEN, move, predicted class, confidence) for future fine-tuning.
  → method="ml_uncertain", threat="other"
```

**Expected healthy distribution:** rule_based ~65%, depth_lookahead ~15%, ml_model ~12%, ml_uncertain <5%.

**File:** `ml/ingestion/threat_classifier.py` — rule-based logic only (no ML).
**File:** `ml/classifier/features.py` — 805-dim feature extraction for the ML model.
**File:** `ml/classifier/label_map.py` — mapping between Lichess puzzle theme names and our threat types.

### ML model details

Trained on 2M Lichess puzzles (Lichess puzzle DB, `.zst` format).
16 Lichess-native classes used for training; mapped to 14 THREAT_TYPES at inference time.
Algorithm: LightGBM gradient-boosted trees.
Feature dim: 805 raw (768 bitboard + 20 move features + 12 context + 5 post-move).
No PCA — tree models handle high-dimensional sparse binary features natively.
Test accuracy: 63.5% on held-out 200K-example test set.
Strong classes: back_rank (F1=0.91), mate/king_attack (0.78), passed_pawn (0.73).

**Model artifacts:** `models/threat_lgbm.pkl`, `models/label_encoder.pkl`

---

## Step 5 — Maia2 Filter

**File:** `ml/ingestion/maia_annotator.py`, `ml/pipeline.py:_run_maia2_pass()`

**What:** Annotates each mistake event with the probability that a human player at the user's ELO would play the engine's best move. Filters out positions where `maia2_prob_best < 0.04` (universally hard).

**Why:** Some positions are objectively difficult for humans of all skill levels. Including them in the blindspot corpus would dilute the signal — they're not personal weaknesses, they're hard positions. Maia2 identifies these.

**Maia2 fields populated:**
- `maia2_prob_best` — probability of playing the engine's best move
- `maia2_prob_played` — probability of playing the move the user actually played
- `maia2_surprise` — log-odds of the engine's move relative to the user's move (higher = engine move more surprising)
- `maia2_difficulty` — 1 - maia2_prob_best (difficulty for a human of this ELO)

**Config:** `USE_MAIA2 = True`, `MAIA2_MIN_PROB_BEST = 0.04` in `ml/config.py`.

**Graceful fallback:** If `maia2` package is not installed, a warning is logged and all events are kept unfiltered.

**Install:** `pip install maia2` (requires PyTorch; installed in this project's venv).

---

## Step 6 — Persistence

**File:** `ml/pipeline.py:_save()`

**Output:** `data/output/<username>_mistakes.json`

Format: JSON array of `MistakeEvent` dicts. All fields are included. `None` values are serialised as `null`. The file is overwritten on each run.

**Game metadata** is saved separately to `data/output/<username>_game_meta.json` for the game history view in the frontend.

---

## Configuration

`ml/config.py`:

| Variable | Default | Meaning |
|---|---|---|
| `MISTAKE_THRESHOLD_CP` | 100 | Min centipawn drop to record as a mistake |
| `ANNOTATION_DEPTH_FAST` | 12 | Stockfish depth for initial screen |
| `ANNOTATION_DEPTH_FULL` | 18 | Stockfish depth for deep re-analysis |
| `USE_MAIA2` | True | Enable Maia2 human-probability filter |
| `MAIA2_MIN_PROB_BEST` | 0.04 | Filter threshold (discard if below this) |
| `EXCLUDE_OPENING_MISTAKES` | False | Skip mistakes on moves 1–20 |
| `STOCKFISH_PATH` | auto-discovered | Path to Stockfish binary |

---

## Running Stage 1

```bash
# Full pipeline (programmatic)
from ml.pipeline import run_ingestion
mistakes = run_ingestion("ShahuPatil07", platform="lichess", min_games=80)

# Via the backend API (triggers background job)
POST /api/ingest  {"username": "ShahuPatil07", "platform": "lichess", "min_games": 80}

# CLI analysis script
python scripts/run_analysis.py ShahuPatil07 --platform lichess --games 80

# Re-classify existing mistakes with updated classifier (no re-annotation needed)
python -m ml.clustering.reclassify ShahuPatil07
```

---

## Key files

| File | Role |
|---|---|
| `ml/pipeline.py` | Orchestrates all 4 sub-steps |
| `ml/ingestion/fetcher.py` | Lichess / Chess.com API clients |
| `ml/ingestion/annotator.py` | Two-pass Stockfish annotation |
| `ml/ingestion/mistake_extractor.py` | Filter + enrich annotations |
| `ml/ingestion/threat_classifier.py` | Rule-based detector (14 threat types) |
| `ml/classifier/hybrid_classifier.py` | 4-stage HybridThreatClassifier |
| `ml/classifier/features.py` | 805-dim feature extraction for ML |
| `ml/classifier/label_map.py` | Lichess theme → THREAT_TYPE mapping |
| `ml/classifier/hybrid_classifier.py` | ML model singleton + confidence thresholds |
| `ml/ingestion/maia_annotator.py` | Maia2 human-probability annotation |
| `ml/config.py` | All tuneable constants |
| `models/threat_lgbm.pkl` | Trained LightGBM threat classifier |
| `models/label_encoder.pkl` | Encodes/decodes ML class indices |
| `data/output/<user>_mistakes.json` | Stage 1 output |
| `scripts/verify_category_alignment.py` | Asserts rule + ML labels are in sync |
| `tests/test_hybrid_classifier.py` | Unit tests for known positions |
