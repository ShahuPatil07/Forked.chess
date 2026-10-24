"""
Game library + background game reviews.

Every game that passes through Forked lands here once: games played against
Maia (including opening / endgame practice that reached a result), games the
user reviewed, games confirmed from an OTB scoresheet. A review is computed
once, stored, and reopened instantly from anywhere (Game Review, Game History,
OTB Scan history, Analysis Board) — nothing is recomputed.

Storage — data/library/{user}/ (gitignored):
  games.json             {"games": {<game id>: record}}   the user's Forked history
  reviews/{id}.json      full review (every move row + summary), one per game
  scans/{id}.jpg         OTB scoresheet thumbnail

Game identity: id = sha1(initial FEN | UCI moves)[:20]. The same game reached
from two places (an OTB scan you later review, a Chess.com game you open twice)
is one record, and its review is shared.

Reviews run as jobs on ONE background worker (Stockfish is CPU-bound; the
review slot is shared with the legacy /api/game-review/analyse stream). Each
job keeps its full event log in memory, so the SSE stream can be replayed from
the start by any client: a page that re-mounts, a second tab, or the Analysis
Board's "Review this game" button that keeps working while the user explores.
Events: queued → start → move×N → done | error (same shapes as the legacy
stream, so the review UI is shared).

API (prefix /api/library):
  GET    /{user}/games                   list (filters: source, reviewed, q, limit, offset)
  POST   /{user}/games                   add / update a game (no review)
  GET    /{user}/games/{id}              one record (with PGN)
  DELETE /{user}/games/{id}              remove a game and its review
  GET    /{user}/games/{id}/scan         the stored scoresheet image
  POST   /{user}/reviews                 start (or reuse) a review → {review_id, status}
  GET    /{user}/reviews/{id}            the stored review, or the live job snapshot
  GET    /{user}/reviews/{id}/stream     SSE: replay + live progress
  POST   /{user}/lookup                  {pgns|ids} → which of these games are reviewed
"""
from __future__ import annotations

import asyncio
import base64
import datetime as dt
import hashlib
import io
import json
import logging
import queue
import threading
import time
from pathlib import Path
from typing import Any, Literal, Optional

import chess
import chess.engine
import chess.pgn
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from backend.auth import assert_owner
from backend.storage import locked_update, read_json, safe_name, write_json
from ml.config import DATA_DIR, STOCKFISH_PATH

log = logging.getLogger("forked.library")
router = APIRouter(prefix="/api/library")

LIBRARY_DIR = DATA_DIR / "library"
Source = Literal["maia", "opening", "endgame", "otb", "review", "analysis", "platform", "coach"]
SOURCE_LABEL = {"maia": "Played vs Maia", "opening": "Opening practice", "endgame": "Endgame practice",
                "otb": "OTB scan", "review": "Reviewed", "analysis": "Analysis board", "platform": "Online game",
                "coach": "Coach"}
MISTAKE_CLASSES = ("mistake", "miss")
BLUNDER_CLASSES = ("blunder",)


# ── paths & ids ─────────────────────────────────────────────────────────────

def user_dir(username: str) -> Path:
    return LIBRARY_DIR / safe_name(username)


def games_path(username: str) -> Path:
    return user_dir(username) / "games.json"


def review_path(username: str, review_id: str) -> Path:
    return user_dir(username) / "reviews" / f"{safe_name(review_id)}.json"


def scan_path(username: str, game_id: str) -> Path:
    return user_dir(username) / "scans" / f"{safe_name(game_id)}.jpg"


def game_hash(initial_fen: str, ucis: list[str]) -> str:
    board = chess.Board(initial_fen)
    # normalise move counters so the same game hashes the same from any source
    key = f"{board.board_fen()} {'w' if board.turn else 'b'} {board.castling_xfen()}|{' '.join(ucis)}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:20]


def _now() -> float:
    return time.time()


# ── PGN helpers ─────────────────────────────────────────────────────────────

def parse_pgn(text: str) -> chess.pgn.Game:
    from backend.game_review import parse_game
    return parse_game(text)


