"""
Forked FastAPI backend.

Run from the project root directory:
    uvicorn backend.main:app --reload --port 8000
"""
import asyncio
import json
import logging
import queue
import sys
import threading
import uuid

# On Windows + Python 3.12+, chess.engine.SimpleEngine.popen_uci() calls
# asyncio.run() internally to start Stockfish. That call creates a new event
# loop in a background thread. Without this policy set explicitly, asyncio
# sometimes creates a SelectorEventLoop (which can't spawn subprocesses on
# Windows) instead of ProactorEventLoop.  Setting it here and again inside
# each worker thread guarantees Stockfish can always be started.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent))

from ml.config import DATA_DIR, STOCKFISH_PATH

log = logging.getLogger("forked.api")

# ── Stockfish analysis singleton ──────────────────────────────────────────────

_sf_lock   = threading.Lock()
_sf_engine = None          # type: ignore[assignment]


def _ensure_engine():
    global _sf_engine
    if _sf_engine is None:
        if not STOCKFISH_PATH.exists():
            raise RuntimeError(f"Stockfish not found at {STOCKFISH_PATH}")
        import chess.engine
        _sf_engine = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH))
        log.info("Stockfish engine started for analysis endpoint")
    return _sf_engine
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")

app = FastAPI(title="Forked API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

OUTPUT_DIR = DATA_DIR / "output"


# ── Job registry ─────────────────────────────────────────────────────────────

class _Job:
    def __init__(self, job_id: str, username: str):
        self.job_id   = job_id
        self.username = username
        self.status   = "queued"   # queued | running | done | error
        self.queue: queue.Queue = queue.Queue()

_jobs: dict[str, _Job] = {}
_jobs_lock = threading.Lock()


def _get_job(job_id: str) -> _Job:
    j = _jobs.get(job_id)
    if j is None:
        raise HTTPException(404, f"Job {job_id!r} not found")
    return j


# ── Background worker ─────────────────────────────────────────────────────────

def _ingestion_worker(
    job: _Job,
    platform: str,
    min_games: int,
    api_key: Optional[str],
) -> None:
    # Re-apply on every worker thread: chess.engine spawns its own asyncio
    # background thread and asyncio.run() there must also get ProactorEventLoop.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    q = job.queue

    def _put(evt: dict) -> None:
        evt["job_id"] = job.job_id
        q.put(evt)

    try:
        job.status = "running"

        # Stage 1 — fetch + annotate
        _put({"type": "progress", "stage": "fetching", "games_done": 0,
              "games_total": min_games, "pct": 0, "message": "Fetching games..."})

        from ml.pipeline import run_ingestion

        def on_annotate(current: int, total: int, mistakes: int) -> None:
            pct = int(current / total * 80)   # 0-80% for annotation
            _put({"type": "progress", "stage": "annotating",
                  "games_done": current, "games_total": total,
                  "mistakes_found": mistakes, "pct": pct,
                  "message": f"Annotating game {current} of {total}..."})

        mistakes = run_ingestion(
            username=job.username,
            platform=platform,
            min_games=min_games,
            output_dir=OUTPUT_DIR,
            progress_callback=on_annotate,
        )

        if not mistakes:
            raise ValueError("No mistake events found. Check the username and platform.")

        # Stage 2 — clustering
        _put({"type": "progress", "stage": "clustering", "pct": 82,
              "mistakes_found": len(mistakes),
              "message": "Finding blindspot patterns..."})

        from ml.clustering.pipeline import run_clustering

        clusters = run_clustering(
            mistakes=mistakes,
            username=job.username,
            min_cluster_size=8,
            api_key=api_key,
            output_dir=OUTPUT_DIR,
        )

        if not clusters:
            raise ValueError(
                f"Analysed {len(mistakes)} mistakes but couldn't find recurring patterns. "
                "Try fetching more games (100+) or check that the username is correct."
            )

        job.status = "done"
        _put({
            "type": "done",
            "username": job.username,
            "mistakes_found": len(mistakes),
            "clusters_count": len(clusters),
            "pct": 100,
            "message": f"Done! Found {len(clusters)} blindspot patterns.",
        })

    except Exception as exc:
        log.error("Job %s failed: %s", job.job_id, exc, exc_info=True)
        job.status = "error"
        msg = str(exc) or f"{type(exc).__name__} (no details — check backend terminal)"
        _put({"type": "error", "message": msg, "pct": 0})


# ── Pydantic models ───────────────────────────────────────────────────────────

class IngestRequest(BaseModel):
    username: str
    platform: str = "lichess"
    min_games: int = 80
    api_key: Optional[str] = None


class AttemptResult(BaseModel):
    cluster_id: str
    correct: bool
    time_s: float


class AttemptsRequest(BaseModel):
    username: str
    results: list[AttemptResult]


class SettingsUpdate(BaseModel):
    elo: Optional[int] = None
    platform: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_json(path: Path, label: str) -> Any:
    if not path.exists():
        raise HTTPException(404, f"{label} not found. Run ingestion first.")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _clusters_path(username: str) -> Path:
    return OUTPUT_DIR / f"{username}_clusters.json"


def _mistakes_path(username: str) -> Path:
    return OUTPUT_DIR / f"{username}_mistakes.json"


def _settings_path(username: str) -> Path:
    return OUTPUT_DIR / f"{username}_settings.json"


def _game_meta_path(username: str) -> Path:
    return OUTPUT_DIR / f"{username}_game_meta.json"


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/api/analyse")
async def analyse_position(fen: str, depth: int = 14):
    """Run Stockfish on a FEN and return best move + evaluation."""
    def _run():
        import chess
        import chess.engine
        with _sf_lock:
            engine = _ensure_engine()
            try:
                board = chess.Board(fen)
            except ValueError as exc:
                raise RuntimeError(f"Invalid FEN: {exc}")
            info = engine.analyse(board, chess.engine.Limit(depth=depth))

        best_move: Optional[str] = None
        pv = info.get("pv", [])
        if pv:
            best_move = pv[0].uci()

        eval_cp:   Optional[int] = None
        eval_mate: Optional[int] = None
        score = info.get("score")
        if score is not None:
            pov = score.white()
            if pov.is_mate():
                eval_mate = pov.mate()
            else:
                eval_cp = pov.score()

        return {"best_move": best_move, "eval_cp": eval_cp, "eval_mate": eval_mate}

    try:
        result = await asyncio.get_event_loop().run_in_executor(None, _run)
        return result
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.get("/api/check/{username}")
def check_profile(username: str):
    return {"has_profile": _clusters_path(username).exists()}


@app.post("/api/ingest", status_code=202)
def start_ingest(req: IngestRequest):
    if not STOCKFISH_PATH.exists():
        raise HTTPException(
            500,
            "Stockfish binary not found. Run: python scripts/setup_stockfish.py"
        )
    # Check for already-running job
    with _jobs_lock:
        for j in _jobs.values():
            if j.username == req.username and j.status in ("queued", "running"):
                return {"job_id": j.job_id, "status": "already_running"}

    job = _Job(job_id=str(uuid.uuid4()), username=req.username)
    with _jobs_lock:
        _jobs[job.job_id] = job

    thread = threading.Thread(
        target=_ingestion_worker,
        args=(job, req.platform, req.min_games, req.api_key),
        daemon=True,
    )
    thread.start()
    return {"job_id": job.job_id, "status": "queued"}


@app.get("/api/ingest/status/{job_id}")
async def ingest_status(job_id: str):
    _get_job(job_id)   # validates existence

    async def _stream():
        loop = asyncio.get_event_loop()
        job = _get_job(job_id)

        while True:
            try:
                evt = await loop.run_in_executor(
                    None, lambda: job.queue.get(timeout=2)
                )
                yield f"data: {json.dumps(evt)}\n\n"
                if evt.get("type") in ("done", "error"):
                    return
            except queue.Empty:
                yield "data: {\"type\":\"heartbeat\"}\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/profile/{username}")
