"""
Opening coach chat router.

This endpoint builds a compact, position-specific context from the user's
opening explorer position, Lichess statistics, Stockfish, and rating, then
asks Groq for a practical coaching answer.

Adds in v2:
  - Curated opening_knowledge.json corpus injected as grounded source
  - SSE streaming of Groq tokens
  - Position-specific suggestion chips endpoint (cached per ECO + ELO bucket)
  - Source attribution returned alongside answer
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
from typing import Iterator, Literal, Optional

import chess
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.openings import (
    DB_PATH as OPENING_DB_PATH,
    START_FEN,
    _elo_bucket_label,
    _fetch_lichess,
    _normalise_explorer_position,
    _run_stockfish,
)
from ml.config import DATA_DIR

log = logging.getLogger("forked.opening_chat")

router = APIRouter(prefix="/api/openings")

OUTPUT_DIR        = DATA_DIR / "output"
KNOWLEDGE_PATH    = DATA_DIR / "opening_knowledge.json"
MAX_CHAT_HISTORY  = 8
MAX_TOP_MOVES     = 8
MAX_SUBTREES      = 3
SUGGESTIONS_TTL_D = 7


# ── Knowledge corpus ──────────────────────────────────────────────────────────

_KNOWLEDGE_LOCK = threading.Lock()
_KNOWLEDGE: list[dict] = []


def _load_knowledge() -> list[dict]:
    global _KNOWLEDGE
    with _KNOWLEDGE_LOCK:
        if _KNOWLEDGE:
            return _KNOWLEDGE
        if not KNOWLEDGE_PATH.exists():
            log.warning("opening_knowledge.json missing — coach runs without curated corpus")
            _KNOWLEDGE = []
            return _KNOWLEDGE
        try:
            with open(KNOWLEDGE_PATH, encoding="utf-8") as fh:
                _KNOWLEDGE = json.load(fh)
            log.info("Loaded %d opening knowledge entries", len(_KNOWLEDGE))
        except Exception as exc:
            log.warning("Failed to load opening_knowledge.json: %s", exc)
            _KNOWLEDGE = []
        return _KNOWLEDGE


_load_knowledge()


def _knowledge_lookup(
    eco: str = "",
    opening_name: str = "",
    user_message: str = "",
    max_entries: int = 3,
) -> list[dict]:
    """
    Find up to `max_entries` corpus entries relevant to the query.
    Priority: exact ECO match > name overlap > keyword overlap in message.
    """
    corpus = _load_knowledge()
    if not corpus:
        return []

    eco_clean   = (eco or "").upper().strip()
    name_words  = {w.lower() for w in (opening_name or "").split() if len(w) > 2}
    msg_words   = {w.lower().strip(".,?!") for w in (user_message or "").split() if len(w) > 3}

    scored: list[tuple[int, dict]] = []
    for entry in corpus:
        score = 0
        if eco_clean and entry.get("eco", "").upper() == eco_clean:
            score += 50
        entry_name_words = {w.lower() for w in entry.get("name", "").split() if len(w) > 2}
        score += 5 * len(name_words & entry_name_words)
        score += 2 * len(msg_words & entry_name_words)
        # Theme keyword overlap
        themes = " ".join(entry.get("themes", [])).lower().split()
        score += len(msg_words & set(themes))
        if score > 0:
            scored.append((score, entry))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [entry for _, entry in scored[:max_entries]]


def _format_knowledge_entry(entry: dict) -> str:
    name   = entry.get("name", "")
    eco    = entry.get("eco", "")
    plans_w = entry.get("plans_white", "")
    plans_b = entry.get("plans_black", "")
    traps   = entry.get("traps", [])
    themes  = entry.get("themes", [])

    parts = [f"{name} ({eco})"]
    if themes:
        parts.append(f"Themes: {', '.join(themes)}")
    if plans_w:
        parts.append(f"White's plans: {plans_w}")
    if plans_b:
        parts.append(f"Black's plans: {plans_b}")
    if traps:
        parts.append(f"Tactical motifs: {'; '.join(traps)}")
    return "\n".join(parts)


def _collect_sources(entries: list[dict]) -> list[dict]:
    """Flatten source URLs across entries, de-dup by URL."""
    seen: set[str] = set()
    out: list[dict] = []
    for entry in entries:
        for url in entry.get("sources", []):
            if url in seen:
                continue
            seen.add(url)
            label = "Wikibooks" if "wikibooks" in url else "Wikipedia" if "wikipedia" in url else "Chess SE"
            out.append({"label": label, "url": "https://" + url if not url.startswith("http") else url})
    return out


# ── Models ────────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class OpeningChatRequest(BaseModel):
    username: str
    message: str
    fen: str = START_FEN
    moves: str = ""
    opening_name: str = ""
    eco: str = ""
    use_position_context: bool = True
    chat_history: list[ChatMessage] = []


class CandidateMove(BaseModel):
    san: str
    uci: str
    name: str = ""
    popularity: float
    white: float
    draws: float
    black: float
    games: int


class Source(BaseModel):
    label: str
    url:   str


class OpeningChatResponse(BaseModel):
    answer:          str
    elo:             int
    elo_bucket:      str
    opening_name:    str
    eco:             str
    candidate_moves: list[CandidateMove]
    sources:         list[Source]


# ── User ELO ──────────────────────────────────────────────────────────────────

def _json_path(username: str, suffix: str) -> Path:
    return OUTPUT_DIR / f"{username}_{suffix}.json"


def _load_json(path: Path):
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _load_user_elo(username: str) -> int:
    data = _load_json(_json_path(username, "settings")) or {}
    try:
        return int(data.get("elo") or 1500)
    except Exception:
        return 1500


def _rating_band(elo: int) -> str:
    if elo < 1200: return "beginner"
    if elo < 1600: return "intermediate"
    if elo < 2000: return "advanced"
    return "strong"


# ── Position context ─────────────────────────────────────────────────────────

def _uci_path_to_san(path: str) -> str:
    if not path.strip():
        return ""
    board = chess.Board()
    sans: list[str] = []
    for uci in path.split():
        try:
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                break
            sans.append(board.san(move))
            board.push(move)
        except Exception:
            break
    return " ".join(sans)


def _summarise_candidate_moves(data: dict) -> list[CandidateMove]:
    raw_moves = data.get("moves", []) or []
    parent_total = sum(
        int(m.get("white", 0)) + int(m.get("draws", 0)) + int(m.get("black", 0))
        for m in raw_moves
    ) or 1

    moves: list[CandidateMove] = []
    for m in raw_moves:
        w = int(m.get("white", 0))
        d = int(m.get("draws", 0))
        b = int(m.get("black", 0))
        total = w + d + b
        if total <= 0:
            continue
        san = str(m.get("san") or "")
        uci = str(m.get("uci") or "")
        if not san or not uci:
            continue

        opening = m.get("opening") or {}
        moves.append(CandidateMove(
            san=san,
            uci=uci,
            name=str(opening.get("name") or ""),
            popularity=round(total / parent_total * 100, 1),
            white=round(w / total * 100, 1),
            draws=round(d / total * 100, 1),
            black=round(b / total * 100, 1),
            games=total,
        ))

    moves.sort(key=lambda m: m.popularity, reverse=True)
    return moves[:MAX_TOP_MOVES]


def _move_lines_for_prompt(moves: list[CandidateMove]) -> str:
    if not moves:
        return "No Lichess candidate moves were available for this position."
    lines = []
    for i, move in enumerate(moves, start=1):
        name = f", {move.name}" if move.name else ""
        lines.append(
            f"{i}. {move.san} ({move.uci}{name}): {move.popularity:.1f}% popularity, "
            f"{move.games} games, W/D/B {move.white:.1f}/{move.draws:.1f}/{move.black:.1f}."
        )
    return "\n".join(lines)


def _summarise_subtrees(
    board: chess.Board,
    path: str,
    elo: int,
    candidates: list[CandidateMove],
) -> str:
    lines: list[str] = []
    for candidate in candidates[:MAX_SUBTREES]:
        try:
            child_board = board.copy()
            move = chess.Move.from_uci(candidate.uci)
            if move not in child_board.legal_moves:
                continue
            child_board.push(move)
            child_path = f"{path} {candidate.uci}".strip()
            child_data = _fetch_lichess(child_board.fen(), child_path, elo)
            replies = _summarise_candidate_moves(child_data)[:3]
        except Exception as exc:
            log.info("Could not fetch subtree for %s: %s", candidate.uci, exc)
            continue

        if not replies:
            continue

        reply_text = "; ".join(
            f"{reply.san} {reply.popularity:.1f}% W/D/B "
            f"{reply.white:.0f}/{reply.draws:.0f}/{reply.black:.0f}"
            for reply in replies
        )
        lines.append(f"After {candidate.san}, common replies: {reply_text}.")

    return "\n".join(lines) if lines else "No subtree continuations were available."


def _build_context(
    req: OpeningChatRequest,
    elo: int,
) -> tuple[str, list[CandidateMove], str, str, list[dict]]:
    """
    Returns (context_text, candidate_moves, opening_name, eco, knowledge_entries_used)
    """
    if not req.use_position_context:
        # No position — just inject any knowledge entries relevant to the user's message
        relevant = _knowledge_lookup(
            eco="", opening_name=req.opening_name, user_message=req.message, max_entries=2,
        )

        corpus_block = ""
        if relevant:
            corpus_block = (
                "\nCurated opening literature (use as grounded reference):\n"
                + "\n\n".join(_format_knowledge_entry(e) for e in relevant)
                + "\n"
            )

        context = f"""
