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
MISTAKE_THRESHOLD_CP = 100     # legacy cp threshold (v2 uses win-probability: ml/ingestion/winprob.py)

# Which games feed the blindspot profile: rated, standard, these time classes.
GAME_TIME_CLASSES: tuple[str, ...] = tuple(
    t for t in os.environ.get("FORKED_TIME_CLASSES", "rapid").split(",") if t)

# Maia2 human-move model. v2 uses it as a soft "personalness" weight (probability
# a player at your rating avoids the mistake), not a hard filter.
USE_MAIA2 = True
MAIA2_MIN_PROB_BEST = 0.04     # legacy hard filter (only used by ml/eval/legacy.py)

# Opening filter — moves 1-20 are classified as opening phase (many lines extend through move 18-20)
EXCLUDE_OPENING_MISTAKES = False   # set True (or use --exclude-opening CLI flag)

# API endpoints
CHESS_COM_API_BASE = "https://api.chess.com/pub/player"
LICHESS_API_BASE   = "https://lichess.org/api"

REQUEST_HEADERS = {
    "User-Agent": "Forked/0.1 (github.com/ShahuPatil07/Forked; shahuwncc@gmail.com)"
}
