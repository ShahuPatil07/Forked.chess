"""Forked chess agent: investigate (tools) → verify → explain.

  llm.py       free-tier OpenAI-compatible provider chain with failover
  engine.py    cached Stockfish searches on the shared engine
  features.py  exact board facts (tactics + positional features)
  tools.py     agent tools, session board context, dispatch
  prompt.py    system prompts (Coach + Game Review critique)
  verify.py    grounding checks on drafted answers
  loop.py      the agent loop (SSE event generator)
"""
from backend.coach.agent.loop import run_agent

__all__ = ["run_agent"]
