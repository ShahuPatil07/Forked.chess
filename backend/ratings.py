"""
Live platform ratings + the Chess.com ↔ Lichess rating scale.

GET /api/ratings/{username}?platform=chesscom|lichess[&refresh=1]
    → {"platform", "ratings": {"rapid": {...}, "blitz": {...}, "bullet": {...}, ...},
       "primary": "rapid", "primary_rating": 1588, "most_played": "blitz", "fetched_at"}

Ratings are cached for an hour in data/output/{username}_ratings.json. Every
fetch also writes the primary (rapid) rating into {username}_settings.json as
`elo` — unless the user pinned a manual value (`elo_manual`) — so every feature
that reads the settings rating (bot games, drills, counterfactual) uses the
player's real, current number instead of a stale default.

Rating scale: Maia models are trained on Lichess games, and the Opening
Explorer buckets are Lichess ratings, but most players think in Chess.com
numbers. RAPID_SCALE pairs Chess.com Rapid with Lichess Rapid at the same
strength, read off ChessGoals' rating-comparison survey (≈20k players, matched
through Chess.com Blitz rows). The gap is not constant: ~+475 at the bottom,
~+260 around 1600 Chess.com, and the scales meet around 2400. The frontend keeps
an identical copy (src/lib/ratings.ts); tests/test_ratings.py checks they agree.
"""
from __future__ import annotations

import logging
import time
from typing import Literal, Optional

import requests
from fastapi import APIRouter, HTTPException

from backend.storage import locked_update, read_json, safe_name
from ml.config import DATA_DIR, REQUEST_HEADERS

log = logging.getLogger("forked.ratings")
router = APIRouter(prefix="/api/ratings")

OUTPUT_DIR = DATA_DIR / "output"
CACHE_S = 3600

# (chess.com rapid, lichess rapid) — ChessGoals rating comparison, rapid columns.
RAPID_SCALE: list[tuple[int, int]] = [
    (815, 1290), (905, 1360), (995, 1425), (1085, 1490), (1170, 1555), (1255, 1615),
    (1340, 1680), (1380, 1710), (1420, 1740), (1460, 1765), (1500, 1795), (1540, 1825),
    (1580, 1850), (1620, 1880), (1655, 1905), (1690, 1935), (1730, 1960), (1765, 1990),
    (1800, 2015), (1835, 2040), (1870, 2065), (1900, 2090), (1935, 2115), (1965, 2140),
    (1995, 2165), (2055, 2215), (2110, 2260), (2165, 2310), (2215, 2355), (2260, 2400),
    (2300, 2445), (2340, 2490), (2375, 2530), (2405, 2575), (2430, 2615),
]


def _interp(x: float, pairs: list[tuple[int, int]]) -> int:
    xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]
    if x <= xs[0]:
        # below the table: keep the bottom slope (lichess moves ~0.78 per chess.com point)
        slope = (ys[1] - ys[0]) / (xs[1] - xs[0])
        return int(round(ys[0] + (x - xs[0]) * slope))
    if x >= xs[-1]:
        slope = (ys[-1] - ys[-2]) / (xs[-1] - xs[-2])
        return int(round(ys[-1] + (x - xs[-1]) * slope))
    for i in range(1, len(xs)):
        if x <= xs[i]:
            t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
            return int(round(ys[i - 1] + t * (ys[i] - ys[i - 1])))
    return int(ys[-1])


def chesscom_to_lichess(rating: float) -> int:
    return _interp(rating, RAPID_SCALE)


def lichess_to_chesscom(rating: float) -> int:
    return _interp(rating, [(b, a) for a, b in RAPID_SCALE])


def to_lichess(rating: float, platform: str) -> int:
    """A rating on `platform`'s scale expressed on the Lichess scale."""
    return int(round(rating)) if platform == "lichess" else chesscom_to_lichess(rating)


def from_lichess(rating: float, platform: str) -> int:
    return int(round(rating)) if platform == "lichess" else lichess_to_chesscom(rating)


# ── fetching ────────────────────────────────────────────────────────────────

