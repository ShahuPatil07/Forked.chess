"""
Opening Explorer router.

Endpoints (all under /api/openings):
  GET  /explore  — fetch top moves from Lichess for a position (with ELO filter)
  GET  /eval     — Stockfish depth-16 evaluation (cached forever)
  POST /ideas    — Groq-generated "typical ideas" paragraph (cached forever)

Caching: SQLite at data/opening_cache.db
  eval_cache    — fen -> eval string (permanent)
  ideas_cache   — fen -> ideas paragraph (permanent)
  lichess_cache — cache_key -> JSON (24h TTL)
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Optional

import chess
import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ml.config import DATA_DIR, REQUEST_HEADERS

log = logging.getLogger("forked.openings")

router = APIRouter(prefix="/api/openings")

DB_PATH       = DATA_DIR / "opening_cache.db"
LICHESS_URL   = "https://explorer.lichess.org/lichess"
LICHESS_TTL_H = 24
START_FEN     = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
SF_DEPTH      = 16

_db_lock = threading.Lock()


# ── DB setup ──────────────────────────────────────────────────────────────────

def _init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH))
    con.execute("""
        CREATE TABLE IF NOT EXISTS eval_cache (
            fen TEXT PRIMARY KEY, eval TEXT, depth INT, created_at TEXT
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS ideas_cache (
            fen TEXT PRIMARY KEY, ideas TEXT, created_at TEXT
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS lichess_cache (
            cache_key TEXT PRIMARY KEY, data TEXT, expires_at TEXT
        )
    """)
    con.commit()
    con.close()


_init_db()


def _db():
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    return con


# ── ELO bucketing ─────────────────────────────────────────────────────────────

def _elo_to_ratings(elo: Optional[int]) -> str:
    """Map a user ELO to a comma-separated Lichess `ratings` param value."""
    if elo is None:
        return ""
    if elo < 1200:
        return "0,1000"
    if elo < 1400:
        return "1000,1200"
    if elo < 1600:
        return "1200,1400"
    if elo < 1800:
        return "1400,1600,1800"
    if elo < 2000:
        return "1600,1800,2000"
    return "2000,2200,2500"


def _elo_bucket_label(elo: Optional[int]) -> str:
    if elo is None:
        return "all"
    if elo < 1200:  return "u1200"
    if elo < 1400:  return "1200-1400"
    if elo < 1600:  return "1400-1600"
    if elo < 1800:  return "1600-1800"
    if elo < 2000:  return "1800-2000"
    return "2000+"


# ── Lichess proxy ─────────────────────────────────────────────────────────────

def _lichess_cache_get(key: str) -> Optional[dict]:
    with _db_lock:
        con = _db()
        try:
            row = con.execute(
                "SELECT data, expires_at FROM lichess_cache WHERE cache_key=?", (key,)
            ).fetchone()
        finally:
            con.close()
    if row is None:
        return None
    expires = dt.datetime.fromisoformat(row["expires_at"])
    if dt.datetime.utcnow() > expires:
        return None
    try:
        return json.loads(row["data"])
    except Exception:
        return None


def _lichess_cache_set(key: str, data: dict) -> None:
    expires = (dt.datetime.utcnow() + dt.timedelta(hours=LICHESS_TTL_H)).isoformat()
    with _db_lock:
        con = _db()
        try:
            con.execute(
                "INSERT OR REPLACE INTO lichess_cache (cache_key, data, expires_at) VALUES (?, ?, ?)",
                (key, json.dumps(data), expires),
            )
            con.commit()
        finally:
            con.close()


def _split_uci_path(moves: str) -> list[str]:
    return [m for m in moves.replace(",", " ").split() if m]


def _same_position(a: chess.Board, b: chess.Board) -> bool:
    return (
        a.board_fen() == b.board_fen()
        and a.turn == b.turn
        and a.castling_rights == b.castling_rights
        and a.ep_square == b.ep_square
    )


def _normalise_explorer_position(fen: str, moves: str) -> tuple[chess.Board, str]:
    """Return the board being explored and the optional Lichess `play` value.

    Callers in this app pass the current FEN plus the full UCI path for UI
    bookkeeping. Lichess treats `play` as moves to make from `fen`, so sending
    both would replay the path from an already-advanced position and can 400.
    """
    board = chess.Board(fen)
    path = _split_uci_path(moves)
    if not path:
        return board, ""

    path_board = chess.Board(START_FEN)
    for uci in path:
        path_board.push(chess.Move.from_uci(uci))

    if _same_position(board, path_board):
        return board, ""

    start_board = chess.Board(START_FEN)
    if _same_position(board, start_board):
        return path_board, ",".join(path)

    log.info(
        "Ignoring opening explorer move path that does not match fen: fen=%s moves=%s",
        fen,
        moves,
    )
    return board, ""


def _fetch_lichess(fen: str, moves: str, elo: Optional[int]) -> dict:
    board, lichess_play = _normalise_explorer_position(fen, moves)
    lichess_fen = board.fen() if lichess_play else fen
    ratings   = _elo_to_ratings(elo)
    cache_key = f"{lichess_fen}|{lichess_play}|{_elo_bucket_label(elo)}"

    cached = _lichess_cache_get(cache_key)
    if cached is not None:
        return cached

    params = {
        "fen":          lichess_fen,
        "topGames":     0,
        "recentGames":  0,
        "variant":      "standard",
        "speeds":       "blitz,rapid,classical",
    }
    if lichess_play:
        params["play"] = lichess_play
    if ratings:
        params["ratings"] = ratings

    # Optional Lichess Bearer token (some networks/regions require it for
    # the explorer endpoint).  Free to create at https://lichess.org/account/oauth/token
    headers = dict(REQUEST_HEADERS)
    token   = os.environ.get("LICHESS_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        resp = requests.get(LICHESS_URL, params=params, headers=headers, timeout=8)
        if resp.status_code == 401:
            msg = (
                "Lichess opening explorer returned 401 (unauthorized). "
                "Set LICHESS_TOKEN in .env with a Lichess API token "
                "(free at https://lichess.org/account/oauth/token)."
            )
            log.warning(msg)
            raise HTTPException(503, msg)
        resp.raise_for_status()
        data = resp.json()
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Lichess opening explorer failed: %s", exc)
        raise HTTPException(503, f"Opening explorer temporarily unavailable: {exc}")

    _lichess_cache_set(cache_key, data)
    return data


# ── /explore ──────────────────────────────────────────────────────────────────

@router.get("/explore")
async def explore(
    fen:   str            = START_FEN,
    moves: str            = "",
    elo:   Optional[int]  = None,
):
    loop = asyncio.get_event_loop()
    data = await loop.run_in_executor(None, lambda: _fetch_lichess(fen, moves, elo))

    raw_moves = data.get("moves", []) or []

    # Compute totals + WDL + popularity, and apply each move to get fen_after
    try:
        board_in, _ = _normalise_explorer_position(fen, moves)
    except Exception:
        board_in = chess.Board()

    parent_total = sum(int(m.get("white", 0)) + int(m.get("draws", 0)) + int(m.get("black", 0))
                       for m in raw_moves) or 1

    results: list[dict] = []
    for m in raw_moves:
        w = int(m.get("white", 0))
        d = int(m.get("draws", 0))
        l = int(m.get("black", 0))
        total = w + d + l
        if total == 0:
            continue

        pop_pct = total / parent_total * 100
        if pop_pct < 0.5:
            continue

        san = m.get("san", "")
        uci = m.get("uci", "")
        if not san or not uci:
            continue

        try:
            after = board_in.copy()
            after.push(chess.Move.from_uci(uci))
            fen_after = after.fen()
        except Exception:
            continue

        opening_obj = m.get("opening") or {}
        results.append({
            "san":        san,
            "uci":        uci,
            "name":       opening_obj.get("name", ""),
            "eco":        opening_obj.get("eco", ""),
            "popularity": round(pop_pct, 1),
            "w":          round(w / total * 100, 1),
            "d":          round(d / total * 100, 1),
            "l":          round(l / total * 100, 1),
            "games":      total,
            "ideas":      None,
            "eval":       None,
            "fen_after":  fen_after,
        })

    # Sort by popularity, cap at 8
    results.sort(key=lambda r: r["popularity"], reverse=True)
    results = results[:8]

    # Batch-lookup cached ideas + evals
    fens_after = [r["fen_after"] for r in results]
    if fens_after:
        placeholders = ",".join("?" * len(fens_after))
        with _db_lock:
            con = _db()
            try:
                ideas_rows = con.execute(
                    f"SELECT fen, ideas FROM ideas_cache WHERE fen IN ({placeholders})",
                    fens_after,
                ).fetchall()
                eval_rows = con.execute(
                    f"SELECT fen, eval FROM eval_cache WHERE fen IN ({placeholders})",
                    fens_after,
                ).fetchall()
            finally:
                con.close()
        ideas_map = {row["fen"]: row["ideas"] for row in ideas_rows}
        eval_map  = {row["fen"]: row["eval"]  for row in eval_rows}
        for r in results:
            r["ideas"] = ideas_map.get(r["fen_after"])
            r["eval"]  = eval_map.get(r["fen_after"])

    parent_opening_obj = data.get("opening") or None
    parent_opening = None
    if parent_opening_obj:
        parent_opening = {
            "name": parent_opening_obj.get("name", ""),
            "eco":  parent_opening_obj.get("eco", ""),
        }

    return {
        "opening":     parent_opening,
        "moves":       results,
        "elo_bucket":  _elo_bucket_label(elo),
    }


# ── /eval ─────────────────────────────────────────────────────────────────────

def _format_eval(score) -> str:
    pov = score.white()
    if pov.is_mate():
        mate = pov.mate() or 0
        return f"+M{abs(mate)}" if mate > 0 else f"-M{abs(mate)}"
    cp = pov.score() or 0
    pawns = cp / 100.0
    return f"+{pawns:.1f}" if pawns >= 0 else f"{pawns:.1f}"


def _run_stockfish(fen: str) -> str:
    # Import lazily to avoid circular import on module load
    from backend.main import _sf_lock, _ensure_engine
    import chess.engine

    with _sf_lock:
        engine = _ensure_engine()
        info   = engine.analyse(chess.Board(fen), chess.engine.Limit(depth=SF_DEPTH))

    return _format_eval(info["score"])


@router.get("/eval")
async def get_eval(fen: str):
    # Cache lookup
    with _db_lock:
        con = _db()
        try:
            row = con.execute(
                "SELECT eval, depth FROM eval_cache WHERE fen=?", (fen,)
            ).fetchone()
        finally:
            con.close()

    if row is not None:
        return {"eval": row["eval"], "depth": row["depth"], "cached": True}

    # Compute
    try:
        loop = asyncio.get_event_loop()
        eval_str = await loop.run_in_executor(None, lambda: _run_stockfish(fen))
    except Exception as exc:
        log.error("Stockfish eval failed for %s: %s", fen, exc)
        raise HTTPException(500, f"Engine error: {exc}")

    # Cache result
    with _db_lock:
        con = _db()
        try:
            con.execute(
                "INSERT OR REPLACE INTO eval_cache (fen, eval, depth, created_at) VALUES (?, ?, ?, ?)",
                (fen, eval_str, SF_DEPTH, dt.datetime.utcnow().isoformat()),
            )
            con.commit()
        finally:
            con.close()

    return {"eval": eval_str, "depth": SF_DEPTH, "cached": False}


# ── /ideas ────────────────────────────────────────────────────────────────────

class IdeasRequest(BaseModel):
    fen:           str
    move:          str
    opening_name:  str = ""
    side_to_move:  str = "white"


_IDEAS_PROMPT = """You are a chess coach writing for intermediate players (1000-1800 ELO).

Opening: {opening_name}
Position FEN: {fen}
Side to move: {side}
Move just played: {move}

Write a single paragraph (4-6 sentences) describing the typical ideas,
plans, and strategic themes for both sides in this position. Be concrete -
mention piece placement, pawn breaks, and typical manoeuvres. Do not mention
specific move numbers or use bullet points. Write in plain prose."""


def _call_groq(req: IdeasRequest) -> str:
    from groq import Groq

    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY not set")

    client = Groq(api_key=api_key)
    prompt = _IDEAS_PROMPT.format(
        opening_name = req.opening_name or "an unnamed line",
        fen          = req.fen,
        side         = req.side_to_move,
        move         = req.move,
    )

    completion = client.chat.completions.create(
        model       = "llama-3.3-70b-versatile",
        messages    = [{"role": "user", "content": prompt}],
        temperature = 0.5,
        max_tokens  = 220,
    )
    return completion.choices[0].message.content.strip()


@router.post("/ideas")
async def post_ideas(req: IdeasRequest):
    # Cache lookup
    with _db_lock:
        con = _db()
        try:
            row = con.execute(
                "SELECT ideas FROM ideas_cache WHERE fen=?", (req.fen,)
            ).fetchone()
        finally:
            con.close()

    if row is not None:
        return {"ideas": row["ideas"], "cached": True}

    # Generate
    try:
        loop = asyncio.get_event_loop()
        ideas = await loop.run_in_executor(None, lambda: _call_groq(req))
    except Exception as exc:
        log.error("Groq ideas generation failed: %s", exc)
        raise HTTPException(503, f"AI description unavailable: {exc}")

    # Cache
    with _db_lock:
        con = _db()
        try:
            con.execute(
                "INSERT OR REPLACE INTO ideas_cache (fen, ideas, created_at) VALUES (?, ?, ?)",
                (req.fen, ideas, dt.datetime.utcnow().isoformat()),
            )
            con.commit()
        finally:
            con.close()

    return {"ideas": ideas, "cached": False}
