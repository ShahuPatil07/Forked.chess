"""
Endgames router.

Endpoints (all under /api/endgames):
  GET  /practice-position        — curated practice FEN by category + difficulty
  GET  /syzygy?fen=...           — Lichess tablebase lookup (cached forever)
  POST /coach/chat               — synchronous coach response
  POST /coach/chat/stream        — SSE-streamed coach response
  GET  /coach/suggestions        — quick-prompt chips (cached per category × rating)

Data:
  data/endgame.db              — populated by scripts/build_endgame_positions.py
  data/endgame_knowledge.json  — curated coach corpus
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import random
import sqlite3
import threading
from pathlib import Path
from typing import Iterator, Literal, Optional

import chess
import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ml.config import DATA_DIR, REQUEST_HEADERS

log = logging.getLogger("forked.endgames")

router = APIRouter(prefix="/api/endgames")

DB_PATH                 = DATA_DIR / "endgame.db"
KNOWLEDGE_PATH          = DATA_DIR / "endgame_knowledge.json"
SYZYGY_URL              = "https://tablebase.lichess.ovh/standard"
SYZYGY_MAX_PIECES       = 7
SUGGESTIONS_TTL_DAYS    = 7

_db_lock = threading.Lock()


# ── DB setup ──────────────────────────────────────────────────────────────────

def _init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(DB_PATH))
    # All 4 tables — matches the schema in scripts/build_endgame_positions.py.
    # We create them here too so the server starts cleanly on a fresh checkout
    # where the user hasn't run the script yet.
    con.execute("""
        CREATE TABLE IF NOT EXISTS endgame_positions (
            id TEXT PRIMARY KEY, category TEXT, difficulty TEXT,
            fen TEXT UNIQUE, objective TEXT, dtm INTEGER,
            description TEXT, active INTEGER DEFAULT 1, created_at TEXT
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS endgame_syzygy_cache (
            fen TEXT PRIMARY KEY, category TEXT, dtm INTEGER, dtz INTEGER,
            best_move TEXT, fetched_at TEXT
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS endgame_knowledge_chunks (
            id TEXT PRIMARY KEY, source TEXT, url TEXT, title TEXT,
            category TEXT, content TEXT, created_at TEXT
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS endgame_suggestions_cache (
            key TEXT PRIMARY KEY, chips TEXT, expires_at TEXT
        )
    """)
    # Columns added in v2 (by-config practice) — add idempotently for existing DBs
    for col, decl in (("source", "TEXT"), ("eval_cp", "INTEGER"), ("side_to_move", "TEXT")):
        try:
            con.execute(f"ALTER TABLE endgame_positions ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass  # column already exists
    con.commit()
    con.close()


_init_db()


def _db():
    con = sqlite3.connect(str(DB_PATH))
    con.row_factory = sqlite3.Row
    return con


# ── Knowledge corpus loader ───────────────────────────────────────────────────

_KNOWLEDGE_LOCK = threading.Lock()
_KNOWLEDGE: list[dict] = []


def _load_knowledge() -> list[dict]:
    global _KNOWLEDGE
    with _KNOWLEDGE_LOCK:
        if _KNOWLEDGE:
            return _KNOWLEDGE
        if not KNOWLEDGE_PATH.exists():
            log.warning("endgame_knowledge.json missing — coach runs without curated corpus")
            return []
        try:
            with open(KNOWLEDGE_PATH, encoding="utf-8") as fh:
                _KNOWLEDGE = json.load(fh)
            log.info("Loaded %d endgame knowledge entries", len(_KNOWLEDGE))
        except Exception as exc:
            log.warning("Failed to load endgame_knowledge.json: %s", exc)
            _KNOWLEDGE = []
        return _KNOWLEDGE


_load_knowledge()


def _knowledge_lookup(
    category:     str = "",
    user_message: str = "",
    max_entries:  int = 3,
) -> list[dict]:
    corpus = _load_knowledge()
    if not corpus:
        return []
    msg_words = {w.lower().strip(".,?!:;") for w in (user_message or "").split() if len(w) > 3}

    scored: list[tuple[int, dict]] = []
    for entry in corpus:
        score = 0
        if category and entry.get("category", "") == category:
            score += 30
        name_words = {w.lower() for w in entry.get("name", "").split() if len(w) > 2}
        score += 4 * len(msg_words & name_words)
        # Match against summary + principles keywords
        ent_blob = (
            entry.get("summary", "") + " " +
            entry.get("principles", "") + " " +
            " ".join(entry.get("themes", []))
        ).lower()
        for w in msg_words:
            if w in ent_blob:
                score += 2
        if score > 0:
            scored.append((score, entry))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [e for _, e in scored[:max_entries]]


def _format_knowledge_entry(entry: dict) -> str:
    parts = [f"{entry.get('name', '')}"]
    if entry.get("summary"):     parts.append(f"Summary: {entry['summary']}")
    if entry.get("principles"):  parts.append(f"Principles: {entry['principles']}")
    if entry.get("example"):     parts.append(f"Example: {entry['example']}")
    return "\n".join(parts)


def _collect_sources(entries: list[dict]) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for entry in entries:
        for url in entry.get("sources", []):
            if url in seen:
                continue
            seen.add(url)
            label = (
                "Wikibooks"   if "wikibooks"  in url
                else "Wikipedia" if "wikipedia" in url
                else "Chess SE"  if "stackexchange" in url
                else "archive.org" if "archive.org" in url
                else "source"
            )
            full_url = url if url.startswith("http") else "https://" + url
            out.append({"label": label, "url": full_url})
    return out


# ── ELO helpers ───────────────────────────────────────────────────────────────

def _rating_band(elo: int) -> str:
    if elo < 1000: return "beginner"
    if elo < 1400: return "club beginner"
    if elo < 1800: return "intermediate"
    if elo < 2000: return "advanced"
    return "strong"


def _user_elo(username: str) -> int:
    path = DATA_DIR / "output" / f"{username}_settings.json"
    if not path.exists():
        return 1500
    try:
        with open(path, encoding="utf-8") as fh:
            return int(json.load(fh).get("elo") or 1500)
    except Exception:
        return 1500


# ── Endpoint 1: GET /practice-position ────────────────────────────────────────

class PracticePosition(BaseModel):
    fen:          str
    category:     str
    difficulty:   str
    objective:    str
    description:  str
    dtm:          Optional[int] = None


@router.get("/practice-position", response_model=PracticePosition)
async def practice_position(
    category:     str  = "kp",
    difficulty:   str  = "beginner",
    exclude_fens: str  = "",
):
    excluded = {f.strip() for f in exclude_fens.split(",") if f.strip()}

    with _db_lock:
        con = _db()
        try:
            rows = con.execute(
                "SELECT fen, category, difficulty, objective, description, dtm "
                "FROM endgame_positions "
                "WHERE category=? AND difficulty=? AND active=1",
                (category, difficulty),
            ).fetchall()
        finally:
            con.close()

    candidates = [dict(r) for r in rows if r["fen"] not in excluded]
    if not candidates:
        # Fallback: if every position has been seen, allow repeats
        candidates = [dict(r) for r in rows]
    if not candidates:
        raise HTTPException(
            404,
            f"No active positions for category={category!r} difficulty={difficulty!r}. "
            f"Run: python scripts/build_endgame_positions.py",
        )

    pick = random.choice(candidates)
    return PracticePosition(**pick)


# ── Endpoint 2: GET /syzygy ───────────────────────────────────────────────────

class SyzygyResponse(BaseModel):
    fen:        str
    category:   Optional[str]  = None    # win | loss | draw | cursed-win | blessed-loss | unknown
    dtm:        Optional[int]  = None
    dtz:        Optional[int]  = None
    best_move:  Optional[str]  = None
    cached:     bool           = False
    available:  bool           = True    # False if position has >7 pieces


def _syzygy_cache_get(fen: str) -> Optional[SyzygyResponse]:
    with _db_lock:
        con = _db()
        try:
            row = con.execute(
                "SELECT * FROM endgame_syzygy_cache WHERE fen=?", (fen,)
            ).fetchone()
        finally:
            con.close()
    if row is None:
        return None
    return SyzygyResponse(
        fen=fen, category=row["category"], dtm=row["dtm"],
        dtz=row["dtz"], best_move=row["best_move"], cached=True,
    )


def _syzygy_cache_set(fen: str, data: dict) -> None:
    moves = data.get("moves") or []
    best  = moves[0].get("uci") if moves else None
    with _db_lock:
        con = _db()
        try:
            con.execute(
                "INSERT OR REPLACE INTO endgame_syzygy_cache "
                "(fen, category, dtm, dtz, best_move, fetched_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (fen, data.get("category"), data.get("dtm"), data.get("dtz"),
                 best, dt.datetime.utcnow().isoformat()),
            )
            con.commit()
        finally:
            con.close()


def _fetch_syzygy_sync(fen: str) -> SyzygyResponse:
    # Skip if too many pieces — Syzygy only covers ≤7
    try:
        if chess.Board(fen).occupied.bit_count() > SYZYGY_MAX_PIECES:
            return SyzygyResponse(fen=fen, available=False)
    except Exception:
        raise HTTPException(400, f"Invalid FEN: {fen}")

    cached = _syzygy_cache_get(fen)
    if cached is not None:
        return cached

    try:
        resp = requests.get(SYZYGY_URL, params={"fen": fen}, headers=REQUEST_HEADERS, timeout=8)
        if resp.status_code == 404:
            # Position not in tablebase
            return SyzygyResponse(fen=fen, available=False)
        resp.raise_for_status()
        data = resp.json()
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("Syzygy fetch failed for %s: %s", fen[:40], exc)
        raise HTTPException(503, f"Syzygy tablebase unavailable: {exc}")

    _syzygy_cache_set(fen, data)
    moves = data.get("moves") or []
    return SyzygyResponse(
        fen=fen,
        category=data.get("category"),
        dtm=data.get("dtm"),
        dtz=data.get("dtz"),
        best_move=moves[0]["uci"] if moves else None,
        cached=False,
    )


@router.get("/syzygy", response_model=SyzygyResponse)
async def get_syzygy(fen: str):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _fetch_syzygy_sync(fen))


# ── Coach context builder ─────────────────────────────────────────────────────

def _build_coach_context(
    message:  str,
    fen:      str,
    category: str,
    elo:      int,
) -> tuple[str, list[dict], Optional[SyzygyResponse]]:
    """Build the LLM context. Returns (context_str, knowledge_used, syzygy_result)."""
    knowledge_used = _knowledge_lookup(category=category, user_message=message, max_entries=3)
    corpus_block = ""
    if knowledge_used:
        corpus_block = (
            "\nCurated endgame literature (use these as your grounded reference):\n"
            + "\n\n".join(_format_knowledge_entry(e) for e in knowledge_used)
            + "\n"
        )

    syzygy_block = ""
    syzygy_result: Optional[SyzygyResponse] = None
    if fen:
        try:
            board = chess.Board(fen)
            if board.is_valid() and board.occupied.bit_count() <= SYZYGY_MAX_PIECES:
                try:
                    syzygy_result = _fetch_syzygy_sync(fen)
                except HTTPException:
                    syzygy_result = None
                if syzygy_result and syzygy_result.available and syzygy_result.category:
                    side = "White" if board.turn == chess.WHITE else "Black"
                    cat  = syzygy_result.category
                    cat_verbal = {
                        "win":           f"{side} wins (verified)",
                        "loss":          f"{side} loses (verified)",
                        "draw":          "Drawn (verified)",
                        "cursed-win":    f"{side} wins but 50-move rule applies",
                        "blessed-loss":  f"{side} loses but 50-move rule applies",
                    }.get(cat, cat)
                    dtm_str = f", DTM = {syzygy_result.dtm}" if syzygy_result.dtm is not None else ""
                    bm = f", best move {syzygy_result.best_move}" if syzygy_result.best_move else ""
                    syzygy_block = (
                        f"\nSyzygy tablebase (mathematically verified, ≤7 pieces):\n"
                        f"  Result: {cat_verbal}{dtm_str}{bm}\n"
                    )
        except Exception:
            pass

    fen_block = ""
    if fen:
        fen_block = f"\nCurrent position (for context, optional):\n  FEN: {fen}\n"
        if category:
            fen_block += f"  Category: {category}\n"

    context = (
        f"User rating: {elo} ({_rating_band(elo)})\n"
        f"{fen_block}{syzygy_block}{corpus_block}"
    ).strip()
    return context, knowledge_used, syzygy_result


SYSTEM_PROMPT = """You are Forked's endgame coach: practical, technical, and concrete.

SCOPE: endgame theory only. If the user asks about openings, tactics in non-
endgame middlegame positions, or anything off-topic, reply exactly:
"I specialise in endgame theory — for opening questions, the Opening Coach
would serve you better."

GROUND every answer in the supplied context (Syzygy tablebase, curated
endgame literature, position FEN). Do not invent forced lines, mate-in-N
claims, or piece configurations not in the context.

When Syzygy data is provided, treat it as MATHEMATICAL FACT — "this is a
draw" or "White wins in N", not "looks like". Cite tablebase results
explicitly.

Adapt depth to the user's rating: beginners get simple plans and key
squares; intermediate gets the technique step by step; strong players get
the defensive resources, key sub-variations, and zugzwang patterns.

Tie advice to concrete endgame ideas: key squares, opposition,
triangulation, key tempo, fortress, building the bridge, Tarrasch's rule,
etc. Use SAN move notation where moves are specified.

Keep answers compact: 2-5 short paragraphs. Plain prose, no bullet points."""


def _build_messages(message: str, context: str, history: list[dict]) -> list[dict]:
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}]
    for h in (history or [])[-8:]:
        content = (h.get("content") or "").strip()
        if content:
            role = h.get("role", "user")
            msgs.append({"role": role, "content": content[:1800]})
    msgs.append({
        "role": "user",
        "content": (
            "Endgame context:\n"
            f"{context}\n\n"
            "User question:\n"
            f"{message.strip()}"
        ),
    })
    return msgs


def _groq_client():
    from groq import Groq
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY not set")
    return Groq(api_key=api_key)


def _call_groq_sync(message: str, context: str, history: list[dict]) -> str:
    client = _groq_client()
    completion = client.chat.completions.create(
        model       = "llama-3.3-70b-versatile",
        messages    = _build_messages(message, context, history),
        temperature = 0.35,
        max_tokens  = 760,
    )
    return completion.choices[0].message.content.strip()


def _stream_groq(message: str, context: str, history: list[dict]) -> Iterator[str]:
    client = _groq_client()
    stream = client.chat.completions.create(
        model       = "llama-3.3-70b-versatile",
        messages    = _build_messages(message, context, history),
        temperature = 0.35,
        max_tokens  = 760,
        stream      = True,
    )
    for chunk in stream:
        try:
            delta = chunk.choices[0].delta.content
        except Exception:
            delta = None
        if delta:
            yield delta


# ── Endpoint 3: POST /coach/chat (+ /stream) ─────────────────────────────────

class CoachChatMessage(BaseModel):
    role:    Literal["user", "assistant"]
    content: str


class CoachChatRequest(BaseModel):
    username:        str
    message:         str
    fen:             str                       = ""
    category:        str                       = ""
    chat_history:    list[CoachChatMessage]    = []


class CoachSource(BaseModel):
    label: str
    url:   str


class CoachChatResponse(BaseModel):
    answer:           str
    elo:              int
    rating_band:      str
    sources:          list[CoachSource]
    syzygy_verified:  bool


@router.post("/coach/chat", response_model=CoachChatResponse)
async def coach_chat(req: CoachChatRequest):
    if not req.username.strip():
        raise HTTPException(400, "username is required")
    if not req.message.strip():
        raise HTTPException(400, "message is required")

    elo = _user_elo(req.username)
    loop = asyncio.get_event_loop()

    try:
        context, knowledge_used, syzygy = await loop.run_in_executor(
            None, lambda: _build_coach_context(req.message, req.fen, req.category, elo)
        )
    except HTTPException:
        raise

    history = [m.model_dump() for m in req.chat_history]
    try:
        answer = await loop.run_in_executor(
            None, lambda: _call_groq_sync(req.message, context, history)
        )
    except Exception as exc:
        log.error("Endgame coach Groq call failed: %s", exc)
        raise HTTPException(503, f"Coach unavailable: {exc}")

    sources = _collect_sources(knowledge_used)
    return CoachChatResponse(
        answer          = answer,
        elo             = elo,
        rating_band     = _rating_band(elo),
        sources         = [CoachSource(**s) for s in sources],
        syzygy_verified = bool(syzygy and syzygy.available and syzygy.category),
    )


@router.post("/coach/chat/stream")
async def coach_chat_stream(req: CoachChatRequest):
    if not req.username.strip():
        raise HTTPException(400, "username is required")
    if not req.message.strip():
        raise HTTPException(400, "message is required")

    elo = _user_elo(req.username)
    loop = asyncio.get_event_loop()

    try:
        context, knowledge_used, syzygy = await loop.run_in_executor(
            None, lambda: _build_coach_context(req.message, req.fen, req.category, elo)
        )
    except HTTPException as exc:
        async def _err():
            yield f"data: {json.dumps({'type': 'error', 'message': exc.detail})}\n\n"
        return StreamingResponse(_err(), media_type="text/event-stream")

    sources = _collect_sources(knowledge_used)
    history = [m.model_dump() for m in req.chat_history]

    async def event_stream():
        meta = {
            "type":            "meta",
            "elo":             elo,
            "rating_band":     _rating_band(elo),
            "sources":         sources,
            "syzygy_verified": bool(syzygy and syzygy.available and syzygy.category),
            "syzygy":          syzygy.model_dump() if syzygy else None,
        }
        yield f"data: {json.dumps(meta)}\n\n"

        queue: asyncio.Queue = asyncio.Queue()

        def producer():
            try:
                for chunk in _stream_groq(req.message, context, history):
                    asyncio.run_coroutine_threadsafe(
                        queue.put({"type": "token", "text": chunk}), loop)
            except Exception as exc:
                asyncio.run_coroutine_threadsafe(
                    queue.put({"type": "error", "message": str(exc)}), loop)
            finally:
                asyncio.run_coroutine_threadsafe(queue.put({"type": "done"}), loop)

        loop.run_in_executor(None, producer)

        while True:
            evt = await queue.get()
            yield f"data: {json.dumps(evt)}\n\n"
            if evt["type"] in ("done", "error"):
                break

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Endpoint 4: GET /coach/suggestions ────────────────────────────────────────

class CoachSuggestResponse(BaseModel):
    category:    str
    rating_band: str
    chips:       list[str]


_FALLBACK_GENERAL = [
    "How to play the Lucena position?",
    "When is K+B+N vs K a draw?",
    "Explain the Philidor position",
    "Rook endgame principles",
]

_FALLBACK_BY_CATEGORY = {
    "kp":     ["What is the rule of the square?", "How does opposition work?",
               "When is K+P vs K a draw?", "Explain key squares"],
    "kr":     ["Lucena vs Philidor difference?", "Building the bridge step by step",
               "Tarrasch's rule explained", "Where should my rook go?"],
    "kq":     ["K+Q vs K mate technique", "When is K+Q vs K+P a draw?",
               "Watch for stalemate traps", "How to confine the king?"],
    "kminor": ["B+N mate corner colour rule", "How to mate with two bishops?",
               "Why are two knights drawn?", "B+N — the W manoeuvre"],
    "rook":   ["Active vs passive rook?", "Rook on the 7th rank ideas",
               "Symmetric rook ending — drawing?", "Outside passer with rooks"],
    "minor":  ["Bishop or knight — which is better?", "Opposite-colour bishops draw",
               "What is a bad bishop?", "Good/bad bishop concept"],
    "pawn":   ["How does triangulation work?", "Pawn breakthrough technique",
               "Outside passed pawn idea", "Mutual zugzwang basics"],
}


def _suggestions_cache_get(category: str, band: str) -> Optional[list[str]]:
    key = f"{category}|{band}"
    with _db_lock:
        con = _db()
        try:
            row = con.execute(
                "SELECT chips, expires_at FROM endgame_suggestions_cache WHERE key=?", (key,)
            ).fetchone()
        finally:
            con.close()
    if not row:
        return None
    if dt.datetime.fromisoformat(row["expires_at"]) < dt.datetime.utcnow():
        return None
    try:
        return json.loads(row["chips"])
    except Exception:
        return None


def _suggestions_cache_set(category: str, band: str, chips: list[str]) -> None:
    key = f"{category}|{band}"
    expires = (dt.datetime.utcnow() + dt.timedelta(days=SUGGESTIONS_TTL_DAYS)).isoformat()
    with _db_lock:
        con = _db()
        try:
            con.execute(
                "INSERT OR REPLACE INTO endgame_suggestions_cache (key, chips, expires_at) "
                "VALUES (?, ?, ?)",
                (key, json.dumps(chips), expires),
            )
            con.commit()
        finally:
            con.close()


def _generate_chips(category: str, band: str) -> list[str]:
    fallback = _FALLBACK_BY_CATEGORY.get(category, _FALLBACK_GENERAL)
    try:
        client = _groq_client()
    except Exception:
        return fallback

    if category:
        cat_label = {
            "kp": "King + Pawn endings", "kr": "King + Rook endings",
            "kq": "King + Queen endings", "kminor": "King + Minor Piece endings",
            "rook": "Rook endings (with pawns)", "minor": "Minor piece endings",
            "pawn": "Pawn endings",
        }.get(category, category)
        prompt = (
            f"For a {band} player studying {cat_label}, give EXACTLY 4 very short "
            f"distinct questions they would ask their endgame coach. Each 3-8 words. "
            f"One per line, no numbering, no quotes."
        )
    else:
        prompt = (
            f"For a {band} player studying endgames, give EXACTLY 4 very short "
            f"distinct questions they would ask. Each 3-8 words. One per line, "
            f"no numbering, no quotes."
        )

    try:
        completion = client.chat.completions.create(
            model       = "llama-3.3-70b-versatile",
            messages    = [{"role": "user", "content": prompt}],
            temperature = 0.6,
            max_tokens  = 120,
        )
        text  = completion.choices[0].message.content.strip()
        chips = [line.strip(" -•*\"'") for line in text.splitlines() if line.strip()]
        chips = [c for c in chips if 6 <= len(c) <= 80][:4]
        return chips if len(chips) == 4 else fallback
    except Exception as exc:
        log.warning("Coach suggestions Groq call failed: %s", exc)
        return fallback


@router.get("/coach/suggestions", response_model=CoachSuggestResponse)
async def coach_suggestions(
    category: str          = "",
    elo:      Optional[int] = None,
):
    band = _rating_band(elo or 1500)
    cache_key_cat = category.strip() or "general"

    cached = _suggestions_cache_get(cache_key_cat, band)
    if cached:
        return CoachSuggestResponse(category=category, rating_band=band, chips=cached)

    loop = asyncio.get_event_loop()
    chips = await loop.run_in_executor(
        None, lambda: _generate_chips(category, band)
    )
    _suggestions_cache_set(cache_key_cat, band, chips)
    return CoachSuggestResponse(category=category, rating_band=band, chips=chips)


# ══════════════════════════════════════════════════════════════════════════════
#  Practice position by material configuration
#  POST /api/endgames/practice-position/by-config
#
#  Sourcing priority:
#    1. Lichess puzzle DB — endgame-themed puzzles matching the exact material
#    2. Stockfish-filtered generation — for rare/unavailable configurations
#  Every served position is enriched with a Stockfish depth-12 eval so the
#  auto-description and complexity rating are accurate.
# ══════════════════════════════════════════════════════════════════════════════

PIECE_ORDER  = ["Q", "R", "B", "N", "P"]
PIECE_MAX    = {"Q": 1, "R": 2, "B": 2, "N": 2, "P": 8}
MAX_PER_SIDE = 7
GEN_EVAL_DEPTH     = 12
GEN_SCREEN_DEPTH   = 8
GEN_MAX_ATTEMPTS   = 40
GEN_EVAL_BUDGET    = 14

_EG_PUZZLE_THEMES = {
    "endgame", "rookEndgame", "pawnEndgame", "queenEndgame",
    "bishopEndgame", "knightEndgame", "queenRookEndgame", "promotion",
}

# Lazy material index over endgame-themed puzzles: list of (wsig, bsig, meta)
_PUZZLE_MAT_INDEX: Optional[list[tuple]] = None
_PUZZLE_INDEX_LOCK = threading.Lock()


def _zero_sig() -> dict[str, int]:
    return {k: 0 for k in PIECE_ORDER}


def _material_sig(fen: str) -> tuple[dict[str, int], dict[str, int]]:
    """Count non-king pieces per side directly from the FEN placement field."""
    placement = fen.split()[0]
    w, b = _zero_sig(), _zero_sig()
    for ch in placement:
        if ch in "QRBNP":
            w[ch] += 1
        elif ch in "qrbnp":
            b[ch.upper()] += 1
    return w, b


def _sig_tuple(d: dict[str, int]) -> tuple:
    return tuple(d[k] for k in PIECE_ORDER)


def _clamp_config(d: dict[str, int]) -> dict[str, int]:
    out = _zero_sig()
    for k in PIECE_ORDER:
        out[k] = max(0, min(int(d.get(k, 0) or 0), PIECE_MAX[k]))
    # Enforce total non-king cap
    while sum(out.values()) > MAX_PER_SIDE:
        for k in ("P", "N", "B", "R", "Q"):
            if out[k] > 0:
                out[k] -= 1
                break
    return out


def _mat_label(d: dict[str, int]) -> str:
    parts = ["K"]
    for k in PIECE_ORDER:
        n = d[k]
        if n == 1:
            parts.append(k)
        elif n > 1:
            parts.append(f"{n}{k}")
    return "+".join(parts)


def _parse_config_text(text: str) -> tuple[dict[str, int], dict[str, int]]:
    """Map a vague description to a material configuration (simple keywords)."""
    t = (text or "").lower()
    w, b = _zero_sig(), _zero_sig()

    # Specific compound phrases first
    if "queen pawn" in t or "queen and pawn" in t:
        w["Q"], w["P"], b["Q"], b["P"] = 1, 2, 1, 1
        return w, b
    if "rook pawn" in t:
        w["R"], w["P"], b["R"], b["P"] = 1, 2, 1, 1
        return w, b
    if "knight" in t and "bishop" in t:
        w["N"], b["B"] = 1, 1
        return w, b
    if "pawn ending" in t or "pawn endgame" in t or t.strip() == "pawn":
        w["P"], b["P"] = 2, 2
        return w, b

    matched = False
    if "rook" in t:   w["R"] = 1; b["R"] = 1; matched = True
    if "queen" in t:  w["Q"] = 1; b["Q"] = 1; matched = True
    if "bishop" in t: w["B"] = 1; b["B"] = 1; matched = True
    if "knight" in t: w["N"] = 1; b["N"] = 1; matched = True
    if "pawn" in t:   w["P"] = max(w["P"], 2); b["P"] = max(b["P"], 2); matched = True

    if not matched:
        w["R"], b["R"] = 1, 1   # default: most common endgame type
    return w, b


def _puzzle_index() -> list[tuple]:
    global _PUZZLE_MAT_INDEX
    if _PUZZLE_MAT_INDEX is not None:
        return _PUZZLE_MAT_INDEX
    with _PUZZLE_INDEX_LOCK:
        if _PUZZLE_MAT_INDEX is not None:
            return _PUZZLE_MAT_INDEX
        meta_path = DATA_DIR / "puzzles" / "meta.json"
        if not meta_path.exists():
            log.warning("Puzzle meta.json not found — by-config falls back to generation")
            _PUZZLE_MAT_INDEX = []
            return _PUZZLE_MAT_INDEX
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception as exc:
            log.warning("Failed to read puzzle meta.json: %s", exc)
            _PUZZLE_MAT_INDEX = []
            return _PUZZLE_MAT_INDEX

        out: list[tuple] = []
        for m in meta:
            themes = set((m.get("themes") or "").split())
            if not (_EG_PUZZLE_THEMES & themes):
                continue
            try:
                w, b = _material_sig(m["fen"])
            except Exception:
                continue
            out.append((_sig_tuple(w), _sig_tuple(b), m))
        _PUZZLE_MAT_INDEX = out
        log.info("Built endgame puzzle material index: %d positions", len(out))
        return _PUZZLE_MAT_INDEX


def _puzzle_practice_fen(m: dict) -> str:
    """Apply the puzzle's trigger move so the solver (the side to train) is to move."""
    board = chess.Board(m["fen"])
    mv = (m.get("moves") or "").split()
    if mv:
        try:
            board.push_uci(mv[0])
        except Exception:
            pass
    return board.fen()


def _sf_analyse(fen: str, depth: int = GEN_EVAL_DEPTH) -> dict:
    """Stockfish analysis reusing the main app's engine singleton."""
    from backend.main import _sf_lock, _ensure_engine
    import chess.engine

    board   = chess.Board(fen)
    n_legal = board.legal_moves.count()
    with _sf_lock:
        engine = _ensure_engine()
        info   = engine.analyse(board, chess.engine.Limit(depth=depth))

    score = info.get("score")
    pv    = info.get("pv") or []
    eval_cp = mate = None
    if score is not None:
        pov = score.white()
        if pov.is_mate():
            mate = pov.mate()
        else:
            eval_cp = pov.score()
    return {"eval_cp": eval_cp, "mate": mate, "pv_len": len(pv), "n_legal": n_legal}


def _describe_position(
    w: dict[str, int], b: dict[str, int],
    eval_cp: Optional[int], mate: Optional[int],
) -> str:
    type_name = f"{_mat_label(w)} vs {_mat_label(b)}"
    if mate is not None:
        winner = "White" if mate > 0 else "Black"
        return f"{type_name} — forced mate for {winner}"
    cp = eval_cp if eval_cp is not None else 0
    a  = abs(cp)
    winner = "White" if cp > 0 else "Black"
    if a < 100:
        return f"{type_name} — accurate play required"
    if a < 200:
        return f"{type_name} — {winner} has a slight edge, convert precisely"
    if a < 400:
        return f"{type_name} — {winner} is better, find the winning plan"
    return f"{type_name} — {winner} has a winning advantage"


def _complexity(pv_len: int, n_legal: int) -> str:
    return "high" if (pv_len > 8 and n_legal > 15) else "moderate"


def _random_position(w: dict[str, int], b: dict[str, int]) -> Optional[str]:
    """Place the requested material on random legal squares. Returns a FEN or None."""
    import random as _r
    squares = list(range(64))
    _r.shuffle(squares)
    board = chess.Board(None)

    pieces: list[tuple[int, bool]] = [(chess.KING, True), (chess.KING, False)]
    type_map = {"Q": chess.QUEEN, "R": chess.ROOK, "B": chess.BISHOP, "N": chess.KNIGHT, "P": chess.PAWN}
    for sym in PIECE_ORDER:
        pieces += [(type_map[sym], True)]  * w[sym]
        pieces += [(type_map[sym], False)] * b[sym]

    if len(pieces) > len(squares):
        return None

    used: set[int] = set()
    si = 0
    for ptype, color in pieces:
        # Pawns cannot be on rank 1 or 8
        placed = False
        while si < len(squares):
            sq = squares[si]; si += 1
            if sq in used:
                continue
            if ptype == chess.PAWN and (chess.square_rank(sq) in (0, 7)):
                continue
            used.add(sq)
            board.set_piece_at(sq, chess.Piece(ptype, color))
            placed = True
            break
        if not placed:
            return None

    board.turn = _r.choice([chess.WHITE, chess.BLACK])
    wk, bk = board.king(chess.WHITE), board.king(chess.BLACK)
    if wk is None or bk is None or chess.square_distance(wk, bk) <= 1:
        return None
    if not board.is_valid():
        return None
    return board.fen()


def _generate_instructive(w: dict[str, int], b: dict[str, int], exclude: set[str]) -> Optional[dict]:
    """Generate a balanced, non-trivial position matching the material. Slow path."""
    candidates: list[tuple[int, str, dict]] = []   # (pv_len, fen, analysis)
    evals_done = 0
    for _ in range(GEN_MAX_ATTEMPTS):
        if evals_done >= GEN_EVAL_BUDGET:
            break
        fen = _random_position(w, b)
        if fen is None or fen in exclude:
            continue
        a = _sf_analyse(fen, depth=GEN_SCREEN_DEPTH)
        evals_done += 1
        if a["mate"] is not None:
            continue                                   # trivially decided
        cp = a["eval_cp"] if a["eval_cp"] is not None else 9999
        if abs(cp) > 450:
            continue                                   # too one-sided
        if a["n_legal"] < 8 or a["pv_len"] < 6:
            continue                                   # too forced / trivial
        candidates.append((a["pv_len"], fen, a))

    if not candidates:
        return None
    # Rank: longest PV first, then closest to equal
    candidates.sort(key=lambda c: (-c[0], abs(c[2]["eval_cp"] or 0)))
    pv_len, fen, _a = candidates[0]
    final = _sf_analyse(fen, depth=GEN_EVAL_DEPTH)     # confirm at full depth
    return {"fen": fen, **final}


def _cache_position(fen: str, w: dict[str, int], b: dict[str, int],
                    source: str, eval_cp: Optional[int], side_to_move: str) -> None:
    try:
        with _db_lock:
            con = _db()
            try:
                con.execute(
                    "INSERT OR IGNORE INTO endgame_positions "
                    "(id, category, difficulty, fen, objective, dtm, description, active, created_at, source, eval_cp, side_to_move) "
                    "VALUES (?, 'custom', 'custom', ?, '', NULL, ?, 1, ?, ?, ?, ?)",
                    (
                        f"cfg-{abs(hash(fen)) % (10**12)}",
                        fen,
                        f"{_mat_label(w)} vs {_mat_label(b)}",
                        dt.datetime.utcnow().isoformat(),
                        source, eval_cp, side_to_move,
                    ),
                )
                con.commit()
            finally:
                con.close()
    except Exception as exc:
        log.info("Could not cache config position: %s", exc)


class ByConfigRequest(BaseModel):
    white_pieces: dict[str, int]  = {}
    black_pieces: dict[str, int]  = {}
    description:  str             = ""
    exclude_fens: list[str]       = []
    maia_elo:     int             = 1500


class ByConfigResponse(BaseModel):
    fen:           str
    description:   str
    source:        str            # "puzzle_db" | "generated"
    eval_cp:       Optional[int]
    complexity:    str
    syzygy_result: Optional[str]
    side_to_move:  str
    material:      str


def _resolve_config(req: ByConfigRequest) -> tuple[dict[str, int], dict[str, int]]:
    provided_total = sum(req.white_pieces.values()) + sum(req.black_pieces.values())
    if provided_total > 0:
        w = _clamp_config(req.white_pieces)
        b = _clamp_config(req.black_pieces)
    elif req.description.strip():
        w, b = _parse_config_text(req.description)
        w, b = _clamp_config(w), _clamp_config(b)
    else:
        w, b = {"R": 1, **{k: 0 for k in PIECE_ORDER if k != "R"}}, {"R": 1, **{k: 0 for k in PIECE_ORDER if k != "R"}}

    if sum(w.values()) + sum(b.values()) == 0:
        w["R"], b["R"] = 1, 1   # never empty
    return w, b


def _solve_by_config(req: ByConfigRequest) -> ByConfigResponse:
    w, b = _resolve_config(req)
    wsig, bsig = _sig_tuple(w), _sig_tuple(b)
    exclude = set(req.exclude_fens or [])

    chosen_fen: Optional[str] = None
    source = "generated"

    # ── Priority 1: puzzle DB exact material match (either colour orientation) ──
    index = _puzzle_index()
    if index:
        matches = [
            m for (pw, pb, m) in index
            if (pw == wsig and pb == bsig) or (pw == bsig and pb == wsig)
        ]
        import random as _r
        _r.shuffle(matches)
        for m in matches[:60]:
            fen = _puzzle_practice_fen(m)
            if fen in exclude:
                continue
            # Verify material survived the trigger move (no capture/promotion drift)
            pw, pb = _material_sig(fen)
            if (_sig_tuple(pw), _sig_tuple(pb)) not in ((wsig, bsig), (bsig, wsig)):
                continue
            chosen_fen = fen
            source = "puzzle_db"
            break

    # ── Priority 2: Stockfish-filtered generation ──────────────────────────────
    if chosen_fen is None:
        gen = _generate_instructive(w, b, exclude)
        if gen is None:
            raise HTTPException(
                503,
                "Couldn't find or generate an instructive position for that "
                "configuration. Try a more common material balance.",
            )
        chosen_fen = gen["fen"]
        source = "generated"

    # ── Enrich with full-depth eval ────────────────────────────────────────────
    analysis = _sf_analyse(chosen_fen, depth=GEN_EVAL_DEPTH)
    board = chess.Board(chosen_fen)
    side_to_move = "white" if board.turn == chess.WHITE else "black"

    # Material from the actual served position (orientation may be mirrored)
    aw, ab = _material_sig(chosen_fen)

    # ── Syzygy (best-effort, only ≤7 pieces) ───────────────────────────────────
    syzygy_result: Optional[str] = None
    try:
        if board.occupied.bit_count() <= SYZYGY_MAX_PIECES:
            sz = _fetch_syzygy_sync(chosen_fen)
            if sz.available and sz.category:
                syzygy_result = sz.category
    except Exception:
        pass

    _cache_position(chosen_fen, aw, ab, source, analysis["eval_cp"], side_to_move)

    return ByConfigResponse(
        fen           = chosen_fen,
        description   = _describe_position(aw, ab, analysis["eval_cp"], analysis["mate"]),
        source        = source,
        eval_cp       = analysis["eval_cp"],
        complexity    = _complexity(analysis["pv_len"], analysis["n_legal"]),
        syzygy_result = syzygy_result,
        side_to_move  = side_to_move,
        material      = f"{_mat_label(aw)} vs {_mat_label(ab)}",
    )


@router.post("/practice-position/by-config", response_model=ByConfigResponse)
async def practice_position_by_config(req: ByConfigRequest):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _solve_by_config(req))
