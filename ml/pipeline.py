"""
End-to-end ingestion pipeline: fetch -> annotate -> extract mistakes -> Maia2 filter.

Usage (programmatic):
    from ml.pipeline import run_ingestion
    mistakes = run_ingestion("MagnusCarlsen", platform="chesscom", min_games=200)

The pipeline saves results to data/output/<username>_mistakes.json and returns
the list of MistakeEvent objects for downstream processing.
"""
import json
import logging
import statistics
from dataclasses import asdict
from pathlib import Path
from typing import Optional

import chess.engine
from tqdm import tqdm

from ml.config import DATA_DIR, STOCKFISH_PATH, USE_MAIA2, MAIA2_MIN_PROB_BEST
from ml.ingestion.annotator import annotate_game
from ml.ingestion.fetcher import (
    fetch_chesscom_games,
    fetch_lichess_games,
    parse_chesscom_game,
    parse_lichess_game,
)
from ml.ingestion.mistake_extractor import MistakeEvent, extract_mistakes

log = logging.getLogger(__name__)

OUTPUT_DIR = DATA_DIR / "output"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _fetch_and_parse(username: str, platform: str, min_games: int) -> list[dict]:
    """Return a list of normalised game dicts (each has 'pgn', 'user_color', etc.)."""
    if platform == "chesscom":
        raw = fetch_chesscom_games(username, min_games=min_games)
        parsed = [parse_chesscom_game(g, username) for g in raw]
    elif platform == "lichess":
        raw = fetch_lichess_games(username, min_games=min_games)
        parsed = [parse_lichess_game(g, username) for g in raw]
    else:
        raise ValueError(f"Unknown platform '{platform}'. Choose 'chesscom' or 'lichess'.")

    return [g for g in parsed if g is not None]


