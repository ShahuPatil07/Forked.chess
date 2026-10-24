"""
Forked Coach router — /api/coach

  POST /api/coach/chat                 SSE stream: greeting / answer + tool events
  POST /api/coach/save-questionnaire   persist onboarding answers
  GET  /api/coach/profile/{username}   questionnaire + memory summary + prefs
  POST /api/coach/update-memory/{username}   summarise a finished session

Chat pipeline: build the Layer-3 context block → assemble system prompt + history
→ run Groq Llama-3.3-70B with the 6 tools, resolving tool calls in a bounded loop
→ stream the final answer. Tool calls are surfaced as SSE events so the UI can
show a "checking your data…" indicator and render inline boards.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Iterator, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.coach.tools import TOOL_SCHEMAS, dispatch_tool
from backend.coach.explain import explain_position, narrate_evidence, evidence_for_model
from backend.coach.config import MODEL, reasoning_options
from backend.coach.live import LiveTurnRequest, live_turn
from backend.coach.agent import run_agent
from backend.coach.profile import (
    load_coach_profile, load_coach_memory, save_questionnaire,
    has_completed_questionnaire,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coach")

MAX_TOOL_ROUNDS = 4
MAX_HISTORY = 12

# Payloads from these tools carry board data the frontend renders inline.
_BOARD_TOOLS = {"get_puzzle", "get_mistake_positions", "analyze_pgn", "explain_position"}

SYSTEM_PROMPT = """You are Forked Coach, a concise chess teacher and analyst.
Everyone receives the same coaching policy. Do not use account identity, stored
profiles, previous sessions, ratings or inferred personal weaknesses. Only the
current conversation and explicitly supplied position/game provide context.
Use tools to calculate and verify chess claims. Explain the move's point, the
opponent's strongest relevant defense, and one concrete alternative. Usually
80-160 words; show a single legal 3-4 move continuation if it helps. Lead with the
answer. Avoid generic praise, repetitive qualifications and lists of raw scores.
For positions use explain_position, respecting checked claims and uncertainty.
Do not turn a geometric attack into a forced win. Never invent a move or a game.
For theory consult curated opening/endgame tools. For a puzzle use a requested
theme and a fixed default difficulty of 1500. If a position is missing, ask for it.
{mode_line}
{user_context_block}"""

_MODE_LINES = {
    "coach": "MODE: Coach - teach from the supplied position and question.",
    "puzzle": "MODE: Puzzle - use the requested theme or the fixed default; never personalize.",
    "import": "MODE: Import - analyze the supplied game, then explain its important decisions.",
    "theory": "MODE: Theory - consult the curated opening/endgame tools.",
    "position": "MODE: Position - investigate the supplied board and compare legal alternatives.",
    "agent": "MODE: Agent",
}



# ── Request models ─────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str
    notes: str | None = Field(default=None, max_length=4000)   # agent analysis notes for follow-ups
    fen: str | None = Field(default=None, max_length=200)      # board the turn was about
    intent: str | None = Field(default=None, max_length=20)    # position | create | general


class CoachChatRequest(BaseModel):
    username: str
    message: str = ""
    mode: str = "coach"
    conversation_history: list[ChatMessage] = []
    position_fen: str | None = Field(default=None, max_length=200)
    focus_move: str | None = Field(default=None, max_length=20)
    alternative_move: str | None = Field(default=None, max_length=20)
    budget_seconds: float = Field(default=8.0, ge=0.25, le=15, allow_inf_nan=False)
    use_llm: bool = True
    # Agent mode: the user's board, how it was reached, a loaded game, level.
    board_moves: list[str] = Field(default_factory=list, max_length=400)
    game_pgn: str | None = Field(default=None, max_length=150000)
    level: str = Field(default="", max_length=40)
    style: str = Field(default="balanced", max_length=20)
    review: dict | None = None   # Game Review: {move, classification, best, move_number, color}
    profile: dict | None = None  # questionnaire v2: rating_bucket, learning, vocabulary, explanation_style, tone, notation, goal
    board_info: dict | None = None   # {"kind": "puzzle"|"play"|"position"|"board", "solved": bool}
    seen_puzzles: list[str] = Field(default_factory=list, max_length=200)
    maia_elo: int | None = Field(default=None, ge=1100, le=1900)


class PositionRequest(BaseModel):
    fen: str = Field(max_length=200)
    question: str = Field(default="", max_length=4000)
    focus_move: str | None = Field(default=None, max_length=20)
    alternative_move: str | None = Field(default=None, max_length=20)
    budget_seconds: float = Field(default=8.0, ge=0.25, le=15, allow_inf_nan=False)
    use_llm: bool = False


_FEN_IN_MESSAGE = re.compile(
    r"(?<!\S)([prnbqkPRNBQK1-8]+(?:/[prnbqkPRNBQK1-8]+){7}"
    r"\s+[wb]\s+(?:-|[KQkq]+)\s+(?:-|[a-h][36])\s+\d+\s+\d+)(?!\S)"
)


class QuestionnaireRequest(BaseModel):
    username: str
    rating_bucket: str = ""
    play_style: str = ""
    goal: str = ""
    study_time: str = ""
    struggle: str = ""
    explanation_style: str = ""
    learning: str = ""
    vocabulary: str = ""
    tone: str = ""
    notation: str = ""


# ── Groq ───────────────────────────────────────────────────────────────────────

def _groq_client():
    import os
    from groq import Groq
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("GROQ_API_KEY not set")
    return Groq(api_key=key, timeout=15.0, max_retries=0)


def _build_messages(req: CoachChatRequest) -> list[dict]:
    mode = req.mode if req.mode in _MODE_LINES else "coach"
    system = SYSTEM_PROMPT.format(mode_line=_MODE_LINES[mode], user_context_block="")
    messages: list[dict] = [{"role": "system", "content": system}]
    for m in req.conversation_history[-MAX_HISTORY:]:
        if m.role in ("user", "assistant") and m.content.strip():
            messages.append({"role": m.role, "content": m.content.strip()[:2000]})

    user_msg = req.message.strip()
    if not user_msg:
        user_msg = "[SESSION START] Offer to explain a supplied position or chess question. Do not call tools."
    messages.append({"role": "user", "content": user_msg})
    return messages


def _assistant_toolcall_msg(msg) -> dict:
    return {
        "role": "assistant",
        "content": msg.content or "",
        "tool_calls": [
            {"id": tc.id, "type": "function",
             "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
            for tc in (msg.tool_calls or [])
        ],
    }


class _FakeMsg:
    """Mimics a Groq message object when we salvage a malformed completion."""
    def __init__(self, content: str):
        self.content = content
        self.tool_calls = None


class _FakeCompletion:
    def __init__(self, content: str):
        self.choices = [type("C", (), {"message": _FakeMsg(content)})()]


_FUNC_TAG_RE = re.compile(r"<function=.*?(</function>|$)", re.DOTALL)


def _salvage_failed_generation(exc: Exception) -> str:
    """Llama-3.3 on Groq sometimes emits a malformed inline tool call, which the
    server rejects with `tool_use_failed`. The usable prose is in
    `failed_generation` — recover it and strip the broken function tag."""
    try:
        body = getattr(exc, "response", None)
        data = body.json() if body is not None else {}
        gen = data.get("error", {}).get("failed_generation", "")
    except Exception:
        gen = ""
    return _FUNC_TAG_RE.sub("", gen or "").strip()


def _create(client, messages: list[dict], allow_tools: bool):
    """Groq completion with a guard against Llama's `tool_use_failed`: salvage the
    model's prose if present, else retry once with tools disabled."""
    kwargs = dict(model=MODEL, messages=messages, temperature=0, max_tokens=2000, **reasoning_options())
    if allow_tools:
        kwargs["tools"] = [t for t in TOOL_SCHEMAS if t["function"]["name"] != "get_mistake_positions"]
        kwargs["tool_choice"] = "auto"
    try:
        return client.chat.completions.create(**kwargs)
    except Exception as exc:
        if "tool_use_failed" not in str(exc):
            raise
        salvaged = _salvage_failed_generation(exc)
        if salvaged:
            return _FakeCompletion(salvaged)
        kwargs.pop("tools", None)
        kwargs.pop("tool_choice", None)
        return client.chat.completions.create(**kwargs)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


