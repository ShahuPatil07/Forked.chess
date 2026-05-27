"""
End-to-end ingestion pipeline: fetch -> annotate -> extract mistakes.

Usage (programmatic):
    from ml.pipeline import run_ingestion
    mistakes = run_ingestion("MagnusCarlsen", platform="chesscom", min_games=200)

The pipeline saves results to data/output/<username>_mistakes.json and returns
the list of MistakeEvent objects for downstream processing.
"""
import json
import logging
from dataclasses import asdict
from pathlib import Path
from typing import Optional

import chess.engine
from tqdm import tqdm

from ml.config import DATA_DIR, STOCKFISH_PATH
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
    progress_callback=None,  # callable(current: int, total: int, mistakes: int) | None
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

        # Normalise timestamp: Lichess uses milliseconds, Chess.com uses seconds
        raw_ts = game.get("played_at")
        played_at_unix = int(raw_ts // 1000) if raw_ts and raw_ts > 1e10 else (int(raw_ts) if raw_ts else None)

        mistakes = extract_mistakes(
            annotations,
            game_id=game["game_id"],
            user_id=game.get("white_username" if game["user_color"] == "white" else "black_username", ""),
            user_color=game["user_color"],
            played_at_unix=played_at_unix,
        )
        all_mistakes.extend(mistakes)

        if progress_callback:
            progress_callback(idx + 1, total, len(all_mistakes))

    if skipped:
        log.warning("Skipped %d games due to parse/engine errors.", skipped)

    return all_mistakes


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
    progress_callback=None,  # callable(current, total, mistakes_so_far) | None
) -> list[MistakeEvent]:
    """
    Full Stage-1 pipeline for one user.

    Returns a list of MistakeEvent objects and saves them to JSON.
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
    print(f"{'='*60}\n")

    # ── 1. Fetch games ──────────────────────────────────────────────────────
    print("[1/3] Fetching games...")
    games = _fetch_and_parse(username, platform, min_games)
    print(f"      -> {len(games)} games retrieved\n")

    if not games:
        print("No games found. Check the username and platform.")
        return []

    _save_game_meta(games, username, output_dir)

    # ── 2. Annotate & extract mistakes ─────────────────────────────────────
    print(f"[2/3] Annotating with Stockfish ({sf_path.name})...")
    print(f"      Two-pass strategy: depth-12 screen -> depth-18 on mistakes only\n")

    with chess.engine.SimpleEngine.popen_uci(str(sf_path)) as engine:
        # Configure engine for analysis
        engine.configure({"Threads": 1, "Hash": 128})
        mistakes = _annotate_batch(games, engine, progress_callback=progress_callback)

    print(f"\n      -> {len(mistakes)} mistake events extracted")

    # ── 3. Save & summarise ────────────────────────────────────────────────
    path = _save(mistakes, username, output_dir)
    print(f"\n[3/3] Saved to {path}\n")

    if mistakes:
        from collections import Counter
        tc = Counter(m.threat_type  for m in mistakes)
        pc = Counter(m.game_phase   for m in mistakes)
        print("  Threat breakdown:")
        for t, n in tc.most_common():
            print(f"    {t:<20} {n:>4}  ({n/len(mistakes)*100:.1f}%)")
        print("  Phase breakdown:")
        for p, n in pc.most_common():
            print(f"    {p:<20} {n:>4}  ({n/len(mistakes)*100:.1f}%)")

    print()
    return mistakes