def game_facts(game: chess.pgn.Game) -> dict:
    board = game.board()
    initial_fen = board.fen()
    ucis, sans = [], []
    for mv in game.mainline_moves():
        sans.append(board.san(mv))
        ucis.append(mv.uci())
        board.push(mv)
    h = dict(game.headers)
    result = h.get("Result", "*")
    if result == "*" and board.is_game_over():
        result = board.result()
    return {"initial_fen": initial_fen, "moves": ucis, "sans": sans, "plies": len(ucis), "headers": h,
            "result": result, "final_fen": board.fen(), "id": game_hash(initial_fen, ucis)}


def build_pgn(initial_fen: str, ucis: list[str], headers: dict[str, str]) -> str:
    game = chess.pgn.Game()
    for k, v in headers.items():
        if v is not None and v != "":
            game.headers[k] = str(v)
    board = chess.Board(initial_fen)
    if initial_fen != chess.STARTING_FEN:
        game.setup(board)
    node = game
    for u in ucis:
        try:
            mv = chess.Move.from_uci(u)
        except ValueError:
            break
        if mv not in board.legal_moves:
            break
        node = node.add_variation(mv)
        board.push(mv)
    if "Result" not in headers or headers.get("Result") in (None, "", "*"):
        game.headers["Result"] = board.result() if board.is_game_over() else headers.get("Result") or "*"
    return str(game)


def _user_color_from_headers(headers: dict, username: str, aliases: list[str]) -> Optional[str]:
    names = {n.lower() for n in [username, *aliases] if n}
    if (headers.get("White") or "").lower() in names:
        return "white"
    if (headers.get("Black") or "").lower() in names:
        return "black"
    return None


def _played_at(headers: dict) -> Optional[float]:
    date = headers.get("UTCDate") or headers.get("Date") or ""
    tm = headers.get("UTCTime") or headers.get("EndTime") or "12:00:00"
    try:
        y, m, d = (int(x) for x in date.split(".")[:3])
        hh, mm, ss = (int(x) for x in tm.split(":")[:3])
        return dt.datetime(y, m, d, hh, mm, ss, tzinfo=dt.timezone.utc).timestamp()
    except Exception:
        return None


def _time_class(headers: dict) -> Optional[str]:
    tc = headers.get("TimeControl") or ""
    try:
        base, _, inc = tc.partition("+")
        est = float(base) + 40 * float(inc or 0)
    except ValueError:
        return None
    if est < 180:
        return "bullet"
    if est < 600:
        return "blitz"
    if est < 1800:
        return "rapid"
    return "classical"


# ── records ─────────────────────────────────────────────────────────────────

def list_games(username: str) -> dict[str, dict]:
    return (read_json(games_path(username), {"games": {}}) or {}).get("games", {})


def get_game(username: str, game_id: str) -> Optional[dict]:
    return list_games(username).get(game_id)


def upsert_game(username: str, *, pgn: Optional[str] = None, initial_fen: Optional[str] = None,
                moves: Optional[list[str]] = None, headers: Optional[dict] = None, source: str = "review",
                meta: Optional[dict] = None, user_color: Optional[str] = None, title: Optional[str] = None,
                played_at: Optional[float] = None, url: Optional[str] = None,
                time_class: Optional[str] = None, aliases: Optional[list[str]] = None) -> dict:
    """Create or update the library record for a game; returns the record."""
    if pgn:
        facts = game_facts(parse_pgn(pgn))
        headers = {**facts["headers"], **(headers or {})}
    else:
        if moves is None:
            raise HTTPException(400, "A PGN or a move list is required.")
        start = initial_fen or chess.STARTING_FEN
        pgn = build_pgn(start, moves, headers or {})
        facts = game_facts(parse_pgn(pgn))
        headers = facts["headers"]
    gid = facts["id"]
    color = user_color or _user_color_from_headers(headers, username, aliases or [])
    url = url or headers.get("Link") or (headers.get("Site") if (headers.get("Site") or "").startswith("http") else None)
    now = _now()

    def apply(store: dict):
        games = store.setdefault("games", {})
        rec = games.get(gid) or {"id": gid, "created_at": now, "sources": [], "review": {"status": "none"}}
        rec.update({
            "pgn": pgn, "initial_fen": facts["initial_fen"], "moves": facts["moves"], "plies": facts["plies"],
            "white": headers.get("White") or rec.get("white") or "White",
            "black": headers.get("Black") or rec.get("black") or "Black",
            "white_elo": headers.get("WhiteElo") or rec.get("white_elo"),
            "black_elo": headers.get("BlackElo") or rec.get("black_elo"),
            "result": facts["result"] if facts["result"] != "*" else rec.get("result", "*"),
            "updated_at": now,
        })
        if color:
            rec["user_color"] = color
        rec.setdefault("user_color", None)
        if source not in rec["sources"]:
            rec["sources"].append(source)
        # the "headline" source: the most specific way the game reached Forked
        priority = ["otb", "opening", "endgame", "maia", "platform", "analysis", "coach", "review"]
        rec["source"] = min(rec["sources"], key=lambda s: priority.index(s) if s in priority else 99)
        rec["played_at"] = played_at or rec.get("played_at") or _played_at(headers) or now
        rec["time_class"] = time_class or rec.get("time_class") or _time_class(headers)
        if url:
            rec["url"] = url
        rec.setdefault("url", None)
        rec["meta"] = {**(rec.get("meta") or {}), **(meta or {})}
        rec["title"] = title or rec.get("title") or f"{rec['white']} – {rec['black']}"
        games[gid] = rec
    store = locked_update(games_path(username), {"games": {}}, apply)
    return store["games"][gid]