def get_profile(username: str):
    clusters = _load_json(_clusters_path(username), "Cluster profile")

    # Annotate rank
    for i, c in enumerate(clusters):
        c["rank"] = i + 1

    # Stats from mistakes
    try:
        mistakes = _load_json(_mistakes_path(username), "")
        threats = Counter(m["threat_type"] for m in mistakes)
        phases  = Counter(m["game_phase"]  for m in mistakes)
        n_games = len(set(m["game_id"] for m in mistakes))
        stats = {
            "total_games":       n_games,
            "total_mistakes":    len(mistakes),
            "top_threat":        threats.most_common(1)[0][0] if threats else "other",
            "threat_breakdown":  dict(threats.most_common()),
            "phase_breakdown":   dict(phases.most_common()),
        }
    except HTTPException:
        stats = {"total_games": 0, "total_mistakes": 0, "top_threat": "other",
                 "threat_breakdown": {}, "phase_breakdown": {}}

    return {"username": username, "clusters": clusters, "stats": stats}


@app.get("/api/cluster/{username}/{cluster_id}")
def get_cluster(username: str, cluster_id: str):
    clusters = _load_json(_clusters_path(username), "Cluster profile")
    c = next((x for x in clusters if str(x["cluster_id"]) == cluster_id), None)
    if c is None:
        raise HTTPException(404, f"Cluster {cluster_id!r} not found")

    try:
        mistakes = _load_json(_mistakes_path(username), "")
        c["all_events"] = [m for m in mistakes if str(m.get("cluster_id")) == cluster_id][:50]
    except HTTPException:
        c["all_events"] = []

    c["rank"] = next(
        (i + 1 for i, x in enumerate(clusters) if str(x["cluster_id"]) == cluster_id),
        0,
    )
    return c