User:
- Username: {req.username}
- Rating/ELO from Forked settings: {elo} ({_rating_band(elo)})
- Lichess explorer rating bucket: {_elo_bucket_label(elo)}

No specific opening position is selected. Answer as a practical openings coach,
using the user's rating when it matters. If the user asks about a concrete line,
give clear plans, typical pawn breaks, piece placement, and tactical warnings.
Do not invent statistics or engine evaluations.{corpus_block}
""".strip()
        return context, [], req.opening_name or "General opening question", req.eco, relevant

    # Position context active
    try:
        board, _ = _normalise_explorer_position(req.fen, req.moves)
    except Exception as exc:
        raise HTTPException(400, f"Invalid opening position: {exc}")

    try:
        explorer_data = _fetch_lichess(req.fen, req.moves, elo)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, f"Could not fetch opening data: {exc}")

    opening_obj  = explorer_data.get("opening") or {}
    opening_name = req.opening_name or str(opening_obj.get("name") or "Unknown opening")
    eco          = req.eco or str(opening_obj.get("eco") or "")
    candidate_moves = _summarise_candidate_moves(explorer_data)

    try:
        eval_str = _run_stockfish(board.fen())
    except Exception as exc:
        log.info("Stockfish unavailable for opening chat: %s", exc)
        eval_str = "unavailable"

    san_path = _uci_path_to_san(req.moves)
    side     = "White" if board.turn == chess.WHITE else "Black"
    subtrees = _summarise_subtrees(board, req.moves, elo, candidate_moves)

    # Curated knowledge for this opening
    relevant = _knowledge_lookup(
        eco=eco, opening_name=opening_name, user_message=req.message, max_entries=2,
    )
    corpus_block = ""
    if relevant:
        corpus_block = (
            "\nCurated opening literature (use as grounded reference, cite ideas not move numbers):\n"
            + "\n\n".join(_format_knowledge_entry(e) for e in relevant)
            + "\n"
        )

    context = f"""
