"""
Game History — the player's online games (Chess.com / Lichess, every time
class) merged with what Forked already knows about each one:

  * Stage-1 blindspot analysis (rapid games that were ingested): the user's
    mistakes and blunders with the position, the move played and the best move;
  * the game library: whether the game has a stored review (green "Reviewed"
    mark, open it without recomputing) and the review's key moments.

GET /api/history/{username}?platform=&time_class=all|rapid|blitz|bullet|classical&refresh=0
    → {"games": [...], "counts": {"all", "rapid", ...}, "fetched_at", "platform"}

Recent games are cached for 15 minutes in data/output/{user}_recent_games.json.
The walk goes back far enough to cover every analysed game (so the blindspot
data always has its PGN), capped at 12 months / 600 games.
"""
from __future__ import annotations

import io
import logging
import time
from collections import defaultdict
from typing import Literal, Optional

import chess
import chess.pgn
import requests
from fastapi import APIRouter, HTTPException, Request

from backend.auth import assert_owner
from backend.library import game_hash, list_games
from backend.storage import read_json, safe_name, write_json
from ml.config import DATA_DIR, REQUEST_HEADERS

log = logging.getLogger("forked.history")
router = APIRouter(prefix="/api/history")

OUTPUT_DIR = DATA_DIR / "output"
CACHE_S = 15 * 60
RECENT_MIN = 120
MAX_GAMES = 600
MAX_MONTHS = 12


def _norm_ts(ts) -> Optional[float]:
    if not ts:
        return None
    ts = float(ts)
    return ts / 1000.0 if ts > 1e11 else ts


def _opening_from_headers(h: dict) -> Optional[str]:
    if h.get("Opening"):
        return h["Opening"]
    url = h.get("ECOUrl") or ""
    if "/openings/" in url:
        slug = url.rsplit("/openings/", 1)[1]
        name = slug.replace("-", " ").strip()
        # chess.com slugs append the moves ("...Defense 2.Nf3 Nc6") — keep the name part
        cut = [i for i, t in enumerate(name.split()) if t[:1].isdigit()]
        words = name.split()
        return " ".join(words[:cut[0]] if cut else words) or None
    return None


def _facts(pgn: str) -> Optional[dict]:
    try:
        game = chess.pgn.read_game(io.StringIO(pgn))
    except Exception:
        return None
    if game is None:
        return None
    board = game.board()
    initial = board.fen()
    ucis = []
    for mv in game.mainline_moves():
        ucis.append(mv.uci())
        board.push(mv)
    return {"id": game_hash(initial, ucis), "plies": len(ucis), "headers": dict(game.headers)}


def _chesscom_games(username: str, need_ids: set[str]) -> list[dict]:
    from ml.ingestion.fetcher import parse_chesscom_game
    r = requests.get(f"https://api.chess.com/pub/player/{username.lower()}/games/archives",
                     headers=REQUEST_HEADERS, timeout=20)
    if r.status_code == 404:
        raise HTTPException(404, f"Chess.com user {username!r} not found.")
    r.raise_for_status()
    archives = r.json().get("archives", [])
    out: list[dict] = []
    missing = set(need_ids)
    for i, url in enumerate(reversed(archives[-MAX_MONTHS:])):
        try:
            month = requests.get(url, headers=REQUEST_HEADERS, timeout=20).json().get("games", [])
        except Exception:
            continue
        month = [g for g in month if g.get("rules", "chess") == "chess"]
        month.sort(key=lambda g: g.get("end_time") or 0, reverse=True)
        for g in month:
            p = parse_chesscom_game(g, username)
            if p:
                out.append(p)
                missing.discard(p["game_id"])
        if (len(out) >= RECENT_MIN and not missing) or len(out) >= MAX_GAMES:
            break
        time.sleep(0.25)
    return out


def _lichess_games(username: str) -> list[dict]:
    from ml.ingestion.fetcher import parse_lichess_game
    resp = requests.get(f"https://lichess.org/api/games/user/{username}",
                        headers={**REQUEST_HEADERS, "Accept": "application/x-ndjson"},
                        params={"max": 300, "pgnInJson": "true", "clocks": "false", "evals": "false", "opening": "true"},
                        stream=True, timeout=60)
    if resp.status_code == 404:
        raise HTTPException(404, f"Lichess user {username!r} not found.")
    resp.raise_for_status()
    import json as _json
    out = []
    for line in resp.iter_lines():
        if not line:
            continue
        g = _json.loads(line)
        p = parse_lichess_game(g, username)
        if p:
            p["opening_name"] = (g.get("opening") or {}).get("name")
            out.append(p)
    return out