@app.get("/api/games/{username}")
def get_games(username: str):
    mistakes = _load_json(_mistakes_path(username), "Mistakes data")

    game_meta: dict = {}
    meta_path = _game_meta_path(username)
    if meta_path.exists():
        with open(meta_path, encoding="utf-8") as fh:
            game_meta = json.load(fh)

    groups: dict[str, list] = defaultdict(list)
    for m in mistakes:
        groups[m["game_id"]].append(m)

    games = []
    for gid, evts in sorted(groups.items(),
                             key=lambda x: -(x[1][0].get("played_at_unix") or 0)):
        phases  = Counter(e["game_phase"]  for e in evts)
        threats = Counter(e["threat_type"] for e in evts)
        meta = game_meta.get(gid, {})
        url = meta.get("url", "") or f"https://lichess.org/{gid}"
        games.append({
            "game_id":          gid,
            "white_username":   meta.get("white", ""),
            "black_username":   meta.get("black", ""),
            "user_color":       meta.get("user_color", "white"),
            "opponent":         meta.get("opponent", ""),
            "time_control":     meta.get("time_control", ""),
            "played_at_unix":   evts[0].get("played_at_unix"),
            "mistake_count":    len(evts),
            "phase_breakdown":  dict(phases.most_common()),
            "top_threat":       threats.most_common(1)[0][0],
            "lichess_url":      url,
            "game_url":         url,
            "mistakes":         evts[:5],   # preview only
        })

    return {"username": username, "games": games, "total_games": len(games)}


