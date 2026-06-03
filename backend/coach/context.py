"""
Layer 3 — live user-context block.

Built fresh at every session start from the user's on-disk state, so the coach
opens already knowing the player (no retrieval step). Kept compact (~300-400
tokens) so the system prompt + context stay well under Groq's budget.

All reads are defensive: a brand-new user with only a questionnaire still gets a
coherent (if sparse) context block.
"""
from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path
from typing import Optional

from ml.config import DATA_DIR
from backend.coach.profile import load_coach_profile, load_coach_memory

OUTPUT_DIR = DATA_DIR / "output"


def _read_json(path: Path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _settings(username: str) -> dict:
    return _read_json(OUTPUT_DIR / f"{username}_settings.json", {}) or {}


def _style(username: str) -> dict:
    return _read_json(OUTPUT_DIR / f"{username}_style.json", {}) or {}


def _clusters(username: str) -> list[dict]:
    return _read_json(OUTPUT_DIR / f"{username}_clusters.json", []) or []


def _mistakes(username: str) -> list[dict]:
    return _read_json(OUTPUT_DIR / f"{username}_mistakes.json", []) or []


def _game_meta(username: str) -> dict:
    return _read_json(OUTPUT_DIR / f"{username}_game_meta.json", {}) or {}


def _fmt_days(unix_ts) -> str:
    if not unix_ts:
        return "unknown"
    days = (time.time() - unix_ts) / 86_400
    if days < 1:   return "today"
    if days < 2:   return "yesterday"
    return f"{int(days)}d ago"


def _format_clusters(clusters: list[dict], limit: int = 5) -> str:
    if not clusters:
        return "  (no blindspot profile yet — analyse games to build one)"
    ranked = sorted(clusters, key=lambda c: c.get("score", 0), reverse=True)[:limit]
    lines = []
    for i, c in enumerate(ranked):
        lines.append(
            f"  #{i+1} [{c.get('cluster_id')}] {c.get('label','')} "
            f"— score {c.get('score',0):.3f}, mastery {c.get('mastery',0):.2f}, "
            f"{c.get('size',0)} mistakes, last {_fmt_days(c.get('last_occurrence_unix'))}"
        )
    return "\n".join(lines)


def _recent_games(username: str, n: int = 5) -> str:
    mistakes = _mistakes(username)
    if not mistakes:
        return "  (no analysed games yet)"
    meta = _game_meta(username)
    groups: dict[str, list] = {}
    for m in mistakes:
        groups.setdefault(m.get("game_id", ""), []).append(m)
    ordered = sorted(
        groups.items(),
        key=lambda kv: -(kv[1][0].get("played_at_unix") or 0),
    )[:n]
    lines = []
    for gid, evts in ordered:
        gm = meta.get(gid, {})
        opp = gm.get("opponent") or "?"
        top_threat = Counter(e.get("threat_type", "other") for e in evts).most_common(1)[0][0]
        lines.append(
            f"  • vs {opp} ({_fmt_days(evts[0].get('played_at_unix'))}): "
            f"{len(evts)} mistakes, mostly {top_threat.replace('_',' ')}"
        )
    return "\n".join(lines) if lines else "  (no analysed games yet)"


def _unseen_alerts(username: str) -> str:
    try:
        from backend import live_sync
        alerts = live_sync.unseen_alerts(username)
    except Exception:
        alerts = []
    if not alerts:
        return "  (none)"
    lines = []
    for a in alerts[:3]:
        lines.append(
            f"  ! Repeated blindspot [{a.get('cluster_id')}] on move {a.get('move_number','?')}"
            f"{' vs ' + a['opponent'] if a.get('opponent') else ''} "
            f"(confidence {round(a.get('similarity',0)*100)}%)"
        )
    return "\n".join(lines)


def _drill_summary(username: str) -> str:
    srs = _read_json(OUTPUT_DIR / f"{username}_srs.json", [])
    if not srs:
        return "  (no drill sessions yet)"
    lines = []
    for s in (srs if isinstance(srs, list) else [])[:5]:
        lines.append(
            f"  • [{s.get('cluster_id')}] mastery {s.get('mastery',0):.2f}, "
            f"{s.get('total_attempts',0)} attempts"
        )
    return "\n".join(lines) if lines else "  (no drill sessions yet)"


def build_user_context(username: str) -> str:
    """Assemble the Layer-3 context block injected as the first user turn."""
    settings = _settings(username)
    style    = _style(username)
    profile  = load_coach_profile(username) or {}
    memory   = load_coach_memory(username)
    clusters = _clusters(username)

    elo = settings.get("elo") or profile.get("rating_bucket") or "unknown"
    archetype = style.get("archetype") or profile.get("play_style") or "unknown"
    goal = profile.get("goal") or "not specified"
    study = profile.get("study_time") or "not specified"
    struggle = profile.get("struggle") or ""

    summary = (memory.get("summary") or "").strip() or "  (first session — no prior memory)"
    breakthroughs = memory.get("breakthroughs") or []
    bt_line = ("\nALREADY UNDERSTOOD (do not re-explain): "
               + "; ".join(breakthroughs[:5])) if breakthroughs else ""

    return f"""USER CONTEXT (always current — auto-injected):

Rating: {elo} | Style: {archetype}
Goal: {goal} | Study time/week: {study}
{("Self-reported struggle: " + struggle) if struggle else ""}

BLINDSPOT CLUSTERS (ranked by urgency; identify clusters by cluster_id):
{_format_clusters(clusters)}

RECENT GAMES (last 5):
{_recent_games(username)}

UNREAD ALERTS:
{_unseen_alerts(username)}

DRILL PERFORMANCE:
{_drill_summary(username)}

COACH MEMORY (prior sessions, session #{memory.get('session_count', 0)}):
{summary}{bt_line}

Communication preference: {memory.get('communication_style','balanced')}, {memory.get('preferred_depth','balanced')} depth.
"""


def top_cluster_id(username: str) -> Optional[str]:
    clusters = _clusters(username)
    if not clusters:
        return None
    ranked = sorted(clusters, key=lambda c: c.get("score", 0), reverse=True)
    return str(ranked[0].get("cluster_id")) if ranked else None
