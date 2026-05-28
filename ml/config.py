from pathlib import Path
import os

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"
STOCKFISH_DIR = DATA_DIR / "stockfish"

# Auto-discover the Stockfish binary (works cross-platform)
_candidates = (
    list(STOCKFISH_DIR.glob("stockfish*.exe"))   # Windows
    + list(STOCKFISH_DIR.glob("stockfish"))       # Linux / macOS
    + list(STOCKFISH_DIR.glob("stockfish-*"))     # versioned builds
)
STOCKFISH_PATH: Path = (
    Path(os.environ["STOCKFISH_PATH"])
    if "STOCKFISH_PATH" in os.environ
    else (_candidates[0] if _candidates else STOCKFISH_DIR / "stockfish.exe")
)

# Annotation depths
ANNOTATION_DEPTH_FAST = 12     # pre-screening pass
ANNOTATION_DEPTH_FULL = 18     # deep re-analysis pass

# Eval-drop thresholds (centipawns)
FAST_THRESHOLD_CP = 30         # flag for deep re-analysis if drop >= this
MISTAKE_THRESHOLD_CP = 100     # record as a mistake event if drop >= this (blunders only)

# Maia2 human-move probability filter
# Positions where Maia2 rarely plays the engine's best move are "universally hard"
# and are not personal blindspots — filter them out to reduce noise.
USE_MAIA2 = True
MAIA2_MIN_PROB_BEST = 0.04     # discard events where maia2_prob_best < this

# Opening filter — moves 1-20 are classified as opening phase (many lines extend through move 18-20)
EXCLUDE_OPENING_MISTAKES = False   # set True (or use --exclude-opening CLI flag)

# API endpoints
CHESS_COM_API_BASE = "https://api.chess.com/pub/player"
LICHESS_API_BASE   = "https://lichess.org/api"

REQUEST_HEADERS = {
    "User-Agent": "Forked/0.1 (github.com/ShahuPatil07/Forked; shahuwncc@gmail.com)"
}
