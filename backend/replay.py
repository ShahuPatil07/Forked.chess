"""
Feature 3 — Mistake Replay Mode.

Endpoints (prefix /api/cluster):
  GET  /{username}/{cluster_id}/mistakes  — every real-game mistake in a cluster,
                                            enriched with game context
  GET  /{username}/{cluster_id}/insight   — one-sentence Groq pattern insight
                                            (top-3 positions), cached
  POST /explain                           — "why was this a mistake here?" for one
                                            position, via Groq

Cluster identity rule: clusters are matched by centroid only. The mistakes file
stores cluster_id=None (saved before Stage 2), so we reconstruct each event's
cluster at request time with ml.matching.assign_nearest. The LLM label is never
used for matching — the frontend resolves the display label from the profile.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

import chess
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ml.config import DATA_DIR
from ml.ingestion.mistake_extractor import MistakeEvent
from ml.matching import load_match_context, assign_nearest

log = logging.getLogger("forked.replay")

router = APIRouter(prefix="/api/cluster")

OUTPUT_DIR = DATA_DIR / "output"
_MISTAKE_FIELDS = set(MistakeEvent.__dataclass_fields__.keys())


# ── Helpers ───────────────────────────────────────────────────────────────────

def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _to_event(d: dict) -> MistakeEvent:
    return MistakeEvent(**{k: v for k, v in d.items() if k in _MISTAKE_FIELDS})


def _cluster_rank(clusters: list[dict], cluster_id: str) -> int:
    for i, c in enumerate(clusters):
        if str(c.get("cluster_id")) == str(cluster_id):
            return i + 1
    return 0


def _gather_cluster_mistakes(username: str, cluster_id: str) -> tuple[list[dict], int]:
    """
    Return (enriched_mistakes_sorted_by_similarity_desc, cluster_rank).
    Reconstructs cluster membership via nearest-centroid assignment.
    """
    clusters = _read_json(OUTPUT_DIR / f"{username}_clusters.json", None)
    if not clusters:
        raise HTTPException(404, "No blindspot profile found. Run analysis first.")
    if not any(str(c.get("cluster_id")) == str(cluster_id) for c in clusters):
        raise HTTPException(404, f"Cluster {cluster_id!r} not found")

    rank      = _cluster_rank(clusters, cluster_id)
    mistakes  = _read_json(OUTPUT_DIR / f"{username}_mistakes.json", [])
    game_meta = _read_json(OUTPUT_DIR / f"{username}_game_meta.json", {})

    ctx = load_match_context(username, OUTPUT_DIR)
    if ctx is None:
        raise HTTPException(503, "Cluster model unavailable (scaler/reducer missing).")

    events = [_to_event(m) for m in mistakes]
    assignments = assign_nearest(events, ctx)   # [(cluster_index, similarity)]

    # cluster_index -> cluster_id from the matcher's own cluster ordering
    out: list[dict] = []
    for src, ev, (idx, sim) in zip(mistakes, events, assignments):
        if idx < 0 or idx >= len(ctx.clusters):
            continue
        if str(ctx.clusters[idx].get("cluster_id")) != str(cluster_id):
            continue
        meta = game_meta.get(ev.game_id, {})
        out.append({
            "fen":          ev.fen,
            "move_played":  ev.move_played_uci,
            "move_played_san": ev.move_played_san,
            "best_move":    ev.best_move_uci,
            "eval_drop":    ev.eval_drop_cp,
            "threat_type":  ev.threat_type,
            "game_phase":   ev.game_phase,
            "move_number":  ev.move_number,
            "game_date":    ev.played_at_unix,
            "opponent":     meta.get("opponent", ""),
            "user_color":   meta.get("user_color", "white"),
            "time_control": meta.get("time_control", ""),
            "game_url":     meta.get("url", ""),
            "game_id":      ev.game_id,
            "similarity":   round(sim, 4),
        })

    out.sort(key=lambda m: m["similarity"], reverse=True)
    return out, rank


def _groq_client():
    from groq import Groq
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("GROQ_API_KEY not set")
    return Groq(api_key=key)


# ── GET /{username}/{cluster_id}/mistakes ─────────────────────────────────────

@router.get("/{username}/{cluster_id}/mistakes")
async def cluster_mistakes(username: str, cluster_id: str):
    loop = asyncio.get_event_loop()
    mistakes, rank = await loop.run_in_executor(
        None, lambda: _gather_cluster_mistakes(username, cluster_id)
    )
    return {"cluster_id": cluster_id, "cluster_rank": rank, "mistakes": mistakes}


# ── GET /{username}/{cluster_id}/insight ──────────────────────────────────────

def _compute_insight(username: str, cluster_id: str) -> str:
    cache_path = OUTPUT_DIR / f"{username}_insight_{cluster_id}.json"
    cached = _read_json(cache_path, None)
    if cached and cached.get("insight"):
        return cached["insight"]

    mistakes, _ = _gather_cluster_mistakes(username, cluster_id)
    if len(mistakes) < 3:
        return ""

    top3 = mistakes[:3]
    lines = []
    for i, m in enumerate(top3, 1):
        side = "White" if m["fen"].split()[1] == "w" else "Black"
        lines.append(
            f"{i}. FEN: {m['fen']} | {side} to move played {m['move_played_san']} "
            f"(best {m['best_move']}, lost {m['eval_drop']}cp, motif: {m['threat_type'].replace('_', ' ')})"
        )

    prompt = (
        "In one sentence, what do these chess positions have in common? "
        "Describe only the tactical or structural pattern visible on the board "
        "that the player keeps missing. Be concrete and specific.\n\n"
        + "\n".join(lines)
    )

    try:
        client = _groq_client()
        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=90,
        )
        insight = completion.choices[0].message.content.strip()
    except Exception as exc:
        log.warning("Insight Groq call failed: %s", exc)
        return ""

    try:
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump({"insight": insight}, fh)
    except Exception:
        pass
    return insight


@router.get("/{username}/{cluster_id}/insight")
async def cluster_insight(username: str, cluster_id: str):
    loop = asyncio.get_event_loop()
    insight = await loop.run_in_executor(
        None, lambda: _compute_insight(username, cluster_id)
    )
    return {"insight": insight}


# ── POST /note — per-position "Notice" (unique to each board) ──────────────────

class NoteRequest(BaseModel):
    fen:         str
    played:      str = ""    # SAN
    best:        str = ""    # UCI
    threat_type: str = ""


def _note_cache_path(fen: str) -> Path:
    import hashlib
    h = hashlib.md5(fen.encode("utf-8")).hexdigest()[:16]
    return OUTPUT_DIR / f"note_{h}.json"


def _compute_note(req: NoteRequest) -> str:
    """
    One-sentence "Notice:" for THIS specific position — the concrete thing the
    player overlooked. Cached per-FEN so each board has its own stable note.
    """
    cache_path = _note_cache_path(req.fen)
    cached = _read_json(cache_path, None)
    if cached and cached.get("note"):
        return cached["note"]

    side = "White" if req.fen.split()[1] == "w" else "Black"
    prompt = (
        "You are a chess coach. In ONE short sentence (max 18 words), name the "
        "single concrete thing the player overlooked in THIS position — the "
        "specific tactic, square, or threat. No preamble, no move numbers.\n\n"
        f"FEN: {req.fen}\n"
        f"Side to move: {side}\n"
        f"They played {req.played or 'a weak move'}; engine's best was {req.best}.\n"
        f"Motif: {req.threat_type.replace('_', ' ') or 'unknown'}."
    )
    try:
        client = _groq_client()
        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=60,
        )
        note = completion.choices[0].message.content.strip().strip('"')
    except Exception as exc:
        log.warning("Note Groq call failed: %s", exc)
        return ""

    try:
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump({"note": note}, fh)
    except Exception:
        pass
    return note


@router.post("/note")
async def position_note(req: NoteRequest):
    if not req.fen.strip():
        raise HTTPException(400, "fen is required")
    loop = asyncio.get_event_loop()
    note = await loop.run_in_executor(None, lambda: _compute_note(req))
    return {"note": note}


# ── POST /explain ─────────────────────────────────────────────────────────────

class ExplainRequest(BaseModel):
    fen:         str
    played:      str = ""    # SAN or UCI
    best:        str = ""    # UCI
    threat_type: str = ""
    user_elo:    Optional[int] = None


def _level(elo: Optional[int]) -> str:
    e = elo or 1500
    if e < 1000: return "a beginner"
    if e < 1400: return "a club beginner"
    if e < 1800: return "an intermediate player"
    if e < 2000: return "an advanced player"
    return "a strong player"


def _explain(req: ExplainRequest) -> str:
    side = "White" if req.fen.split()[1] == "w" else "Black"
    prompt = (
        f"You are a chess coach explaining a mistake to {_level(req.user_elo)}.\n"
        f"Position FEN: {req.fen}\n"
        f"Side to move: {side}\n"
        f"They played {req.played or 'a weak move'}; the engine's best move was {req.best}.\n"
        f"Tactical/structural motif: {req.threat_type.replace('_', ' ') or 'unknown'}.\n\n"
        "In 2-3 short sentences explain WHY the played move was a mistake and what "
        "the correct idea was. Be concrete about the pieces and squares involved. "
        "Plain prose, no move-number lists."
    )
    try:
        client = _groq_client()
        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=180,
        )
        return completion.choices[0].message.content.strip()
    except Exception as exc:
        log.warning("Explain Groq call failed: %s", exc)
        raise HTTPException(503, f"Explanation unavailable: {exc}")


@router.post("/explain")
async def explain_mistake(req: ExplainRequest):
    if not req.fen.strip():
        raise HTTPException(400, "fen is required")
    loop = asyncio.get_event_loop()
    text = await loop.run_in_executor(None, lambda: _explain(req))
    return {"explanation": text}