User:
- Username: {req.username}
- Rating/ELO from Forked settings: {elo} ({_rating_band(elo)})
- Lichess explorer rating bucket: {_elo_bucket_label(elo)}

Position:
- Opening: {opening_name}
- ECO: {eco or "unknown"}
- FEN: {board.fen()}
- UCI path: {req.moves or "(start position)"}
- SAN path: {san_path or "(start position)"}
- Side to move: {side}
- Stockfish depth-16 eval from White's perspective: {eval_str}

Lichess candidate moves at this user's level:
{_move_lines_for_prompt(candidate_moves)}

Short subtree lookahead:
{subtrees}{corpus_block}
""".strip()

    return context, candidate_moves, opening_name, eco, relevant


SYSTEM_PROMPT = """You are Forked's opening coach: practical, concrete, and position-specific.

You are an EXPERT chess opening coach. Your scope is opening theory only.
- If the user asks about endgame technique, tactical puzzles unrelated to the
  opening, or general topics, reply exactly with:
  "I specialise in opening theory — for that question, the analysis board would serve you better."

GROUND every answer in the supplied context (Lichess statistics, Stockfish eval,
curated opening literature). Do not invent game counts, opening names, forced
tactics, or engine lines not present in context.

Adapt depth to the user's rating: beginners get robust easy-to-remember plans;
strong players get nuanced sub-variations and concrete moves.

Tie advice to concrete chess ideas: pawn breaks, piece placement, king safety,
weak squares, tactical motifs, and likely replies. Use SAN move notation.