@app.post("/api/backfill_meta/{username}")
def backfill_game_meta(username: str, platform: str = "lichess"):
    """Fetch opponent names from the public API for profiles missing game_meta.json."""
    if _game_meta_path(username).exists():
        return {"status": "already_exists"}

    mistakes = _load_json(_mistakes_path(username), "Mistakes data")
    game_ids = list({m["game_id"] for m in mistakes})

    import requests as _req

    meta: dict = {}
    if platform == "lichess":
        # Lichess batch export — up to 300 IDs per request
        from ml.config import REQUEST_HEADERS
        chunk = game_ids[:300]
        try:
            resp = _req.post(
                "https://lichess.org/api/games/export/_ids",
                data=",".join(chunk),
                headers={**REQUEST_HEADERS, "Accept": "application/x-ndjson"},
                timeout=30,
            )
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                g = json.loads(line)
                gid = g.get("id", "")
                players = g.get("players", {})
                white = players.get("white", {}).get("user", {}).get("name", "")
                black = players.get("black", {}).get("user", {}).get("name", "")
                user_color = "white" if white.lower() == username.lower() else "black"
                opponent = black if user_color == "white" else white
                clock = g.get("clock", {})
                tc_initial = clock.get("initial", 0)
                tc_inc = clock.get("increment", 0)
                meta[gid] = {
                    "white": white, "black": black,
                    "user_color": user_color, "opponent": opponent,
                    "url": f"https://lichess.org/{gid}",
                    "time_control": f"{tc_initial}+{tc_inc}" if clock else "",
                }
        except Exception as exc:
            raise HTTPException(500, f"Lichess API error: {exc}")
    else:
        raise HTTPException(400, "Backfill only supported for lichess currently.")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(_game_meta_path(username), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    return {"status": "ok", "games_filled": len(meta)}


@app.get("/api/analytics/{username}")
def get_analytics(username: str):
    mistakes = _load_json(_mistakes_path(username), "Mistakes data")

    threat_drops: dict[str, list] = defaultdict(list)
    phase_counts: Counter = Counter()
    bucket_counts: dict[int, int] = defaultdict(int)
    bucket_drops: dict[int, list] = defaultdict(list)
    scatter: list[dict] = []

    for m in mistakes:
        threat   = m.get("threat_type", "other")
        phase    = m.get("game_phase", "middlegame")
        drop     = m.get("eval_drop_cp", 0)
        move_no  = m.get("move_number", 1)

        threat_drops[threat].append(drop)
        phase_counts[phase] += 1

        bucket = ((move_no - 1) // 5) * 5 + 1   # 1, 6, 11, 16…
        bucket_counts[bucket] += 1
        bucket_drops[bucket].append(drop)

        scatter.append({"move_number": move_no, "eval_drop_cp": drop,
                        "threat_type": threat, "game_phase": phase})

    # Cap scatter to 600 points for frontend performance
    import random as _rnd
    if len(scatter) > 600:
        scatter = _rnd.sample(scatter, 600)

    threat_stats = [
        {
            "threat":    t,
            "count":     len(drops),
            "avg_drop":  round(sum(drops) / len(drops)) if drops else 0,
        }
        for t, drops in sorted(threat_drops.items(), key=lambda x: -len(x[1]))
    ]

    moves_aggregated = [
        {
            "move_bucket": b,
            "label":       f"{b}–{b+4}",
            "count":       bucket_counts[b],
            "avg_drop":    round(sum(bucket_drops[b]) / len(bucket_drops[b])) if bucket_drops[b] else 0,
        }
        for b in sorted(bucket_counts)
    ]

    phase_data = [{"phase": p, "count": c} for p, c in phase_counts.most_common()]

    return {
        "username":        username,
        "total_mistakes":  len(mistakes),
        "threat_stats":    threat_stats,
        "phase_breakdown": phase_data,
        "moves_aggregated": moves_aggregated,
        "scatter":         scatter,
    }


@app.get("/api/session/{username}")
def get_session(username: str, elo: int = 1500, n: int = 12):
    clusters_raw = _load_json(_clusters_path(username), "Cluster profile")

    try:
        from ml.puzzles.retriever import get_index
        index = get_index()
    except Exception as exc:
        raise HTTPException(503, f"Puzzle index unavailable: {exc}. "
                                  f"Run: python scripts/run_puzzle_import.py {username}")

    from ml.clustering.blindspot import BlindspotCluster

    clusters = []
    for d in clusters_raw:
        try:
            clusters.append(BlindspotCluster(**{
                k: v for k, v in d.items()
                if k in BlindspotCluster.__dataclass_fields__
            }))
        except Exception:
            pass

    from ml.srs.session import build_session
    items = build_session(username=username, clusters=clusters,
                          user_elo=elo, n_puzzles=n, due_only=False)

    session_id = str(uuid.uuid4())
    return {
        "session_id": session_id,
        "items": [
            {
                "cluster_id":    item.cluster_id,
                "cluster_label": item.cluster_label,
                "blindspot_rank": item.blindspot_rank,
                "missed_count":  item.missed_count,
                "puzzle": {
                    "puzzle_id": item.puzzle.puzzle_id,
                    "fen":       item.puzzle.fen,
                    "moves":     item.puzzle.moves,
                    "rating":    item.puzzle.rating,
                    "themes":    item.puzzle.themes,
                    "threat":    item.puzzle.threat,
                    "game_url":  item.puzzle.game_url,
                },
            }
            for item in items
        ],
    }


@app.post("/api/session/complete")
def complete_session(req: AttemptsRequest):
    from ml.srs.session import record_session_results
    record_session_results(
        req.username,
        [(r.cluster_id, r.correct, r.time_s) for r in req.results],
    )
    return {"updated_clusters": [r.cluster_id for r in req.results]}


@app.get("/api/settings/{username}")
def get_settings(username: str):
    path = _settings_path(username)
    base = {"username": username, "platform": "lichess", "elo": 1500}
    if path.exists():
        with open(path, encoding="utf-8") as fh:
            base.update(json.load(fh))
    base["has_profile"] = _clusters_path(username).exists()
    return base


@app.put("/api/settings/{username}")
def update_settings(username: str, req: SettingsUpdate):
    path = _settings_path(username)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    existing = {}
    if path.exists():
        with open(path, encoding="utf-8") as fh:
            existing = json.load(fh)
    if req.elo is not None:
        existing["elo"] = req.elo
    if req.platform is not None:
        existing["platform"] = req.platform
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(existing, fh)
    existing["username"] = username
    existing["has_profile"] = _clusters_path(username).exists()
    return existing