FORMATS = ("rapid", "blitz", "bullet", "classical", "daily")


def _fetch_chesscom(username: str) -> dict:
    r = requests.get(f"https://api.chess.com/pub/player/{username.lower()}/stats", headers=REQUEST_HEADERS, timeout=10)
    if r.status_code == 404:
        raise HTTPException(404, f"Chess.com user {username!r} not found")
    r.raise_for_status()
    data = r.json()
    out: dict = {}
    for fmt, key in (("rapid", "chess_rapid"), ("blitz", "chess_blitz"), ("bullet", "chess_bullet"), ("daily", "chess_daily")):
        block = data.get(key)
        if not block:
            continue
        rec = block.get("record") or {}
        games = sum(int(rec.get(k, 0) or 0) for k in ("win", "loss", "draw"))
        out[fmt] = {"rating": (block.get("last") or {}).get("rating"), "games": games,
                    "best": (block.get("best") or {}).get("rating"), "provisional": False}
    return out


def _fetch_lichess(username: str) -> dict:
    r = requests.get(f"https://lichess.org/api/user/{username}", headers=REQUEST_HEADERS, timeout=10)
    if r.status_code == 404:
        raise HTTPException(404, f"Lichess user {username!r} not found")
    r.raise_for_status()
    perfs = r.json().get("perfs") or {}
    out: dict = {}
    for fmt, key in (("rapid", "rapid"), ("blitz", "blitz"), ("bullet", "bullet"),
                     ("classical", "classical"), ("daily", "correspondence")):
        block = perfs.get(key)
        if not block or not block.get("games"):
            continue
        out[fmt] = {"rating": block.get("rating"), "games": block.get("games", 0),
                    "best": None, "provisional": bool(block.get("prov"))}
    return out


def _settings_path(username: str):
    return OUTPUT_DIR / f"{safe_name(username)}_settings.json"


def fetch_ratings(username: str, platform: str, refresh: bool = False) -> dict:
    cache_path = OUTPUT_DIR / f"{safe_name(username)}_ratings.json"
    cached = read_json(cache_path, None)
    if cached and not refresh and cached.get("platform") == platform and time.time() - cached.get("fetched_at", 0) < CACHE_S:
        return cached
    try:
        ratings = _fetch_chesscom(username) if platform == "chesscom" else _fetch_lichess(username)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Rating fetch failed for %s/%s: %s", platform, username, exc)
        if cached:
            return {**cached, "stale": True}
        raise HTTPException(502, "Couldn't reach the chess site for ratings. Try again shortly.")

    playable = {k: v for k, v in ratings.items() if v.get("rating") and k != "daily"}
    most_played = max(playable, key=lambda k: playable[k].get("games", 0)) if playable else None
    # Product rule (for now): the headline rating is RAPID; fall back to the most played format.
    primary = "rapid" if "rapid" in playable else most_played
    result = {"username": username, "platform": platform, "ratings": ratings, "most_played": most_played,
              "primary": primary, "primary_rating": playable.get(primary, {}).get("rating") if primary else None,
              "fetched_at": time.time()}
    from backend.storage import write_json
    write_json(cache_path, result)

    if result["primary_rating"]:
        def sync(settings: dict):
            if not settings.get("elo_manual"):
                settings["elo"] = int(result["primary_rating"])
            settings["platform"] = platform
            settings["elo_source"] = f"{platform}:{primary}"
        locked_update(_settings_path(username), {}, sync)
    return result


@router.get("/{username}")
def get_ratings(username: str, platform: Optional[Literal["chesscom", "lichess"]] = None, refresh: bool = False):
    if platform is None:
        platform = (read_json(_settings_path(username), {}) or {}).get("platform") or "lichess"
    return fetch_ratings(username, platform, refresh)


@router.get("/scale/convert")
def convert(rating: int, platform: Literal["chesscom", "lichess"] = "chesscom"):
    """Express a rating on both scales."""
    lichess = to_lichess(rating, platform)
    return {"lichess": lichess, "chesscom": from_lichess(lichess, "chesscom")}
