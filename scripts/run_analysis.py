#!/usr/bin/env python
"""
CLI entry point for the Pawnprint Stage-1 pipeline.

Examples:
    python scripts/run_analysis.py hikaru --platform chesscom
    python scripts/run_analysis.py MagnusCarlsen --platform lichess --games 300 --plot
    python scripts/run_analysis.py hikaru --plot --game-index 0
"""
import argparse
import sys
from pathlib import Path

# Make the project root importable regardless of where the script is called from
sys.path.insert(0, str(Path(__file__).parent.parent))

from ml.pipeline import run_ingestion
from ml.config import DATA_DIR


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Pawnprint — analyse your chess games and surface blindspots."
    )
    p.add_argument("username", help="Chess.com or Lichess username")
    p.add_argument(
        "--platform", choices=["chesscom", "lichess"], default="chesscom",
        help="Which platform to pull games from (default: chesscom)"
    )
    p.add_argument(
        "--games", type=int, default=200,
        help="Minimum number of games to analyse (default: 200)"
    )
    p.add_argument(
        "--output", type=Path, default=DATA_DIR / "output",
        help="Directory for JSON output (default: data/output)"
    )
    p.add_argument(
        "--plot", action="store_true",
        help="Show visualisation plots after analysis"
    )
    p.add_argument(
        "--game-index", type=int, default=None, metavar="N",
        help="When --plot is set, also show eval curve for the Nth game (0-indexed)"
    )
    return p


def main() -> None:
    args = build_parser().parse_args()

    mistakes = run_ingestion(
        username=args.username,
        platform=args.platform,
        min_games=args.games,
        output_dir=args.output,
    )

    if not args.plot or not mistakes:
        return

    from ml.visualization import (
        plot_mistake_overview,
        plot_eval_curve_for_game,
    )

    print("Generating plots...")
    plot_mistake_overview(mistakes, username=args.username)

    if args.game_index is not None:
        # Re-fetch the single game to get the full annotation
        from ml.ingestion.fetcher import fetch_chesscom_games, parse_chesscom_game
        from ml.ingestion.fetcher import fetch_lichess_games, parse_lichess_game
        from ml.ingestion.annotator import annotate_game
        import chess.engine
        from ml.config import STOCKFISH_PATH

        print(f"Fetching game #{args.game_index} for eval-curve plot...")
        if args.platform == "chesscom":
            raw = fetch_chesscom_games(args.username, min_games=args.game_index + 1)
            games = [parse_chesscom_game(g, args.username) for g in raw]
        else:
            raw = fetch_lichess_games(args.username, min_games=args.game_index + 1)
            games = [parse_lichess_game(g, args.username) for g in raw]
        games = [g for g in games if g]

        if args.game_index < len(games):
            game = games[args.game_index]
            with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as engine:
                engine.configure({"Threads": 1, "Hash": 128})
                annotations = annotate_game(game["pgn"], engine)
            plot_eval_curve_for_game(annotations, game_meta=game)
        else:
            print(f"Game index {args.game_index} out of range ({len(games)} games fetched).")


if __name__ == "__main__":
    main()