def delete_game(username: str, game_id: str) -> bool:
    removed = {"ok": False}

    def apply(store: dict):
        if store.get("games", {}).pop(game_id, None) is not None:
            removed["ok"] = True
    locked_update(games_path(username), {"games": {}}, apply)
    for p in (review_path(username, game_id), scan_path(username, game_id)):
        try:
            p.unlink()
        except OSError:
            pass
    return removed["ok"]


def key_moments(rows: list[dict], user_color: Optional[str]) -> dict:
    """The review's mistakes (mistake / miss) and blunders, for the user's side
    when known, otherwise for both sides."""
    out: dict[str, list] = {"mistakes": [], "blunders": []}
    for r in rows:
        if user_color and r.get("color") != user_color:
            continue
        cls = r.get("classification")
        bucket = "blunders" if cls in BLUNDER_CLASSES else "mistakes" if cls in MISTAKE_CLASSES else None
        if not bucket:
            continue
        bs, ps = r.get("best_score") or {}, r.get("played_score") or {}
        out[bucket].append({
            "ply": r.get("ply"), "move_number": r.get("move_number"), "color": r.get("color"),
            "san": r.get("san"), "uci": r.get("uci"), "best_san": r.get("best_san"), "best_uci": r.get("best_uci"),
            "classification": cls, "loss": r.get("expected_loss"), "before_fen": r.get("before_fen"),
            "eval_before": {"cp": bs.get("white_cp"), "mate": bs.get("white_mate")},
            "eval_after": {"cp": ps.get("white_cp"), "mate": ps.get("white_mate")},
        })
    return out


def public_record(rec: dict, with_pgn: bool = False) -> dict:
    out = {k: v for k, v in rec.items() if k not in ("pgn", "moves") or with_pgn}
    out["source_label"] = SOURCE_LABEL.get(rec.get("source", ""), rec.get("source"))
    out["has_scan"] = bool((rec.get("meta") or {}).get("scan"))
    return out


# ── review jobs ─────────────────────────────────────────────────────────────

class ReviewJob:
    def __init__(self, username: str, game_id: str, pgn: str, quality: str, user_color: Optional[str]):
        self.username, self.id, self.pgn, self.quality, self.user_color = username, game_id, pgn, quality, user_color
        self.status = "queued"
        self.events: list[dict] = [{"type": "queued", "review_id": game_id}]
        self.lock = threading.Lock()
        self.finished_at: Optional[float] = None
        self.total = 0
        self.done_moves = 0

    def emit(self, evt: dict) -> None:
        with self.lock:
            self.events.append(evt)

    def since(self, i: int) -> tuple[list[dict], str]:
        with self.lock:
            return self.events[i:], self.status


_jobs: dict[tuple[str, str], ReviewJob] = {}
_jobs_lock = threading.Lock()
_queue: "queue.Queue[ReviewJob]" = queue.Queue()
_worker_started = False


def _ensure_worker() -> None:
    global _worker_started
    with _jobs_lock:
        if _worker_started:
            return
        _worker_started = True
    threading.Thread(target=_worker_loop, name="forked-review-worker", daemon=True).start()