Keep answers compact: 2–5 short paragraphs. Plain prose, no bullet points.
When you cite a plan or motif that came from the curated literature, weave it
into the prose — the UI shows source links separately."""


# ── Groq call (sync + streaming) ──────────────────────────────────────────────

def _build_messages(req: OpeningChatRequest, context: str) -> list[dict]:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for msg in req.chat_history[-MAX_CHAT_HISTORY:]:
        content = msg.content.strip()
        if content:
            messages.append({"role": msg.role, "content": content[:1800]})
    messages.append({
        "role": "user",
        "content": (
            "Current opening context:\n"
            f"{context}\n\n"
            "User question:\n"
            f"{req.message.strip()}"
        ),
    })
    return messages


def _groq_client():
    from groq import Groq
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY not set")
    return Groq(api_key=api_key)


def _call_groq(req: OpeningChatRequest, context: str) -> str:
    client = _groq_client()
    completion = client.chat.completions.create(
        model       = "llama-3.3-70b-versatile",
        messages    = _build_messages(req, context),
        temperature = 0.35,
        max_tokens  = 760,
    )
    return completion.choices[0].message.content.strip()


def _stream_groq(req: OpeningChatRequest, context: str) -> Iterator[str]:
    """Yield text chunks from Groq's streaming API."""
    client = _groq_client()
    stream = client.chat.completions.create(
        model       = "llama-3.3-70b-versatile",
        messages    = _build_messages(req, context),
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


# ── Sync chat (kept for compatibility) ────────────────────────────────────────

def _answer(req: OpeningChatRequest) -> OpeningChatResponse:
    username = req.username.strip()
    if not username:
        raise HTTPException(400, "username is required")
    if not req.message.strip():
        raise HTTPException(400, "message is required")

    elo = _load_user_elo(username)
    context, candidates, opening_name, eco, knowledge_used = _build_context(req, elo)

    try:
        answer = _call_groq(req, context)
    except Exception as exc:
        log.error("Groq opening coach failed: %s", exc)
        raise HTTPException(503, f"Opening coach unavailable: {exc}")

    sources = _collect_sources(knowledge_used)
    return OpeningChatResponse(
        answer=answer,
        elo=elo,
        elo_bucket=_elo_bucket_label(elo),
        opening_name=opening_name,
        eco=eco,
        candidate_moves=candidates,
        sources=[Source(**s) for s in sources],
    )


@router.post("/chat")
async def opening_chat(req: OpeningChatRequest):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _answer(req))


# ── Streaming chat (SSE) ──────────────────────────────────────────────────────

@router.post("/chat/stream")
async def opening_chat_stream(req: OpeningChatRequest):
    username = req.username.strip()
    if not username:
        raise HTTPException(400, "username is required")
    if not req.message.strip():
        raise HTTPException(400, "message is required")

    elo = _load_user_elo(username)

    # Build context off the event loop (Lichess + Stockfish are blocking)
    loop = asyncio.get_event_loop()
    try:
        context, candidates, opening_name, eco, knowledge_used = await loop.run_in_executor(
            None, lambda: _build_context(req, elo)
        )
    except HTTPException as exc:
        # Send the error as a single SSE event
        async def _err_stream():
            yield f"data: {json.dumps({'type': 'error', 'message': exc.detail})}\n\n"
        return StreamingResponse(_err_stream(), media_type="text/event-stream")

    sources = _collect_sources(knowledge_used)

    async def event_stream():
        # 1) Meta event with sources + candidate moves up front
        meta = {
            "type":            "meta",
            "elo":             elo,
            "elo_bucket":      _elo_bucket_label(elo),
            "opening_name":    opening_name,
            "eco":             eco,
            "candidate_moves": [c.model_dump() for c in candidates],
            "sources":         sources,
        }
        yield f"data: {json.dumps(meta)}\n\n"

        # 2) Stream Groq tokens via a queue (executor → async generator)
        queue: asyncio.Queue = asyncio.Queue()

        def producer():
            try:
                for chunk in _stream_groq(req, context):
                    asyncio.run_coroutine_threadsafe(queue.put({"type": "token", "text": chunk}), loop)
            except Exception as exc:
                asyncio.run_coroutine_threadsafe(
                    queue.put({"type": "error", "message": str(exc)}), loop
                )
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


# ── Suggestion chips ──────────────────────────────────────────────────────────

class SuggestResponse(BaseModel):
    eco:         str
    opening:     str
    rating_band: str
    chips:       list[str]


