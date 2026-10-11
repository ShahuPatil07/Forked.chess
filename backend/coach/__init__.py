"""
Forked Coach — persistent agentic chess coach (capstone feature).

A self-contained package mounted on the main FastAPI app. Three layers of
personalisation feed every session:
  • Layer 1 — onboarding questionnaire (cold-start context)        → profile.py
  • Layer 2 — rolling cross-session "coach memory" prose summary   → memory.py
  • Layer 3 — live game-data context block, auto-injected          → context.py

The coach uses a configurable Groq model with 6 callable tools (tools.py),
streamed over SSE with mid-stream tool orchestration (router.py). Position
investigation runs locally with Stockfish before narrative synthesis. Optional
C1 narration and a factual template fallback remain available (explain.py).
"""
from backend.coach.router import router

__all__ = ["router"]
