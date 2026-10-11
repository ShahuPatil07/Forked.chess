"""Shared model settings for chat, evidence narration and session memory."""
import os

# The previous default returned model_not_found for this project's Groq key.
# An environment override keeps deployments independent of a particular model.
MODEL = os.getenv("FORKED_COACH_MODEL", "openai/gpt-oss-120b")
NARRATION_MAX_TOKENS = 2000


def reasoning_options() -> dict:
    return {"reasoning_effort": "low"} if MODEL.startswith("openai/gpt-oss") else {}