def _annotate_batch(
    games: list[dict],
    engine: chess.engine.SimpleEngine,
    exclude_opening: bool = False,
    progress_callback=None,
    classifier=None,   # Optional[HybridThreatClassifier]
) -> list[MistakeEvent]:
    """Annotate a batch of games and return all mistake events."""
    all_mistakes: list[MistakeEvent] = []
    skipped = 0
    total = len(games)
    iterable = games if progress_callback else tqdm(games, desc="Annotating games", unit="game")

    for idx, game in enumerate(iterable):
        try:
            annotations = annotate_game(game["pgn"], engine)
        except Exception as exc:
            log.warning("Skipped game %s: %s", game.get("game_id", "?"), exc)
            skipped += 1
            if progress_callback:
                progress_callback(idx + 1, total, len(all_mistakes))
            continue

        raw_ts = game.get("played_at")
        played_at_unix = int(raw_ts // 1000) if raw_ts and raw_ts > 1e10 else (int(raw_ts) if raw_ts else None)

        mistakes = extract_mistakes(
            annotations,
            game_id=game["game_id"],
            user_id=game.get("white_username" if game["user_color"] == "white" else "black_username", ""),
            user_color=game["user_color"],
            played_at_unix=played_at_unix,
            exclude_opening=exclude_opening,
            classifier=classifier,
        )
        all_mistakes.extend(mistakes)

        if progress_callback:
            progress_callback(idx + 1, total, len(all_mistakes))

    if skipped:
        log.warning("Skipped %d games due to parse/engine errors.", skipped)

    return all_mistakes


def _run_maia2_pass(
    mistakes: list[MistakeEvent],
    min_prob_best: float = MAIA2_MIN_PROB_BEST,
) -> tuple[list[MistakeEvent], dict]:
    """
    Annotate mistakes with Maia2 probabilities, then filter out events where
    the engine's best move has very low human probability (universally hard positions).

    Returns (filtered_mistakes, stats_dict).
    Falls back gracefully if maia2 is not installed.
    """
    stats = {
        "maia2_available": False,
        "before": len(mistakes),
        "after":  len(mistakes),
        "filtered": 0,
        "mean_surprise": None,
        "median_surprise": None,
    }

    if not USE_MAIA2:
        return mistakes, stats

    try:
        from ml.ingestion.maia_annotator import MaiaAnnotator
        annotator = MaiaAnnotator()
    except ImportError:
        log.warning("maia2 not installed — skipping Maia2 filter (pip install maia2)")
        return mistakes, stats
    except Exception as exc:
        log.warning("Maia2 model failed to load: %s — skipping filter", exc)
        return mistakes, stats

    stats["maia2_available"] = True
    print(f"      Running Maia2 annotation on {len(mistakes)} events...")
    annotator.annotate_batch(mistakes)

    # Filter: remove events where the best move was universally hard
    filtered = [
        m for m in mistakes
        if m.maia2_prob_best is None or m.maia2_prob_best >= min_prob_best
    ]
    n_filtered = len(mistakes) - len(filtered)

    # Collect surprise statistics from remaining events
    surprises = [m.maia2_surprise for m in filtered if m.maia2_surprise is not None]
    if surprises:
        stats["mean_surprise"]   = statistics.mean(surprises)
        stats["median_surprise"] = statistics.median(surprises)

    stats["after"]    = len(filtered)
    stats["filtered"] = n_filtered

    return filtered, stats


def _save(mistakes: list[MistakeEvent], username: str, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"{username}_mistakes.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump([asdict(m) for m in mistakes], fh, indent=2, default=str)
    return path


def _save_game_meta(games: list[dict], username: str, output_dir: Path) -> None:
    meta: dict = {}
    for g in games:
        gid = g.get("game_id", "")
        if not gid:
            continue
        white = g.get("white_username", "")
        black = g.get("black_username", "")
        user_color = g.get("user_color", "white")
        opponent = black if user_color == "white" else white
        meta[gid] = {
            "white": white,
            "black": black,
            "user_color": user_color,
            "opponent": opponent,
            "url": g.get("url", ""),
            "time_control": g.get("time_control", ""),
        }
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(output_dir / f"{username}_game_meta.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def run_ingestion(
    username: str,
    platform:  str = "chesscom",
    min_games: int = 200,
    output_dir: Optional[Path] = None,
    stockfish_path: Optional[Path] = None,
    exclude_opening: bool = False,
    progress_callback=None,  # callable(current, total, mistakes_so_far) | None
) -> list[MistakeEvent]:
    """
    Full Stage-1 pipeline for one user.

    Returns a list of MistakeEvent objects and saves them to JSON.
    Optionally excludes opening mistakes (moves 1-12) with exclude_opening=True.
    """
    if output_dir is None:
        output_dir = OUTPUT_DIR

    sf_path = stockfish_path or STOCKFISH_PATH
    if not sf_path.exists():
        raise FileNotFoundError(
            f"Stockfish binary not found at {sf_path}.\n"
            "Run: python scripts/setup_stockfish.py"
        )

    print(f"\n{'='*60}")
    print(f"  Forked ingestion pipeline")
    print(f"  User: {username}  |  Platform: {platform}  |  Min games: {min_games}")
    if exclude_opening:
        print(f"  Opening exclusion: ON (moves 1-12 skipped)")
    print(f"{'='*60}\n")

    # ── 1. Fetch games ──────────────────────────────────────────────────────
    print("[1/4] Fetching games...")
    games = _fetch_and_parse(username, platform, min_games)
    print(f"      -> {len(games)} games retrieved\n")

    if not games:
        print("No games found. Check the username and platform.")
        return []

    _save_game_meta(games, username, output_dir)

    # ── 2. Annotate & extract mistakes ─────────────────────────────────────
    print(f"[2/4] Annotating with Stockfish ({sf_path.name})...")
    print(f"      Two-pass strategy: depth-12 screen -> depth-18 on mistakes only\n")

    # Build HybridThreatClassifier once for the whole batch (loads ML model into RAM)
    from ml.classifier.hybrid_classifier import HybridThreatClassifier
    _root = Path(__file__).parent.parent
    _model_path = _root / "models" / "threat_lgbm.pkl"
    classifier = HybridThreatClassifier(model_path=_model_path) if _model_path.exists() else None
    if classifier:
        print("      HybridThreatClassifier loaded (rule + ML fallback).")
    else:
        print("      No trained model found — rule-based classification only.")

    with chess.engine.SimpleEngine.popen_uci(str(sf_path)) as engine:
        engine.configure({"Threads": 1, "Hash": 128})
        mistakes = _annotate_batch(
            games, engine,
            exclude_opening=exclude_opening,
            progress_callback=progress_callback,
            classifier=classifier,
        )

    if classifier:
        dist = classifier.get_method_distribution()
        total_classified = sum(v for k, v in dist.items() if k != "skip")
        if total_classified:
            print("\n      Classification method breakdown:")
            for method, cnt in dist.items():
                if cnt:
                    pct = cnt / max(1, sum(dist.values())) * 100
                    print(f"        {method:<20} {cnt:>4}  ({pct:.1f}%)")

    print(f"\n      -> {len(mistakes)} mistake events extracted")

    # ── 3. Maia2 annotation + filter ────────────────────────────────────────
    print(f"\n[3/4] Maia2 human-probability filter...")
    mistakes, maia_stats = _run_maia2_pass(mistakes)

    if maia_stats["maia2_available"]:
        pct = maia_stats["filtered"] / max(1, maia_stats["before"]) * 100
        print(f"      Filtered {maia_stats['filtered']} universally-hard events "
              f"({pct:.1f}% of {maia_stats['before']})")
        print(f"      Remaining: {maia_stats['after']} personal blindspot candidates")
        if maia_stats["mean_surprise"] is not None:
            print(f"      Mean maia2_surprise: {maia_stats['mean_surprise']:.2f}  "
                  f"| Median: {maia_stats['median_surprise']:.2f}")
    else:
        print("      Maia2 not available — all events kept (install with: pip install maia2)")

    # ── 4. Save & summarise ────────────────────────────────────────────────
    path = _save(mistakes, username, output_dir)
    print(f"\n[4/4] Saved to {path}\n")

    if mistakes:
        from collections import Counter
        tc = Counter(m.threat_type  for m in mistakes)
        pc = Counter(m.game_phase   for m in mistakes)
        total = len(mistakes)

        print("  Threat breakdown:")
        for t, n in tc.most_common():
            bar = "#" * min(25, int(n / total * 50))
            print(f"    {t:<22}  {n:>4}  ({n/total*100:4.1f}%)  {bar}")

        print("  Phase breakdown:")
        for p, n in pc.most_common():
            print(f"    {p:<20}  {n:>4}  ({n/total*100:4.1f}%)")

    print()
    return mistakes
