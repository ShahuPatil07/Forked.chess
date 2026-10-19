"""Fetch PGN games from Chess.com and Lichess public APIs.

Only games that measure the same skill are kept: rated, standard chess, in the
configured time classes (GAME_TIME_CLASSES, rapid by default). Bullet blunders,
daily/correspondence games and variants (Chess960, crazyhouse, from-position)
would otherwise pollute the blindspot profile.
"""
import json
import time
from typing import Optional

import requests

from ml.config import CHESS_COM_API_BASE, LICHESS_API_BASE, REQUEST_HEADERS, GAME_TIME_CLASSES


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _get(url: str, **kwargs) -> requests.Response:
    resp = requests.get(url, headers=REQUEST_HEADERS, timeout=30, **kwargs)
    resp.raise_for_status()
    return resp


def _split_tc(tc: str) -> tuple[Optional[float], float]:
    """'600+5' / '600' -> (initial seconds, increment seconds)."""
    try:
        if "+" in tc:
            a, b = tc.split("+", 1)
            return float(a), float(b)
        if tc and tc != "-" and "/" not in tc:
            return float(tc), 0.0
    except ValueError:
        pass
    return None, 0.0


def _result_for(user_color: str, white_score: Optional[float]) -> Optional[float]:
    if white_score is None:
        return None
    return white_score if user_color == "white" else 1.0 - white_score


# ---------------------------------------------------------------------------
# Chess.com
# ---------------------------------------------------------------------------

def fetch_chesscom_games(username: str, min_games: int = 200,
                         time_classes: tuple[str, ...] = GAME_TIME_CLASSES) -> list[dict]:
    """
    Pull the newest `min_games` rated standard games in `time_classes`, walking
    the player's monthly archives newest-first. Returns raw API game dicts.
    """
    try:
        archives = _get(f"{CHESS_COM_API_BASE}/{username}/games/archives").json().get("archives", [])
    except requests.HTTPError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            raise ValueError(
                f"Chess.com user '{username}' not found. Check the username and platform."
            ) from exc
        raise

    games: list[dict] = []
    for url in reversed(archives[-60:]):            # at most 5 years back
        try:
            month = _get(url).json().get("games", [])
        except requests.HTTPError:
            continue
        keep = [g for g in month
                if g.get("rules", "chess") == "chess"
                and (not time_classes or g.get("time_class") in time_classes)
                and g.get("rated", True)]
        keep.sort(key=lambda g: g.get("end_time") or 0, reverse=True)
        games.extend(keep)
        if len(games) >= min_games:
            break
        time.sleep(0.3)  # stay polite to the API
    return games[:min_games]


_CHESSCOM_SCORE = {"agreed": 0.5, "repetition": 0.5, "stalemate": 0.5,
                   "insufficient": 0.5, "50move": 0.5, "timevsinsufficient": 0.5}


def parse_chesscom_game(game: dict, target_username: str) -> Optional[dict]:
    """
    Normalize a raw Chess.com game dict into a flat structure.
    Returns None if the game has no usable PGN.
    """
    pgn = game.get("pgn", "").strip()
    if not pgn or game.get("rules", "chess") != "chess":
        return None

    white = game.get("white", {})
    black = game.get("black", {})
    white_username = white.get("username", "")
    black_username = black.get("username", "")
    user_color = "white" if white_username.lower() == target_username.lower() else "black"
    tc = game.get("time_control", "")
    initial, inc = _split_tc(tc)
    wr, br = white.get("result", ""), black.get("result", "")
    white_score = 1.0 if wr == "win" else 0.0 if br == "win" else _CHESSCOM_SCORE.get(wr)

    return {
        "game_id":        game.get("uuid", ""),
        "platform":       "chesscom",
        "pgn":            pgn,
        "user_color":     user_color,
        "white_username": white_username,
        "black_username": black_username,
        "white_elo":      white.get("rating"),
        "black_elo":      black.get("rating"),
        "time_control":   tc,
        "time_class":     game.get("time_class", ""),
        "initial_s":      initial,
        "increment_s":    inc,
        "result":         _result_for(user_color, white_score),
        "played_at":      game.get("end_time"),       # Unix timestamp
        "url":            game.get("url", ""),
    }


# ---------------------------------------------------------------------------
# Lichess
# ---------------------------------------------------------------------------

def fetch_lichess_games(username: str, min_games: int = 200,
                        time_classes: tuple[str, ...] = GAME_TIME_CLASSES) -> list[dict]:
    """
    Pull the newest `min_games` rated standard games in `time_classes` from the
    streaming NDJSON games endpoint. Returns raw game dicts with PGN attached.
    """
    url = f"{LICHESS_API_BASE}/games/user/{username}"
    params = {
        "max":    min_games,
        "rated":  "true",
        "pgnInJson": "true",
        "clocks": "true",
        "evals":  "false",
        "opening": "false",
    }
    if time_classes:
        params["perfType"] = ",".join(time_classes)
    resp = requests.get(
        url,
        headers={**REQUEST_HEADERS, "Accept": "application/x-ndjson"},
        params=params,
        stream=True,
        timeout=60,
    )
    if resp.status_code == 404:
        raise ValueError(f"Lichess user '{username}' not found. Check the username and platform.")
    resp.raise_for_status()

    games = []
    for line in resp.iter_lines():
        if line:
            g = json.loads(line)
            if g.get("variant", "standard") == "standard":
                games.append(g)
    return games


def parse_lichess_game(game: dict, target_username: str) -> Optional[dict]:
    pgn = game.get("pgn", "").strip()
    if not pgn or game.get("variant", "standard") != "standard":
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
    winner = game.get("winner")
    status = game.get("status", "")
    white_score = 1.0 if winner == "white" else 0.0 if winner == "black" else (
        0.5 if status in ("draw", "stalemate", "outoftime", "timeout") else None)

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
        "time_class":     game.get("speed", ""),
        "initial_s":      float(tc_initial) if clock else None,
        "increment_s":    float(tc_increment) if clock else 0.0,
        "result":         _result_for(user_color, white_score),
        "played_at":      game.get("createdAt"),
        "url":            f"https://lichess.org/{game.get('id', '')}",
    }
