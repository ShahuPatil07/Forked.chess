# Threat classifier — ML pivot instructions

## Context

We have a working rule-based threat classifier in `threat_classifier.py` that
classifies chess mistakes into 18 categories. It works well for simple one-move
tactics but fails on:

1. Deferred tactics — hanging piece only visible after 2-3 forcing moves
2. Sacrificial combinations — e.g. Greek Gift where the payoff is 5 moves away
3. Quiet/preparatory moves — no immediate threat, but sets up structure
4. Strategic positional mistakes — weak king after g6, bad pawn structure, etc.

The fix: train a lightweight ML classifier on the Lichess puzzle database, which
has 50M+ puzzles each tagged with one or more tactical themes. Use the trained
model as a fallback when the rule-based system returns `"other"` or when
Stockfish's PV is longer than 2 moves (indicating a multi-move combination).

The rule-based classifier stays. The model replaces only the fallback branch.

---

## Threat categories to classify (18 total)

These must be the model's output classes. They match `THREAT_TYPES` in
`threat_classifier.py` exactly:

```
deflection, overloaded_piece, zwischenzug, back_rank, fork, skewer,
hanging_piece, discovered_attack, removing_defender, pin, trapped_piece,
king_attack, passed_pawn, missed_threat, piece_activity,
endgame_technique, pawn_structure, other
```

The Lichess puzzle DB uses different theme names. The mapping is at the bottom
of this file.

---

## What to build

### 1. Data pipeline — `scripts/build_training_data.py`

Download and process the Lichess puzzle database into a training dataset.

**Source:** `https://database.lichess.org/lichess_db_puzzle.csv.zst`
This is a ~700MB compressed CSV. Do NOT commit it to the repo. Download it
to `data/raw/` which is gitignored.