def _worker_loop() -> None:
    import sys
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    while True:
        job = _queue.get()
        try:
            _run_job(job)
        except Exception as exc:                      # never kill the worker
            log.error("Review job %s failed: %s", job.id, exc, exc_info=True)
            job.status = "error"
            job.emit({"type": "error", "message": "Review stopped before completion. Try again with Quick quality."})
            _set_review_status(job.username, job.id, {"status": "error"})
        finally:
            job.finished_at = _now()
            _prune_jobs()


def _prune_jobs() -> None:
    cutoff = _now() - 600
    with _jobs_lock:
        for key in [k for k, j in _jobs.items() if j.finished_at and j.finished_at < cutoff]:
            _jobs.pop(key, None)


def _set_review_status(username: str, game_id: str, review: dict) -> None:
    def apply(store: dict):
        rec = store.get("games", {}).get(game_id)
        if rec is not None:
            rec["review"] = {**(rec.get("review") or {}), **review}
            rec["updated_at"] = _now()
    locked_update(games_path(username), {"games": {}}, apply)


def _run_job(job: ReviewJob) -> None:
    from backend.game_review import (ALGORITHM, REVIEW_SLOT, _rating_of, official_accuracy, review_rows,
                                     summarize)
    game = parse_pgn(job.pgn)
    job.total = len(list(game.mainline_moves()))
    REVIEW_SLOT.acquire()                     # one engine-heavy review at a time, across both APIs
    try:
        job.status = "running"
        _set_review_status(job.username, job.id, {"status": "running", "id": job.id})
        job.emit({"type": "start", "review_id": job.id, "total": job.total, "headers": dict(game.headers),
                  "initial_fen": game.board().fen(), "quality": job.quality, "algorithm": ALGORITHM})
        rows: list[dict] = []
        with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as engine:
            engine.configure({"Threads": 1, "Hash": 64, "UCI_ShowWDL": True})
            for row in review_rows(game, engine, job.quality):
                rows.append(row)
                job.done_moves = len(rows)
                job.emit({"type": "move", "move": row})
            engine_name = engine.id.get("name", "Stockfish")
    finally:
        REVIEW_SLOT.release()
    try:
        official = official_accuracy(dict(game.headers))
    except Exception:
        official = None
    summary = summarize(rows, {"white": _rating_of(game, chess.WHITE), "black": _rating_of(game, chess.BLACK)})
    opening = next((r["opening"] for r in reversed(rows) if r.get("opening")), None)
    doc = {"id": job.id, "username": job.username, "headers": dict(game.headers), "initial_fen": game.board().fen(),
           "quality": job.quality, "algorithm": ALGORITHM, "engine": engine_name, "moves": rows, "summary": summary,
           "official_accuracy": official, "user_color": job.user_color, "created_at": _now(), "complete": True}
    write_json(review_path(job.username, job.id), doc)
    moments = key_moments(rows, job.user_color)
    _set_review_status(job.username, job.id, {
        "status": "done", "id": job.id, "quality": job.quality, "completed_at": _now(),
        "accuracy": {s: summary[s]["accuracy"] for s in ("white", "black")},
        "rating": {s: (summary[s].get("rating") or {}).get("estimate") for s in ("white", "black")},
        "counts": {s: summary[s]["counts"] for s in ("white", "black")},
        "mistakes": len(moments["mistakes"]), "blunders": len(moments["blunders"]),
    })

    def add_moments(store: dict):
        rec = store.get("games", {}).get(job.id)
        if rec is not None:
            rec["key_moments"] = moments
            if opening:
                rec["opening"] = opening
    locked_update(games_path(job.username), {"games": {}}, add_moments)
    job.status = "done"
    job.emit({"type": "done", "review_id": job.id, "summary": summary, "engine": engine_name,
              "algorithm": ALGORITHM, "official_accuracy": official})


