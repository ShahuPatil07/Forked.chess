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
MISTAKE_THRESHOLD_CP = 50      # record as a mistake event if drop >= this

# API endpoints
CHESS_COM_API_BASE = "https://api.chess.com/pub/player"
LICHESS_API_BASE   = "https://lichess.org/api"

REQUEST_HEADERS = {
    "User-Agent": "Pawnprint/0.1 (github.com/pawnprint; shahuwncc@gmail.com)"
}
