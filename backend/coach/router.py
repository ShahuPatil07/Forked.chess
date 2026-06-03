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
from pydantic import BaseModel

from backend.coach.context import build_user_context
from backend.coach.tools import TOOL_SCHEMAS, dispatch_tool
from backend.coach.memory import update_memory
from backend.coach.profile import (
    load_coach_profile, load_coach_memory, save_questionnaire,
    has_completed_questionnaire,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coach")

MODEL = "llama-3.3-70b-versatile"
MAX_TOOL_ROUNDS = 4
MAX_HISTORY = 12

# Payloads from these tools carry board data the frontend renders inline.
_BOARD_TOOLS = {"get_puzzle", "get_mistake_positions", "analyze_pgn", "explain_position"}

SYSTEM_PROMPT = """You are the Forked Coach — a personal chess coach with access to this specific player's complete game history, mistake patterns, and improvement data. You are not a generic chess assistant. You know this player.

YOUR ROLE:
- Coach this specific player on their improvement journey.
- Use their actual data (injected below) for specific, grounded advice.
- Remember prior conversations (summary injected below).
- Proactively connect questions to their known blindspots.

WHAT YOU CAN DO (via tools — call them, don't guess):
- get_mistake_positions: show the player's real mistakes in a blindspot.
- explain_position: explain a FEN (best move, eval, idea). Never calculate long lines yourself.
- get_puzzle: give an inline puzzle (defaults to their top blindspot).
- analyze_pgn: analyse a game/position they paste.
- get_opening_theory / get_endgame_theory: curated theory.

TONE:
- Warm but direct, never sycophantic. Specific, never generic ("play more actively" is not advice).
- Reference their actual data ("your king_safety cluster score is 0.34 — still your most urgent leak").
- Honest about what helps at their level.

CONSTRAINTS:
- Do not invent game data — only reference what is injected below or returned by tools.
- Do not give advice that contradicts their data.
- Keep replies focused (a few short paragraphs). Offer a concrete next step.

{mode_line}

{user_context_block}"""

_MODE_LINES = {
    "coach":  "MODE: Coach — conversational coaching, use the player's data proactively.",
    "puzzle": "MODE: Puzzle — the player wants a puzzle. Call get_puzzle (target their top blindspot unless they specify), then coach them through it.",
    "import": "MODE: Import — the player pasted a game or position. Call analyze_pgn on it, then explain the most significant mistake and connect it to their blindspots.",
    "theory": "MODE: Theory — answer universally from the knowledge base; do NOT personalise with their game data. Route opening questions to get_opening_theory and endgame questions to get_endgame_theory. Afterwards, offer to practise it.",
}


# ── Request models ─────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class CoachChatRequest(BaseModel):
    username: str
    message: str = ""
    mode: str = "coach"
    conversation_history: list[ChatMessage] = []


class QuestionnaireRequest(BaseModel):
    username: str
    rating_bucket: str = ""
    play_style: str = ""
    goal: str = ""
    study_time: str = ""
    struggle: str = ""


# ── Groq ───────────────────────────────────────────────────────────────────────

def _groq_client():
    import os
    from groq import Groq
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("GROQ_API_KEY not set")
    return Groq(api_key=key)


def _build_messages(req: CoachChatRequest) -> list[dict]:
    mode = req.mode if req.mode in _MODE_LINES else "coach"
    context_block = "" if mode == "theory" else build_user_context(req.username)
    system = SYSTEM_PROMPT.format(
        mode_line=_MODE_LINES[mode],
        user_context_block=context_block or "(theory mode — game data intentionally omitted)",
    )
    messages: list[dict] = [{"role": "system", "content": system}]
    for m in req.conversation_history[-MAX_HISTORY:]:
        if m.role in ("user", "assistant") and m.content.strip():
            messages.append({"role": m.role, "content": m.content.strip()[:2000]})

    user_msg = req.message.strip()
    if not user_msg:
        # Empty message = session greeting. Ask for a personalised opener.
        user_msg = ("[SESSION START] Greet me in 2-3 sentences. Reference my most "
                    "recent activity and my top blindspot from the context. End with a "
                    "concrete offer (e.g. drilling it or reviewing a game). Do not call tools.")
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
    kwargs = dict(model=MODEL, messages=messages, temperature=0.4, max_tokens=900)
    if allow_tools:
        kwargs["tools"] = TOOL_SCHEMAS
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


def _chat_stream(req: CoachChatRequest) -> Iterator[str]:
    mode = req.mode if req.mode in _MODE_LINES else "coach"
    yield _sse({"type": "meta", "mode": mode})

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
                    result = dispatch_tool(req.username, name, args)
                    # Surface board-bearing results so the UI can render inline.
                    if name in _BOARD_TOOLS:
                        yield _sse({"type": "tool_result", "name": name, "payload": result})
                    messages.append({
                        "role": "tool", "tool_call_id": tc.id, "name": name,
                        "content": json.dumps(result)[:6000],
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
    mem = update_memory(username, [m.model_dump() for m in req.messages])
    return {"ok": True, "session_count": mem.get("session_count", 0)}