def start_review(username: str, pgn: str, quality: str = "standard", *, source: str = "review",
                 meta: Optional[dict] = None, user_color: Optional[str] = None, title: Optional[str] = None,
                 url: Optional[str] = None, time_class: Optional[str] = None, force: bool = False,
                 aliases: Optional[list[str]] = None) -> dict:
    if not STOCKFISH_PATH.exists():
        raise HTTPException(503, "Local Stockfish is not installed.")
    rec = upsert_game(username, pgn=pgn, source=source, meta=meta, user_color=user_color, title=title,
                      url=url, time_class=time_class, aliases=aliases)
    gid = rec["id"]
    key = (safe_name(username), gid)
    with _jobs_lock:
        live = _jobs.get(key)
        if live is not None and live.status in ("queued", "running"):
            return {"review_id": gid, "status": live.status, "game": public_record(rec)}
    stored = read_json(review_path(username, gid), None)
    if stored and not force and _quality_rank(stored.get("quality")) >= _quality_rank(quality):
        return {"review_id": gid, "status": "done", "game": public_record(rec)}
    job = ReviewJob(username, gid, rec["pgn"], quality, rec.get("user_color"))
    with _jobs_lock:
        _jobs[key] = job
    _set_review_status(username, gid, {"status": "queued", "id": gid})
    _ensure_worker()
    _queue.put(job)
    return {"review_id": gid, "status": "queued", "game": public_record(get_game(username, gid) or rec)}


def _quality_rank(q: Optional[str]) -> int:
    return {"quick": 0, "standard": 1, "deep": 2}.get(q or "standard", 1)


def job_for(username: str, review_id: str) -> Optional[ReviewJob]:
    with _jobs_lock:
        return _jobs.get((safe_name(username), review_id))


# ── API models ──────────────────────────────────────────────────────────────

class GameIn(BaseModel):
    pgn: Optional[str] = Field(default=None, max_length=150_000)
    moves: Optional[list[str]] = None
    initial_fen: Optional[str] = None
    headers: Optional[dict[str, str]] = None
    source: Source = "analysis"
    meta: Optional[dict[str, Any]] = None
    user_color: Optional[Literal["white", "black"]] = None
    title: Optional[str] = Field(default=None, max_length=160)
    url: Optional[str] = Field(default=None, max_length=300)
    time_class: Optional[str] = None
    scan_image: Optional[str] = Field(default=None, max_length=3_000_000)   # data:image/jpeg;base64,...


class ReviewIn(BaseModel):
    pgn: str = Field(min_length=1, max_length=150_000)
    quality: Literal["quick", "standard", "deep"] = "standard"
    source: Source = "review"
    meta: Optional[dict[str, Any]] = None
    user_color: Optional[Literal["white", "black"]] = None
    title: Optional[str] = Field(default=None, max_length=160)
    url: Optional[str] = Field(default=None, max_length=300)
    time_class: Optional[str] = None
    force: bool = False


class LookupIn(BaseModel):
    pgns: list[str] = Field(default_factory=list, max_length=300)
    ids: list[str] = Field(default_factory=list, max_length=300)


def _aliases(request: Request) -> list[str]:
    from backend.auth import current_user
    u = current_user(request)
    return [x for x in ((u or {}).get("user_id"), (u or {}).get("name"), (u or {}).get("chess_username")) if x]


# ── routes ──────────────────────────────────────────────────────────────────

@router.get("/{username}/games")
def api_list_games(username: str, request: Request, source: Optional[str] = None, reviewed: Optional[bool] = None,
                   q: Optional[str] = None, limit: int = 200, offset: int = 0):
    assert_owner(request, username)
    games = list(list_games(username).values())
    if source:
        wanted = set(source.split(","))
        games = [g for g in games if wanted & set(g.get("sources") or [g.get("source")])]
    if reviewed is not None:
        games = [g for g in games if ((g.get("review") or {}).get("status") == "done") == reviewed]
    if q:
        ql = q.lower()
        games = [g for g in games if ql in (g.get("title") or "").lower() or ql in (g.get("opening") or {}).get("name", "").lower()]
    games.sort(key=lambda g: -(g.get("played_at") or g.get("created_at") or 0))
    total = len(games)
    page = games[max(0, offset): max(0, offset) + max(1, min(500, limit))]
    # attach live job progress
    for g in page:
        job = job_for(username, g["id"])
        if job is not None and job.status in ("queued", "running"):
            g = g.setdefault("review", {})
            g.update({"status": job.status, "progress": [job.done_moves, job.total]})
    return {"games": [public_record(g) for g in page], "total": total}


