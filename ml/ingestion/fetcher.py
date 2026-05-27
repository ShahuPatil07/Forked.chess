"""Fetch PGN games from Chess.com and Lichess public APIs."""
import time
from datetime import datetime
from typing import Optional

import requests

from ml.config import CHESS_COM_API_BASE, LICHESS_API_BASE, REQUEST_HEADERS


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _get(url: str, **kwargs) -> requests.Response:
    resp = requests.get(url, headers=REQUEST_HEADERS, timeout=30, **kwargs)
    resp.raise_for_status()
    return resp


# ---------------------------------------------------------------------------
# Chess.com
# ---------------------------------------------------------------------------

def fetch_chesscom_games(username: str, min_games: int = 200) -> list[dict]:
    """
    Pull games from Chess.com newest-first until we have at least min_games.
    Returns raw game dicts from the API (each has a 'pgn' field).
    """
    games: list[dict] = []
    now = datetime.utcnow()
    year, month = now.year, now.month

    # Chess.com rate-limit is lenient but add a small delay between requests
    while len(games) < min_games:
        url = f"{CHESS_COM_API_BASE}/{username}/games/{year}/{month:02d}"
        try:
            resp = _get(url)
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                break  # No more months available
            raise

        month_games = resp.json().get("games", [])
        games.extend(month_games)

        # Step back one month
        month -= 1
        if month == 0:
            month = 12
            year -= 1

        # Don't go back more than 3 years
        if year < now.year - 3:
            break

        time.sleep(0.3)  # stay polite to the API

    return games


def parse_chesscom_game(game: dict, target_username: str) -> Optional[dict]:
    """
    Normalize a raw Chess.com game dict into a flat structure.
    Returns None if the game has no usable PGN.
    """
    pgn = game.get("pgn", "").strip()
    if not pgn:
        return None

    white = game.get("white", {})
    black = game.get("black", {})
    white_username = white.get("username", "")
    black_username = black.get("username", "")
    user_color = "white" if white_username.lower() == target_username.lower() else "black"

    return {
        "game_id":        game.get("uuid", ""),
        "platform":       "chesscom",
        "pgn":            pgn,
        "user_color":     user_color,
        "white_username": white_username,
        "black_username": black_username,
        "white_elo":      white.get("rating"),
        "black_elo":      black.get("rating"),
        "time_control":   game.get("time_control", ""),
        "played_at":      game.get("end_time"),       # Unix timestamp
        "url":            game.get("url", ""),
    }


# ---------------------------------------------------------------------------
# Lichess
# ---------------------------------------------------------------------------

def fetch_lichess_games(username: str, min_games: int = 200) -> list[dict]:
    """
    Pull games from Lichess using the streaming NDJSON games endpoint.
    Returns a list of raw game dicts with PGN strings attached.
    """
    url = f"{LICHESS_API_BASE}/games/user/{username}"
    params = {
        "max":    min_games,
        "pgnInJson": "true",
        "clocks": "true",
        "evals":  "false",
        "opening": "false",
    }
    resp = requests.get(
        url,
        headers={**REQUEST_HEADERS, "Accept": "application/x-ndjson"},
        params=params,
        stream=True,
        timeout=60,
    )
    resp.raise_for_status()

    import json
    games = []
    for line in resp.iter_lines():
        if line:
            games.append(json.loads(line))
    return games


def parse_lichess_game(game: dict, target_username: str) -> Optional[dict]:
    pgn = game.get("pgn", "").strip()
    if not pgn:
        return None

    players = game.get("players", {})
    white_player = players.get("white", {})
    black_player = players.get("black", {})
    white_username = white_player.get("user", {}).get("name", "")
    black_username = black_player.get("user", {}).get("name", "")
    user_color = "white" if white_username.lower() == target_username.lower() else "black"

    clock = game.get("clock", {})
    tc_initial = clock.get("initial", 0)
    tc_increment = clock.get("increment", 0)
    time_control = f"{tc_initial}+{tc_increment}" if clock else ""

    return {
        "game_id":        game.get("id", ""),
        "platform":       "lichess",
        "pgn":            pgn,
        "user_color":     user_color,
        "white_username": white_username,
        "black_username": black_username,
        "white_elo":      white_player.get("rating"),
        "black_elo":      black_player.get("rating"),
        "time_control":   time_control,
        "played_at":      game.get("createdAt"),
        "url":            f"https://lichess.org/{game.get('id', '')}",
    }