def recent_games(username: str, platform: str, refresh: bool = False) -> dict:
    path = OUTPUT_DIR / f"{safe_name(username)}_recent_games.json"
    cached = read_json(path, None)
    if cached and not refresh and cached.get("platform") == platform and time.time() - cached.get("fetched_at", 0) < CACHE_S:
        return cached
    meta = read_json(OUTPUT_DIR / f"{username}_game_meta.json", {}) or {}
    try:
        raw = _chesscom_games(username, set(meta)) if platform == "chesscom" else _lichess_games(username)
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("History fetch failed for %s: %s", username, exc)
        if cached:
            return {**cached, "stale": True}
        raise HTTPException(502, "Couldn't reach the chess site. Try again in a minute.")
    games = []
    for p in raw:
        f = _facts(p["pgn"])
        if f is None:
            continue
        res = p.get("result")
        games.append({
            "id": f["id"], "platform_id": p.get("game_id"), "platform": platform, "url": p.get("url"),
            "white": p.get("white_username"), "black": p.get("black_username"),
            "white_elo": p.get("white_elo"), "black_elo": p.get("black_elo"), "user_color": p.get("user_color"),
            "outcome": None if res is None else "win" if res == 1.0 else "loss" if res == 0.0 else "draw",
            "time_class": p.get("time_class") or "", "time_control": p.get("time_control") or "",
            "played_at": _norm_ts(p.get("played_at")), "plies": f["plies"],
            "opening": p.get("opening_name") or _opening_from_headers(f["headers"]),
            "result": f["headers"].get("Result", "*"), "pgn": p["pgn"],
        })
    games.sort(key=lambda g: -(g["played_at"] or 0))
    out = {"platform": platform, "fetched_at": time.time(), "games": games}
    write_json(path, out)
    return out


def _stage1_moments(username: str) -> dict[str, dict]:
    """Per analysed game: the user's mistakes and blunders from Stage 1."""
    mistakes = read_json(OUTPUT_DIR / f"{username}_mistakes.json", []) or []
    by_game: dict[str, dict] = defaultdict(lambda: {"mistakes": [], "blunders": []})
    for m in mistakes:
        if m.get("side", "user") != "user" or m.get("cascade"):
            continue
        j = m.get("judgement")
        bucket = "blunders" if j == "blunder" else "mistakes" if j == "mistake" else None
        if bucket is None:
            continue
        fen = m.get("fen") or ""
        best_san = None
        try:
            b = chess.Board(fen)
            best_san = b.san(chess.Move.from_uci(m["best_move_uci"]))
            color = "white" if b.turn == chess.WHITE else "black"
        except Exception:
            color = None
        ply0 = m.get("ply")
        by_game[m["game_id"]][bucket].append({
            "ply": (ply0 + 1) if isinstance(ply0, int) else None, "move_number": m.get("move_number"),
            "color": color, "san": m.get("move_played_san"), "uci": m.get("move_played_uci"),
            "best_san": best_san, "best_uci": m.get("best_move_uci"), "classification": j,
            "loss": m.get("es_loss"), "before_fen": fen,
            "eval_before": {"cp": m.get("eval_before_cp"), "mate": None, "pov": "mover"},
            "eval_after": {"cp": m.get("eval_after_cp"), "mate": None, "pov": "mover"},
            "family": m.get("cluster_id"), "direction": m.get("direction"),
        })
    for g in by_game.values():
        for k in ("mistakes", "blunders"):
            g[k].sort(key=lambda x: x["ply"] or 0)
    return by_game


TimeClass = Literal["all", "rapid", "blitz", "bullet", "classical", "daily"]


@router.get("/{username}")
def history(username: str, request: Request, platform: Optional[Literal["chesscom", "lichess"]] = None,
            time_class: TimeClass = "all", refresh: bool = False, limit: int = 300):
    assert_owner(request, username)
    if platform is None:
        settings = read_json(OUTPUT_DIR / f"{username}_settings.json", {}) or {}
        platform = settings.get("platform") or "lichess"
    data = recent_games(username, platform, refresh)
    stage1 = _stage1_moments(username)
    analysed_ids = set(read_json(OUTPUT_DIR / f"{username}_game_meta.json", {}) or {})
    library = list_games(username)
    counts: dict[str, int] = defaultdict(int)
    out = []
    for g in data["games"]:
        tc = g.get("time_class") or "other"
        counts["all"] += 1
        counts[tc] += 1
        if time_class != "all" and tc != time_class:
            continue
        rec = library.get(g["id"])
        review = (rec or {}).get("review") or {"status": "none"}
        s1 = stage1.get(g.get("platform_id") or "")
        moments = (rec or {}).get("key_moments") if review.get("status") == "done" else None
        out.append({**g, "analysed": s1 is not None or (g.get("platform_id") in analysed_ids), "review": review,
                    "moments": moments or s1 or {"mistakes": [], "blunders": []},
                    "moments_source": "review" if moments else "blindspots" if s1 else None})
        if len(out) >= limit:
            break
    return {"platform": platform, "fetched_at": data.get("fetched_at"), "stale": bool(data.get("stale")),
            "counts": dict(counts), "games": out}