@router.post("/{username}/games")
def api_add_game(username: str, body: GameIn, request: Request):
    assert_owner(request, username)
    rec = upsert_game(username, pgn=body.pgn, initial_fen=body.initial_fen, moves=body.moves, headers=body.headers,
                      source=body.source, meta=body.meta, user_color=body.user_color, title=body.title,
                      url=body.url, time_class=body.time_class, aliases=_aliases(request))
    if body.scan_image and body.scan_image.startswith("data:image"):
        try:
            raw = base64.b64decode(body.scan_image.split(",", 1)[1])
            p = scan_path(username, rec["id"])
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(raw)
            rec = upsert_game(username, pgn=rec["pgn"], source=body.source, meta={"scan": True})
        except Exception as exc:
            log.warning("Could not store scan image: %s", exc)
    return {"game": public_record(rec, with_pgn=True)}


@router.get("/{username}/games/{game_id}")
def api_get_game(username: str, game_id: str, request: Request):
    assert_owner(request, username)
    rec = get_game(username, game_id)
    if rec is None:
        raise HTTPException(404, "Game not found in your library.")
    return {"game": public_record(rec, with_pgn=True)}


@router.delete("/{username}/games/{game_id}")
def api_delete_game(username: str, game_id: str, request: Request):
    assert_owner(request, username)
    if not delete_game(username, game_id):
        raise HTTPException(404, "Game not found in your library.")
    return {"ok": True}


@router.get("/{username}/games/{game_id}/scan")
def api_scan(username: str, game_id: str):
    p = scan_path(username, game_id)
    if not p.exists():
        raise HTTPException(404, "No scoresheet image stored for this game.")
    return FileResponse(str(p), media_type="image/jpeg")


@router.post("/{username}/reviews")
def api_start_review(username: str, body: ReviewIn, request: Request):
    assert_owner(request, username)
    return start_review(username, body.pgn, body.quality, source=body.source, meta=body.meta,
                        user_color=body.user_color, title=body.title, url=body.url, time_class=body.time_class,
                        force=body.force, aliases=_aliases(request))


@router.get("/{username}/reviews/{review_id}")
def api_get_review(username: str, review_id: str, request: Request):
    assert_owner(request, username)
    stored = read_json(review_path(username, review_id), None)
    job = job_for(username, review_id)
    if job is not None and job.status in ("queued", "running"):
        events, status = job.since(0)
        start = next((e for e in events if e["type"] == "start"), None)
        return {"status": status, "progress": [job.done_moves, job.total], "stored": stored is not None,
                "headers": (start or {}).get("headers"), "initial_fen": (start or {}).get("initial_fen"),
                "moves": [e["move"] for e in events if e["type"] == "move"]}
    if stored is None:
        raise HTTPException(404, "No review stored for this game yet.")
    rec = get_game(username, review_id)
    return {"status": "done", "review": stored, "game": public_record(rec) if rec else None}


@router.get("/{username}/reviews/{review_id}/stream")
async def api_stream_review(username: str, review_id: str, request: Request):
    job = job_for(username, review_id)
    if job is None:
        stored = read_json(review_path(username, review_id), None)
        if stored is None:
            raise HTTPException(404, "No review is running for this game.")

        async def done_only():
            yield "data: " + json.dumps({"type": "stored", "review_id": review_id}) + "\n\n"
        return StreamingResponse(done_only(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    async def generate():
        i = 0
        while True:
            events, status = job.since(i)
            for e in events:
                yield "data: " + json.dumps(e) + "\n\n"
            i += len(events)
            if status in ("done", "error") and not job.since(i)[0]:
                return
            if await request.is_disconnected():
                return
            await asyncio.sleep(0.12)
    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/{username}/lookup")
def api_lookup(username: str, body: LookupIn, request: Request):
    """Which of these games already have a stored review? (pgns are hashed the
    same way as library ids.)"""
    assert_owner(request, username)
    games = list_games(username)
    out: dict[str, dict] = {}
    keys: list[tuple[str, str]] = [(i, i) for i in body.ids]
    for idx, text in enumerate(body.pgns):
        try:
            keys.append((str(idx), game_facts(parse_pgn(text))["id"]))
        except HTTPException:
            continue
    for k, gid in keys:
        rec = games.get(gid)
        if rec:
            out[k] = {"id": gid, "review": rec.get("review"), "key_moments": rec.get("key_moments")}
    return {"found": out}
