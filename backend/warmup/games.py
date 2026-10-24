"""The player's recent games (chess.com / Lichess public APIs): current rating per time
control, the tilt gate, and the games played after a warm-up (outcome linking).

Uses the same fetchers as Game Review's "recent games". Cached for a few minutes so the
Warm-Up page, the session and the coach don't hammer the platforms.
"""
from __future__ import annotations

import logging
import threading
import time

from .config import band_for, cfg

log = logging.getLogger("forked.warmup")

_cache: dict[tuple[str, str], tuple[float, list[dict]]] = {}
_lock = threading.Lock()
CACHE_S = 240

# platform time-class names -> Warm-Up time controls
TC_MAP = {"ultraBullet": "bullet", "bullet": "bullet", "blitz": "blitz", "rapid": "rapid",
          "classical": "classical", "correspondence": None, "daily": None}


def _seconds(ts) -> float | None:
    if ts is None:
        return None
    ts = float(ts)
    return ts / 1000.0 if ts > 1e11 else ts         # Lichess sends milliseconds


def recent_games(username: str, platform: str, n: int = 25, fresh: bool = False) -> list[dict]:
    """Newest first. Each: game_id, time_control (ours), result (user score), user_elo,
    played_at (s), start_at (s, estimated for chess.com), url, pgn, user_color, platform."""
    if not username or username.lower() == "guest":
        return []
    key = (username.lower(), platform)
    with _lock:
        hit = _cache.get(key)
    if hit and not fresh and time.time() - hit[0] < CACHE_S:
        return hit[1]
    from ml.ingestion.fetcher import (fetch_chesscom_games, fetch_lichess_games, parse_chesscom_game,
                                      parse_lichess_game)
    try:
        if platform == "chesscom":
            parsed = [parse_chesscom_game(g, username) for g in fetch_chesscom_games(username, min_games=n, time_classes=())]
        else:
            parsed = [parse_lichess_game(g, username) for g in fetch_lichess_games(username, min_games=n, time_classes=())]
    except Exception as exc:  # noqa: BLE001 -- the platform being down must never break a warm-up
        log.warning("recent games for %s/%s unavailable: %s", platform, username, exc)
        return hit[1] if hit else []
    out = []
    for g in parsed:
        if not g:
            continue
        tc = TC_MAP.get(g.get("time_class") or "", None)
        played = _seconds(g.get("played_at"))
        if tc is None or played is None:
            continue
        user_elo = g.get("white_elo") if g.get("user_color") == "white" else g.get("black_elo")
        start = played if platform == "lichess" else played - estimated_duration(g.get("time_control"))
        out.append({"game_id": g.get("game_id"), "platform": platform, "time_control": tc,
                    "time_control_raw": g.get("time_control"), "result": g.get("result"),
                    "user_elo": user_elo, "played_at": played, "start_at": start, "url": g.get("url"),
                    "pgn": g.get("pgn"), "user_color": g.get("user_color")})
    out.sort(key=lambda g: -g["played_at"])
    with _lock:
        _cache[key] = (time.time(), out)
    return out


def estimated_duration(time_control: str | None) -> float:
    """Rough game length in seconds from a "base+inc" / "base" string (both clocks, 40 moves)."""
    try:
        base, _, inc = (time_control or "600").partition("+")
        return min(2 * float(base) + 80 * float(inc or 0), 4 * 3600) * .7
    except ValueError:
        return 1200.0


def rating_for(games: list[dict], time_control: str) -> int | None:
    for g in games:
        if g["time_control"] == time_control and g.get("user_elo"):
            return int(g["user_elo"])
    return None


def tilt(games: list[dict], band: dict) -> dict:
    """Consecutive losses ending with the most recent game, if it was recent.
    Advisory only: the UI suggests a break and never blocks."""
    t = cfg()["tilt"]
    threshold = band["tilt_losses"]
    streak, last = 0, None
    horizon = time.time() - t["window_hours"] * 3600
    for g in games:
        if g["played_at"] < horizon:
            break
        last = last or g["played_at"]
        if g["result"] == 0.0:
            streak += 1
        else:
            break
    triggered = streak >= threshold
    return {"streak": streak, "threshold": threshold, "triggered": triggered,
            "last_game_at": last, "break_minutes": t["break_minutes"],
            "break_until": (last + t["break_minutes"] * 60) if (triggered and last) else None,
            "last_result": games[0]["result"] if games and games[0]["played_at"] >= horizon else None}


def band_info(username: str, platform: str, time_control: str, fallback_rating: int | None,
              manual_rating: int | None = None) -> tuple[dict, dict, list[dict]]:
    """(band, rating info, recent games). Rating source preference: manual entry > the
    user's latest rating in this time control > their profile rating."""
    games = recent_games(username, platform)          # still needed for tilt + per-TC ratings
    rating, source = None, None
    if manual_rating:
        rating, source = int(manual_rating), "manual"
    else:
        rating = rating_for(games, time_control)
        source = platform if rating else None
    if rating is None:
        rating, source = int(fallback_rating or 1200), "profile"
    info = {"rating": rating, "source": source, "platform": platform,
            "chesscom_calibrated": platform == "chesscom" or source == "manual",
            "note": None if platform == "chesscom" else cfg()["copy"]["lichess_bands"]}
    return band_for(rating), info, games
