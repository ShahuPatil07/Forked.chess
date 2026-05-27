"""
Pawnprint FastAPI backend.

Run from the PawnPrint root directory:
    uvicorn backend.main:app --reload --port 8000
"""
import asyncio
import json
import logging
import queue
import sys
import threading
import uuid
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

log = logging.getLogger("pawnprint.api")

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

app = FastAPI(title="Pawnprint API", version="0.1.0")

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

        job.status = "done"
        _put({
            "type": "done",
            "username": job.username,
            "mistakes_count": len(mistakes),
            "clusters_count": len(clusters),
            "pct": 100,
            "message": f"Done! Found {len(clusters)} blindspot patterns.",
        })

    except Exception as exc:
        log.error("Job %s failed: %s", job.job_id, exc, exc_info=True)
        job.status = "error"
        _put({"type": "error", "message": str(exc), "pct": 0})


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

    groups: dict[str, list] = defaultdict(list)
    for m in mistakes:
        groups[m["game_id"]].append(m)

    games = []
    for gid, evts in sorted(groups.items(),
                             key=lambda x: -(x[1][0].get("played_at_unix") or 0)):
        phases  = Counter(e["game_phase"]  for e in evts)
        threats = Counter(e["threat_type"] for e in evts)
        games.append({
            "game_id":          gid,
            "played_at_unix":   evts[0].get("played_at_unix"),
            "mistake_count":    len(evts),
            "phase_breakdown":  dict(phases.most_common()),
            "top_threat":       threats.most_common(1)[0][0],
            "lichess_url":      f"https://lichess.org/{gid}",
            "mistakes":         evts[:5],   # preview only
        })

    return {"username": username, "games": games, "total_games": len(games)}


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
