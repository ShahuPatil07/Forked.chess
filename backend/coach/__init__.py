"""
Forked Coach — persistent agentic chess coach (capstone feature).

A self-contained package mounted on the main FastAPI app. Three layers of
personalisation feed every session:
  • Layer 1 — onboarding questionnaire (cold-start context)        → profile.py
  • Layer 2 — rolling cross-session "coach memory" prose summary   → memory.py
  • Layer 3 — live game-data context block, auto-injected          → context.py

The coach is a Groq Llama-3.3-70B chat with 6 callable tools (tools.py),
streamed over SSE with mid-stream tool orchestration (router.py). Position
explanation prefers C1 (when a vLLM endpoint is configured) and always falls
back to Stockfish (explain.py).
"""
from backend.coach.router import router

__all__ = ["router"]