def _chunk_text(text: str, size: int = 60) -> Iterator[str]:
    """Emit the final answer in small pieces for a streaming feel."""
    for i in range(0, len(text), size):
        yield text[i:i + size]


def _agent_stream(req: CoachChatRequest) -> Iterator[str]:
    """The investigate → verify → explain agent (Coach page + Game Review)."""
    level = req.level
    if not level and req.username:
        level = (load_coach_profile(req.username) or {}).get("rating_bucket", "")
    try:
        for event in run_agent(message=req.message, history=[m.model_dump() for m in req.conversation_history],
                               fen=req.position_fen, moves_context=req.board_moves, game_pgn=req.game_pgn,
                               level=level, style=req.style, review=req.review, profile=req.profile,
                               board_info=req.board_info, seen_puzzles=req.seen_puzzles, maia_elo=req.maia_elo,
                               username=req.username):
            yield _sse(event)
    except Exception as exc:
        log.error("coach agent failed: %s", exc, exc_info=True)
        yield _sse({"type": "error", "message": f"Coach error: {exc}"})


def _chat_stream(req: CoachChatRequest) -> Iterator[str]:
    mode = req.mode if req.mode in _MODE_LINES else "coach"
    if mode == "agent":
        yield from _agent_stream(req)
        return
    yield _sse({"type": "meta", "mode": mode})

    # A position request cannot silently skip investigation because the LLM key
    # is absent or its tool invocation was malformed.
    pasted = _FEN_IN_MESSAGE.search(req.message)
    if mode == "position" or pasted:
        fen = pasted.group(1) if pasted else (req.position_fen or "")
        question = req.message.replace(pasted.group(1), "").strip() if pasted else req.message
        yield _sse({"type": "tool", "name": "explain_position", "status": "running"})
        result = explain_position(fen, question, req.focus_move, req.alternative_move, req.budget_seconds)
        yield _sse({"type": "tool_result", "name": "explain_position", "payload": result})
        if req.use_llm and result.get("source") != "error":
            yield _sse({"type": "tool", "name": "narrate_evidence", "status": "running"})
            text, source = narrate_evidence(result, [m.model_dump() for m in req.conversation_history], force_groq=True)
        else:
            text, source = result["explanation"], "template"
        yield _sse({"type": "meta", "mode": mode, "narration_source": source,
                    "narration_warnings": result.get("narration_warnings", [])})
        for piece in _chunk_text(text):
            yield _sse({"type": "token", "text": piece})
        yield _sse({"type": "done"})
        return

    if not req.message.strip():
        yield _sse({"type": "token", "text": "Bring me a position, a move, or a chess question. I'll explain the idea, check the strongest reply, and compare an alternative."})
        yield _sse({"type": "done"})
        return

    try:
        client = _groq_client()
    except Exception as exc:
        yield _sse({"type": "error", "message": f"Coach unavailable: {exc}"})
        return

    messages = _build_messages(req)
    allow_tools = bool(req.message.strip())   # no tools on the auto-greeting turn

    final_text = ""
    try:
        for _round in range(MAX_TOOL_ROUNDS):
            completion = _create(client, messages, allow_tools)
            msg = completion.choices[0].message

            if allow_tools and getattr(msg, "tool_calls", None):
                messages.append(_assistant_toolcall_msg(msg))
                for tc in msg.tool_calls:
                    name = tc.function.name
                    try:
                        args = json.loads(tc.function.arguments or "{}")
                    except Exception:
                        args = {}
                    yield _sse({"type": "tool", "name": name, "status": "running"})
                    result = ({"error": "Personal history is disabled. Supply a position or game."}
                              if name == "get_mistake_positions" else dispatch_tool("", name, args))
                    # Surface board-bearing results so the UI can render inline.
                    if name in _BOARD_TOOLS:
                        yield _sse({"type": "tool_result", "name": name, "payload": result})
                    messages.append({
                        "role": "tool", "tool_call_id": tc.id, "name": name,
                        "content": (json.dumps(evidence_for_model(result)) if name == "explain_position"
                                    else json.dumps(result)[:6000]),
                    })
                continue   # let the model use the tool results

            final_text = (msg.content or "").strip()
            break
        else:
            final_text = final_text or "Let me know what you'd like to focus on."
    except Exception as exc:
        log.error("coach chat failed: %s", exc, exc_info=True)
        yield _sse({"type": "error", "message": f"Coach error: {exc}"})
        return

    for piece in _chunk_text(final_text):
        yield _sse({"type": "token", "text": piece})
    yield _sse({"type": "done"})


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/investigate")
def coach_investigate(req: PositionRequest):
    """Local evidence endpoint; narration uses the same checked ledger."""
    result = explain_position(req.fen, req.question, req.focus_move,
                              req.alternative_move, req.budget_seconds)
    if result.get("source") == "error":
        raise HTTPException(400, result["explanation"])
    if req.use_llm:
        result["explanation"], result["narration_source"] = narrate_evidence(result, force_groq=True)
    return result