**CSV columns we need:**
- `FEN` — position before the puzzle move
- `Moves` — space-separated UCI moves (first move is opponent's, rest are solution)
- `Themes` — space-separated Lichess theme tags

**Processing steps:**

```python
# Pseudocode for the pipeline

for each row in csv:
    fen = row["FEN"]
    moves = row["Moves"].split()
    themes = row["Themes"].split()
    
    # The puzzle position is AFTER the first move (opponent's move)
    # Apply the first move to get the actual puzzle FEN
    board = chess.Board(fen)
    board.push(chess.Move.from_uci(moves[0]))
    puzzle_fen = board.fen()
    
    # The solution is moves[1] — the first move the solver plays
    solution_move = moves[1]
    
    # Map Lichess themes → our THREAT_TYPES
    our_label = map_lichess_themes_to_threat_type(themes)
    if our_label is None:
        continue  # skip if no mapping found
    
    # Extract features from the position
    features = extract_features(puzzle_fen, solution_move)
    
    yield {"fen": puzzle_fen, "move": solution_move, 
           "label": our_label, "features": features}
```

Target dataset size: 500K examples minimum, 2M preferred. The full DB has
~3M puzzles so filtering will be needed — keep only puzzles with a clean
single-theme mapping (no ambiguous multi-theme cases for training).

Split: 80% train / 10% val / 10% test. Stratify by label to handle class
imbalance (fork and hanging_piece will dominate).

Save to `data/processed/train.parquet`, `val.parquet`, `test.parquet`.

---

### 2. Feature extraction — `src/classifier/features.py`

Each training example is a position + solution move. Extract a fixed-length
feature vector that captures everything a model needs to classify the tactic.

**Feature vector structure (target ~200 dimensions):**

```python
def extract_features(fen: str, solution_move_uci: str) -> np.ndarray:
    """
    Returns a ~200-dim float32 feature vector for one (position, move) pair.
    """
    board = chess.Board(fen)
    move = chess.Move.from_uci(solution_move_uci)
    
    features = []
    
    # --- Board encoding (768-dim bitboard, then compress) ---
    # Standard 8x8x12 binary tensor: 12 piece types × 64 squares
    # Flatten to 768 then PCA/hash to 64 dims during preprocessing
    bitboard = encode_bitboard(board)  # shape (768,)
    features.append(bitboard)
    
    # --- Move features (32-dim) ---
    move_feats = [
        chess.square_file(move.from_square) / 7,  # from file 0-1
        chess.square_rank(move.from_square) / 7,  # from rank 0-1
        chess.square_file(move.to_square) / 7,    # to file 0-1
        chess.square_rank(move.to_square) / 7,    # to rank 0-1
        float(board.is_capture(move)),
        float(board.gives_check(move)),
        float(move.promotion is not None),
        # piece type one-hot (6 dims)
        *one_hot(board.piece_at(move.from_square).piece_type - 1, 6),
        # captured piece type one-hot (7 dims: 6 types + no capture)
        *one_hot(
            board.piece_at(move.to_square).piece_type - 1 
            if board.is_capture(move) else 6, 7
        ),
    ]
    features.append(move_feats)
    
    # --- Position context (32-dim) ---
    context = [
        # material balance
        sum_material(board, chess.WHITE) - sum_material(board, chess.BLACK),
        # game phase (0=opening, 0.5=middlegame, 1=endgame)
        estimate_game_phase(board),
        # king safety proxy: pawn shield count
        count_pawn_shield(board, chess.WHITE),
        count_pawn_shield(board, chess.BLACK),
        # mobility proxy: rough count of legal moves
        board.legal_moves.count() / 40.0,
        # in check?
        float(board.is_check()),
        # doubled/isolated pawn counts
        count_doubled_pawns(board, chess.WHITE),
        count_doubled_pawns(board, chess.BLACK),
        count_isolated_pawns(board, chess.WHITE),
        count_isolated_pawns(board, chess.BLACK),
        # back rank weakness
        float(has_back_rank_weakness(board, chess.WHITE)),
        float(has_back_rank_weakness(board, chess.BLACK)),
    ]
    features.append(context)
    
    # --- Post-move consequences (32-dim) ---
    # Apply the move and re-examine
    after = board.copy()
    after.push(move)
    
    consequences = [
        float(after.is_check()),
        float(after.is_checkmate()),
        # material change after the move
        (sum_material(after, board.turn) - sum_material(board, board.turn)) / 9.0,
        # how many opponent pieces are now attacked
        count_attacked_pieces(after, not board.turn) / 8.0,
        # how many opponent pieces are now hanging
        count_hanging_pieces(after, not board.turn) / 8.0,
    ]
    features.append(consequences)
    
    return np.concatenate([np.array(f, dtype=np.float32).flatten() 
                           for f in features])
```

Important: the bitboard (768 dims) dominates. During the data pipeline step,
fit a PCA on the training set bitboards and reduce to 64 dims. Save the PCA
object to `models/pca_bitboard.pkl`. Apply it at inference time.

Final feature vector after PCA: ~160 dims.

---

### 3. Model — `src/classifier/model.py`

Two model options. Build both, benchmark, ship the better one.

**Option A — Gradient Boosted Trees (XGBoost/LightGBM)**

Best for tabular features. Fast to train, fast to infer, small on disk, no
GPU needed, deployable anywhere.

```python
import lightgbm as lgb

model = lgb.LGBMClassifier(
    n_estimators=500,
    learning_rate=0.05,
    num_leaves=127,
    max_depth=8,
    class_weight="balanced",  # handle class imbalance
    n_jobs=-1,
    random_state=42,
)
model.fit(
    X_train, y_train,
    eval_set=[(X_val, y_val)],
    callbacks=[lgb.early_stopping(50), lgb.log_evaluation(50)]
)
```

Expected: ~75-82% accuracy on the 18-class problem. Training time: ~20 min
on CPU. Model size: ~50MB.

**Option B — Small MLP (PyTorch)**

Better at capturing non-linear feature interactions. Slower to train but
still fast at inference.

```python
import torch.nn as nn

class ThreatClassifier(nn.Module):
    def __init__(self, input_dim=160, num_classes=18):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(input_dim, 512),
            nn.LayerNorm(512),
            nn.GELU(),
            nn.Dropout(0.2),
            nn.Linear(512, 256),
            nn.LayerNorm(256),
            nn.GELU(),
            nn.Dropout(0.2),
            nn.Linear(256, 128),
            nn.GELU(),
            nn.Linear(128, num_classes),
        )
    
    def forward(self, x):
        return self.net(x)
```

Training: Adam lr=1e-3, cosine annealing, batch size 1024, 20 epochs.
Expected: ~80-87% accuracy. Training time: ~1 hour on CPU, ~10 min on GPU.
Model size: ~5MB after export to ONNX.

**Recommendation:** start with LightGBM (Option A) — zero PyTorch dependency,
ships faster, accuracy is close enough for MVP. Swap to MLP later if accuracy
plateau is a problem.

---

### 4. Inference integration — `src/classifier/hybrid_classifier.py`

This is the file that replaces the direct `classify_threat()` call in the
annotation pipeline. It runs rule-based first, falls back to model.

```python
import chess
import chess.engine
import joblib
from threat_classifier import classify_threat, THREAT_TYPES
from features import extract_features

class HybridThreatClassifier:
    """
    Stage 1: rule-based (fast, free, deterministic)
    Stage 2: depth-3 lookahead check
    Stage 3: ML model fallback for multi-move combinations
    """
    
    def __init__(self, model_path: str, pca_path: str, engine_path: str):
        self.model = joblib.load(model_path)          # LightGBM model
        self.pca   = joblib.load(pca_path)            # bitboard PCA
        self.engine = chess.engine.SimpleEngine.popen_uci(engine_path)
    
    def classify(
        self, 
        fen: str, 
        best_move_uci: str, 
        move_played_uci: str = ""
    ) -> tuple[str, str]:
        """
        Returns (threat_type, method) where method is one of:
        "rule_based" | "depth_lookahead" | "ml_model"
        """
        
        # --- Stage 1: rule-based ---
        rule_result = classify_threat(fen, best_move_uci, move_played_uci)
        
        if rule_result != "other":
            return rule_result, "rule_based"
        
        # --- Stage 2: check if this is a multi-move combination ---
        board = chess.Board(fen)
        info = self.engine.analyse(
            board, 
            chess.engine.Limit(depth=16),
            multipv=1
        )
        pv = info.get("pv", [])
        
        # If the PV is 1 move, rule-based already had its shot — go to model
        # If the PV is 2+ moves, the idea unfolds over time — use lookahead
        if len(pv) >= 2:
            lookahead_result = self._classify_via_lookahead(board, pv)
            if lookahead_result != "other":
                return lookahead_result, "depth_lookahead"
        
        # --- Stage 3: ML model ---
        ml_result = self._classify_via_model(fen, best_move_uci)
        return ml_result, "ml_model"
    
    def _classify_via_lookahead(
        self, 
        board: chess.Board, 
        pv: list
    ) -> str:
        """
        Play out the forcing line (up to 4 half-moves) and classify
        the terminal position with the rule-based classifier.
        """
        temp = board.copy()
        played = []
        
        for move in pv[:4]:
            if move not in temp.legal_moves:
                break
            temp.push(move)
            played.append(move)
            
            # Stop early if position is clearly non-forcing
            if not temp.is_check() and len(list(temp.legal_moves)) > 10:
                if len(played) >= 2:
                    break
        
        if not played:
            return "other"
        
        # Classify the terminal position
        if temp.is_checkmate():
            return "king_attack"
        
        # Try rule-based on the terminal position with the last move
        terminal_move = played[-1].uci()
        # Step back one move to get the board before the last move
        temp2 = board.copy()
        for m in played[:-1]:
            temp2.push(m)
        
        result = classify_threat(temp2.fen(), terminal_move, "")
        return result  # may still be "other" — that's fine, ML handles it
    
    def _classify_via_model(self, fen: str, move_uci: str) -> str:
        """Run the ML classifier."""
        try:
            features = extract_features(fen, move_uci, pca=self.pca)
            features = features.reshape(1, -1)
            pred = self.model.predict(features)[0]
            return THREAT_TYPES[pred]
        except Exception:
            return "other"
    
    def close(self):
        self.engine.quit()
```

Usage in the annotation pipeline — replace the existing `classify_threat()`
call with:

```python
# In annotate.py or wherever mistakes are processed
classifier = HybridThreatClassifier(
    model_path="models/threat_lgbm.pkl",
    pca_path="models/pca_bitboard.pkl",
    engine_path="stockfish"
)

threat_type, method = classifier.classify(
    fen=mistake.fen,
    best_move_uci=mistake.best_move,
    move_played_uci=mistake.move_played
)

# Log the method for monitoring — track what % falls through to ML
mistake.threat_type = threat_type
mistake.classification_method = method  # add this column to MistakeEvent
```

---

### 5. Training script — `scripts/train_classifier.py`

```bash
# Full pipeline, run in order:
python scripts/build_training_data.py   # ~2 hours, produces parquet files
python scripts/train_classifier.py      # ~20 min for LightGBM
python scripts/evaluate_classifier.py  # prints per-class accuracy
```

The training script should:
1. Load `data/processed/train.parquet` and `val.parquet`
2. Apply PCA to bitboard features (fit on train only, transform both)
3. Save PCA to `models/pca_bitboard.pkl`
4. Train LightGBM with early stopping on val set
5. Save model to `models/threat_lgbm.pkl`
6. Print classification report broken down by threat type

Minimum acceptable per-class accuracy: 70%. Classes below 70% need
investigation — likely a label mapping issue or too few training examples.

---

### 6. Evaluation script — `scripts/evaluate_classifier.py`

Print:
- Overall accuracy (all 18 classes)
- Per-class precision, recall, F1
- Confusion matrix saved as `results/confusion_matrix.png`
- Breakdown: what % of examples were classified by rule_based vs
  depth_lookahead vs ml_model
- Examples of misclassified positions (10 per class) saved to
  `results/misclassified_examples.json` — FEN + predicted + true label

The confusion matrix is the most important output. Expect fork/hanging_piece
to be confused with each other. Expect zwischenzug to have low recall (rare
in training data). Flag any class with F1 below 0.60 for review.

---

## Lichess theme → our THREAT_TYPES mapping

The Lichess puzzle DB uses these theme names. Map them to our 18 classes:

```python
LICHESS_TO_THREAT = {
    # Direct mappings
    "fork":                "fork",
    "pin":                 "pin",
    "skewer":              "skewer",
    "discoveredAttack":    "discovered_attack",
    "backRankMate":        "back_rank",
    "backRank":            "back_rank",
    "hangingPiece":        "hanging_piece",
    "trappedPiece":        "trapped_piece",
    "deflection":          "deflection",
    "overloadedPiece":     "overloaded_piece",
    "zwischenzug":         "zwischenzug",
    "kingsideAttack":      "king_attack",
    "queensideAttack":     "king_attack",
    "attackingF2F7":       "king_attack",
    "mateIn1":             "king_attack",
    "mateIn2":             "king_attack",
    "mateIn3":             "king_attack",
    "mateIn4":             "king_attack",
    "mateIn5":             "king_attack",
    "mate":                "king_attack",
    "passingPawn":         "passed_pawn",
    "promotion":           "passed_pawn",
    "underPromotion":      "passed_pawn",
    "advancedPawn":        "passed_pawn",
    "endgame":             "endgame_technique",
    "rookEndgame":         "endgame_technique",
    "queenEndgame":        "endgame_technique",
    "pawnEndgame":         "endgame_technique",
    "bishopEndgame":       "endgame_technique",
    "knightEndgame":       "endgame_technique",
    "quietMove":           "piece_activity",
    "zugzwang":            "endgame_technique",
    "sacrifice":           "removing_defender",   # broad but best fit
    "clearance":           "piece_activity",
    "interference":        "deflection",          # closest match
    "xRayAttack":          "discovered_attack",
}

def map_lichess_themes_to_threat_type(themes: list[str]) -> str | None:
    """
    Given a list of Lichess themes for one puzzle, return our threat type.
    Returns None if no clean mapping found (skip this puzzle for training).
    """
    mapped = []
    for theme in themes:
        if theme in LICHESS_TO_THREAT:
            mapped.append(LICHESS_TO_THREAT[theme])
    
    if not mapped:
        return None
    
    # If all mapped themes agree → clean label
    if len(set(mapped)) == 1:
        return mapped[0]
    
    # If themes map to 2+ different classes → skip (ambiguous)
    # Exception: king_attack + anything else → king_attack wins
    if "king_attack" in mapped:
        return "king_attack"
    
    return None  # skip ambiguous examples
```

---

## File structure after this work is done

```
forked/
├── data/
│   ├── raw/                          # gitignored — large files
│   │   └── lichess_db_puzzle.csv     # downloaded, not committed
│   └── processed/
│       ├── train.parquet
│       ├── val.parquet
│       └── test.parquet
├── models/
│   ├── pca_bitboard.pkl              # fitted PCA transformer
│   └── threat_lgbm.pkl               # trained LightGBM classifier
├── results/
│   ├── confusion_matrix.png
│   └── misclassified_examples.json
├── scripts/
│   ├── build_training_data.py
│   ├── train_classifier.py
│   └── evaluate_classifier.py
└── src/
    └── classifier/
        ├── threat_classifier.py      # existing rule-based (unchanged)
        ├── features.py               # new — feature extraction
        ├── hybrid_classifier.py      # new — rule + lookahead + model
        └── label_map.py              # new — Lichess theme mapping
```

---

## What NOT to change

- `threat_classifier.py` — do not modify the existing rule-based code. The
  ML model is a fallback, not a replacement.
- The `THREAT_TYPES` tuple — class names and order are frozen. The model's
  integer outputs map to this tuple by index.
- The `MistakeEvent` database schema — only add the new
  `classification_method` column, don't rename existing columns.

---

## Definition of done

- [ ] `build_training_data.py` runs end-to-end and produces balanced parquet
      files with at least 20K examples per class
- [ ] LightGBM model achieves >75% overall accuracy on the test set
- [ ] No class has F1 below 0.60
- [ ] `HybridThreatClassifier` passes unit tests for known positions
      (see `tests/test_hybrid_classifier.py`)
- [ ] The `"other"` fallback rate on real user mistake data drops below 5%
      (was ~30% with rule-based only)
- [ ] Inference time per position < 50ms on CPU (including feature extraction)