def _suggestions_cache_get(eco: str, band: str) -> Optional[list[str]]:
    try:
        con = sqlite3.connect(str(OPENING_DB_PATH))
        con.row_factory = sqlite3.Row
        con.execute("""
            CREATE TABLE IF NOT EXISTS chat_suggestions_cache (
                key TEXT PRIMARY KEY, chips TEXT, expires_at TEXT
            )
        """)
        con.commit()
        row = con.execute(
            "SELECT chips, expires_at FROM chat_suggestions_cache WHERE key=?",
            (f"{eco}|{band}",),
        ).fetchone()
        con.close()
        if not row:
            return None
        if dt.datetime.fromisoformat(row["expires_at"]) < dt.datetime.utcnow():
            return None
        return json.loads(row["chips"])
    except Exception:
        return None


def _suggestions_cache_set(eco: str, band: str, chips: list[str]) -> None:
    try:
        con = sqlite3.connect(str(OPENING_DB_PATH))
        con.execute("""
            CREATE TABLE IF NOT EXISTS chat_suggestions_cache (
                key TEXT PRIMARY KEY, chips TEXT, expires_at TEXT
            )
        """)
        expires = (dt.datetime.utcnow() + dt.timedelta(days=SUGGESTIONS_TTL_D)).isoformat()
        con.execute(
            "INSERT OR REPLACE INTO chat_suggestions_cache (key, chips, expires_at) VALUES (?, ?, ?)",
            (f"{eco}|{band}", json.dumps(chips), expires),
        )
        con.commit()
        con.close()
    except Exception as exc:
        log.warning("Failed to cache suggestions: %s", exc)


_FALLBACK_GENERAL = [
    "Best openings for my rating?",
    "How to handle the Sicilian?",
    "Explain the Italian Game",
    "What's a solid opening for Black?",
]


def _fallback_position_chips(opening: str) -> list[str]:
    base = opening.split(":")[0].strip() or "this line"
    return [
        f"What's the main plan in {base}?",
        f"Any traps to watch out for?",
        f"Best move at my rating?",
        f"Typical pawn breaks here?",
    ]


def _generate_chips(eco: str, opening_name: str, rating_band: str) -> list[str]:
    """Call Groq to generate 4 short, focused chip questions. Falls back on error."""
    try:
        client = _groq_client()
    except Exception:
        return _fallback_position_chips(opening_name) if opening_name else _FALLBACK_GENERAL

    if eco or opening_name:
        prompt = (
            f"For the {opening_name} (ECO {eco or 'unknown'}) at {rating_band} level, "
            f"give exactly 4 very short, distinct questions a player would ask their coach. "
            f"Each question 3-8 words. Return only the questions, one per line. No numbering, "
            f"no quotes."
        )
    else:
        prompt = (
            f"For a {rating_band} player learning chess openings, give exactly 4 "
            f"short, distinct questions they would ask their coach. Each 3-8 words. "
            f"Return only the questions, one per line. No numbering, no quotes."
        )

    try:
        completion = client.chat.completions.create(
            model       = "llama-3.3-70b-versatile",
            messages    = [{"role": "user", "content": prompt}],
            temperature = 0.6,
            max_tokens  = 120,
        )
        text = completion.choices[0].message.content.strip()
        chips = [line.strip(" -•*\"'") for line in text.splitlines() if line.strip()]
        chips = [c for c in chips if 6 <= len(c) <= 80][:4]
        return chips if len(chips) == 4 else (
            _fallback_position_chips(opening_name) if opening_name else _FALLBACK_GENERAL
        )
    except Exception as exc:
        log.warning("Suggestions Groq call failed: %s", exc)
        return _fallback_position_chips(opening_name) if opening_name else _FALLBACK_GENERAL


@router.get("/chat/suggestions")
async def suggestions(
    eco:           str          = "",
    opening_name:  str          = "",
    elo:           Optional[int] = None,
):
    band = _rating_band(elo or 1500)
    cache_key_eco = eco.upper().strip() or "general"

    cached = _suggestions_cache_get(cache_key_eco, band)
    if cached:
        return SuggestResponse(
            eco=eco, opening=opening_name, rating_band=band, chips=cached,
        )

    loop = asyncio.get_event_loop()
    chips = await loop.run_in_executor(
        None, lambda: _generate_chips(eco, opening_name, band)
    )
    _suggestions_cache_set(cache_key_eco, band, chips)
    return SuggestResponse(eco=eco, opening=opening_name, rating_band=band, chips=chips)