class EngineMoveRequest(BaseModel):
    fen: str = Field(max_length=200)
    strength: str = Field(default="intermediate", max_length=20)


@router.post("/engine-move")
def coach_engine_move(req: EngineMoveRequest):
    """Play mode: a strength-limited Stockfish move (shared engine options untouched)."""
    import chess
    from backend.coach.agent.engine import pick_move_for_strength
    try:
        board = chess.Board(req.fen)
        if not board.is_valid() or board.is_game_over():
            raise ValueError("The game is over or the position is invalid.")
        return pick_move_for_strength(board.fen(), req.strength)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


class MaiaMoveRequest(BaseModel):
    fen: str = Field(max_length=200)
    elo: int = Field(default=1900, ge=600, le=2800)


@router.post("/maia-move")
def coach_maia_move(req: MaiaMoveRequest):
    """Play-along opponent: human-like Maia at the requested Elo (600-2800, Lichess scale).
    Falls back to a strong Stockfish move only if Maia2 is unavailable."""
    import chess
    from backend.bot import maia_engine
    try:
        board = chess.Board(req.fen)
        if not board.is_valid() or board.is_game_over():
            raise ValueError("The game is over or the position is invalid.")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if maia_engine._ensure_loaded():
        # Maia-2 below 2000, "Maia+" (human candidates checked by Stockfish) up to 2800
        from backend.bot import engines as bot_engines
        uci, info = bot_engines.choose_move(board, "maia", req.elo, req.elo)
        move = chess.Move.from_uci(uci)
        if move in board.legal_moves:
            return {"move_uci": uci, "move_san": board.san(move), "engine": info.get("mode", "maia"), "elo": req.elo}
    from backend.coach.agent.engine import pick_move_for_strength
    res = pick_move_for_strength(board.fen(), "strong")
    return {"move_uci": res["move_uci"], "move_san": res["move_san"], "engine": "stockfish-fallback", "elo": req.elo}


