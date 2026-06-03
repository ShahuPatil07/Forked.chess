"""
Coach profile + memory persistence.

Two per-user files under data/output/ (auto-created, file-backed by design —
no DB, consistent with the rest of Forked):

  {username}_coach_profile.json  — onboarding questionnaire answers + prefs
  {username}_coach_memory.json   — rolling cross-session memory (see memory.py)
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from ml.config import DATA_DIR

OUTPUT_DIR = DATA_DIR / "output"

# Allowed questionnaire values (validated server-side; UI sends these verbatim).
RATING_BUCKETS = ["Under 800", "800-1200", "1200-1600", "1600-2000", "2000+"]
STYLE_OPTIONS  = ["Sharp & tactical", "Solid & positional", "Mixed / adaptable", "Still figuring it out"]
GOAL_OPTIONS   = ["Reach a specific rating", "Stop making blunders", "Understand chess better",
                  "Beat a specific person", "Just enjoy improving"]
STUDY_OPTIONS  = ["< 1 hour", "1-3 hours", "3-7 hours", "7+ hours"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def coach_profile_path(username: str) -> Path:
    return OUTPUT_DIR / f"{username}_coach_profile.json"


def coach_memory_path(username: str) -> Path:
    return OUTPUT_DIR / f"{username}_coach_memory.json"


# ── Questionnaire / coach profile ──────────────────────────────────────────────

def load_coach_profile(username: str) -> Optional[dict]:
    """Return the saved coach profile, or None if the questionnaire is incomplete."""
    path = coach_profile_path(username)
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def has_completed_questionnaire(username: str) -> bool:
    p = load_coach_profile(username)
    return bool(p and p.get("questionnaire_complete"))


def save_questionnaire(username: str, answers: dict) -> dict:
    """Persist the 5-question onboarding answers. Idempotent — last write wins,
    but the UI guarantees this is only sent once (gated by has_completed)."""
    profile = load_coach_profile(username) or {"created_at": _now_iso()}
    profile.update({
        "username":               username,
        "rating_bucket":          answers.get("rating_bucket", ""),
        "play_style":             answers.get("play_style", ""),
        "goal":                   answers.get("goal", ""),
        "study_time":             answers.get("study_time", ""),
        "struggle":               (answers.get("struggle", "") or "")[:200],
        "questionnaire_complete": True,
        "updated_at":             _now_iso(),
    })
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(coach_profile_path(username), "w", encoding="utf-8") as fh:
        json.dump(profile, fh, indent=2)
    return profile


# ── Coach memory (rolling summary) ─────────────────────────────────────────────

def _empty_memory(username: str) -> dict:
    return {
        "username":            username,
        "created_at":          _now_iso(),
        "updated_at":          _now_iso(),
        "session_count":       0,
        "summary":             "",
        "topics_covered":      [],
        "advice_given":        [],
        "breakthroughs":       [],
        "communication_style": "balanced",   # technical | intuitive | balanced
        "preferred_depth":     "balanced",   # detailed | concise | balanced
    }


def load_coach_memory(username: str) -> dict:
    path = coach_memory_path(username)
    if not path.exists():
        return _empty_memory(username)
    try:
        with open(path, encoding="utf-8") as fh:
            mem = json.load(fh)
        # Backfill any missing keys from the template (forward-compatible).
        base = _empty_memory(username)
        base.update(mem)
        return base
    except Exception:
        return _empty_memory(username)


def save_coach_memory(username: str, memory: dict) -> None:
    memory["updated_at"] = _now_iso()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(coach_memory_path(username), "w", encoding="utf-8") as fh:
        json.dump(memory, fh, indent=2)
