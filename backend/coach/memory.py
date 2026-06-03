"""
Layer 2 — cross-session coach memory.

The only persistent memory mechanism: a rolling ~500-token prose summary updated
after each session via Groq. No vector DB, no embeddings (consistent with the
rest of Forked). Called from the router when a session ends or is long enough.
"""
from __future__ import annotations

import logging

from backend.coach.profile import load_coach_memory, save_coach_memory

log = logging.getLogger(__name__)

_SUMMARY_PROMPT = """You maintain the long-term coaching memory for one chess student.

EXISTING MEMORY SUMMARY:
{existing_summary}

THE SESSION THAT JUST HAPPENED (most recent messages):
{transcript}

Write an updated memory summary (max ~450 words) that:
1. Preserves important prior context (don't drop earlier topics that still matter).
2. Adds the key points, questions, and advice from this session.
3. Notes any change in the student's understanding or progress.
4. Notes their communication preference (technical vs intuitive, detailed vs concise).
Write it as flowing prose addressed about (not to) the student. Return ONLY the summary text."""


def _groq_client():
    import os
    from groq import Groq
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        raise RuntimeError("GROQ_API_KEY not set")
    return Groq(api_key=key)


def _transcript(messages: list[dict], max_msgs: int = 16) -> str:
    lines = []
    for m in messages[-max_msgs:]:
        role = m.get("role", "")
        if role not in ("user", "assistant"):
            continue
        content = (m.get("content") or "").strip()
        if content:
            who = "Student" if role == "user" else "Coach"
            lines.append(f"{who}: {content[:600]}")
    return "\n".join(lines)


def update_memory(username: str, messages: list[dict]) -> dict:
    """Summarise the session into the rolling memory and persist it. Best-effort:
    on any failure the existing memory is left untouched."""
    memory = load_coach_memory(username)
    transcript = _transcript(messages)
    if not transcript.strip():
        return memory

    try:
        client = _groq_client()
        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{
                "role": "user",
                "content": _SUMMARY_PROMPT.format(
                    existing_summary=memory.get("summary") or "(none — first session)",
                    transcript=transcript,
                ),
            }],
            temperature=0.3,
            max_tokens=650,
        )
        new_summary = (completion.choices[0].message.content or "").strip()
        if new_summary:
            memory["summary"] = new_summary
            memory["session_count"] = int(memory.get("session_count", 0)) + 1
            save_coach_memory(username, memory)
    except Exception as exc:
        log.warning("coach memory update failed for %s: %s", username, exc)
    return memory