class GeneratePositionRequest(BaseModel):
    white: dict[str, int] = Field(default_factory=dict)
    black: dict[str, int] = Field(default_factory=dict)
    user_color: str = Field(default="white", max_length=5)
    exclude_fens: list[str] = Field(default_factory=list, max_length=50)


@router.post("/generate-position")
def coach_generate_position(req: GeneratePositionRequest):
    from backend.coach.positions import generate_position
    try:
        return generate_position(req.white, req.black, req.user_color, set(req.exclude_fens))
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.get("/llm-status")
def coach_llm_status():
    """Which model answers, and the paid spend so far (for the dev budget)."""
    from backend.coach.agent import llm
    return {"primary": llm.primary(), "chain": [f"{p}:{m}" for p, m in llm.chain()],
            "spent_usd": round(llm.spent(), 4), "limit_usd": llm.spend_limit(), "critic": llm.critic_enabled()}


@router.post("/live-turn")
def coach_live_turn(req: LiveTurnRequest):
    return live_turn(req)


@router.post("/chat")
def coach_chat(req: CoachChatRequest):
    if not req.username.strip():
        raise HTTPException(400, "username is required")
    return StreamingResponse(_chat_stream(req), media_type="text/event-stream")


@router.post("/save-questionnaire")
def coach_save_questionnaire(req: QuestionnaireRequest):
    if not req.username.strip():
        raise HTTPException(400, "username is required")
    profile = save_questionnaire(req.username, {
        "rating_bucket": req.rating_bucket, "play_style": req.play_style,
        "goal": req.goal, "study_time": req.study_time, "struggle": req.struggle,
        "explanation_style": req.explanation_style, "learning": req.learning,
        "vocabulary": req.vocabulary, "tone": req.tone, "notation": req.notation,
    })
    return {"ok": True, "profile": profile}


@router.get("/profile/{username}")
def coach_get_profile(username: str):
    profile = load_coach_profile(username)
    memory = load_coach_memory(username)
    return {
        "username": username,
        "questionnaire_complete": has_completed_questionnaire(username),
        "profile": profile,
        "memory": {
            "session_count": memory.get("session_count", 0),
            "summary": memory.get("summary", ""),
            "communication_style": memory.get("communication_style", "balanced"),
            "preferred_depth": memory.get("preferred_depth", "balanced"),
        },
    }


class UpdateMemoryRequest(BaseModel):
    messages: list[ChatMessage] = []


@router.post("/update-memory/{username}")
def coach_update_memory(username: str, req: UpdateMemoryRequest):
    return {"ok": True, "session_count": 0, "personalization": False}
