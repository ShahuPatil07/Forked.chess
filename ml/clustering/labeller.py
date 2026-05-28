"""
LLM cluster labeller — names each blindspot cluster using Groq (free tier).

Uses llama-3.3-70b-versatile via the Groq API (30 RPM free tier).
Reads GROQ_API_KEY from the environment.  Falls back to rule-based labels
when no key is available so the pipeline never hard-fails.

Free tier limits (as of 2025):
  - llama-3.3-70b-versatile: 30 req/min, 14 400 req/day
  - Max ~50 clusters per user → well within limits
"""
from __future__ import annotations

import os
import time
from typing import Optional

from ml.clustering.blindspot import BlindspotCluster

_SYSTEM_PROMPT = """\
You are a chess coach analysing a player's recurring mistakes to identify their specific tactical blindspots.

You will be given up to 5 chess positions (FEN notation) where this player made a significant mistake, the move they played, the move the engine recommended, the dominant tactical theme, and how surprising the miss was (from a human probability model).

Your job: name this player's blindspot in 5 words or fewer. Be specific and actionable — focus on what the player is consistently failing to see.

Good examples:
- "Back-rank threats"
- "Missed knight fork setups"
- "King safety in open positions"
- "Undefended rook endgames"
- "Discovered check blindspot"

Bad examples (too generic):
- "Tactical mistakes"
- "Chess errors"
- "Missing opportunities"

Respond with ONLY the blindspot name, no explanation, no punctuation at the end.\
"""

# Specific fallback labels per threat type (more useful than generic "<Type> in the <phase>")
_FALLBACK_LABEL_MAP = {
    "deflection":        "Deflecting key defenders",
    "overloaded_piece":  "Overloaded piece exploitation",
    "zwischenzug":       "Missed in-between moves",
    "back_rank":         "Back-rank threats",
    "fork":              "Fork opportunities missed",
    "skewer":            "Skewer tactics overlooked",
    "hanging_piece":     "Hanging pieces left uncaptured",
    "discovered_attack": "Discovered attack blindspot",
    "removing_defender": "Defender removal tactics",
    "pin":               "Pin tactics missed",
    "trapped_piece":     "Trapped piece patterns",
    "king_attack":       "King safety under attack",
    "passed_pawn":       "Passed pawn opportunities",
    "missed_threat":     "Missing opponent's key threats",
    "piece_activity":    "Passive piece placement",
    "endgame_technique": "Endgame technique errors",
    "pawn_structure":    "Pawn structure mistakes",
    "other":             "Recurring tactical oversight",
}


def _surprise_description(surprise: Optional[float]) -> str:
    """Convert maia2_surprise to a human-readable difficulty note."""
    if surprise is None:
        return ""
    if surprise > 2.0:
        return " [strong players usually find this]"
    if surprise > 1.0:
        return " [most players find this]"
    return " [commonly missed at this level]"


def label_cluster(cluster: BlindspotCluster, client, model: str) -> str:
    """Return a ≤5-word label for the cluster, or a fallback on API failure."""
    events = cluster.representative_events
    if not events:
        return _fallback_label(cluster)

    position_lines = []
    for i, ev in enumerate(events, 1):
        surprise_note = _surprise_description(ev.get("maia2_surprise"))
        position_lines.append(
            f"{i}. FEN: {ev['fen']}\n"
            f"   Move {ev.get('move_number', '?')} ({ev.get('game_phase', '?')})"
            f"  |  Played: {ev['move_played']}  |  Engine best: {ev['best_move']}\n"
            f"   Eval drop: {ev['eval_drop_cp']}cp"
            f"  |  Tactical motif: {ev.get('threat_type', 'unknown').replace('_', ' ')}"
            f"{surprise_note}"
        )

    user_content = (
        f"Dominant tactical theme: {cluster.dominant_threat_type.replace('_', ' ')}\n"
        f"Game phase: {cluster.dominant_game_phase}\n"
        f"Occurrences: {cluster.size}\n\n"
        f"Representative positions where the player missed the key move:\n\n"
        + "\n\n".join(position_lines)
    )

    try:
        response = client.chat.completions.create(
            model=model,
            max_tokens=30,
            temperature=0.3,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",   "content": user_content},
            ],
        )
        label = response.choices[0].message.content.strip().strip('"').strip("'")
        return label if label else _fallback_label(cluster)
    except Exception as exc:
        print(f"  [labeller] Groq error for cluster {cluster.cluster_id}: {exc}")
        return _fallback_label(cluster)


def label_all_clusters(
    clusters:         list[BlindspotCluster],
    groq_api_key:     Optional[str] = None,
    model:            str = "llama-3.3-70b-versatile",
    rate_limit_delay: float = 2.1,   # Groq free tier: 30 RPM → ~2s between calls
) -> list[BlindspotCluster]:
    """
    Label all clusters in-place using Groq.  Falls back to rule-based labels
    if no API key is found.
    """
    key = groq_api_key or os.environ.get("GROQ_API_KEY")

    if not key:
        print("No GROQ_API_KEY found — using fallback labels.")
        for c in clusters:
            c.label = _fallback_label(c)
        return clusters

    try:
        from groq import Groq
    except ImportError:
        print("groq package not installed (pip install groq) — using fallback labels.")
        for c in clusters:
            c.label = _fallback_label(c)
        return clusters

    client = Groq(api_key=key)
    print(f"Labelling {len(clusters)} clusters with Groq ({model})...")

    for i, cluster in enumerate(clusters):
        label = label_cluster(cluster, client, model)
        cluster.label = label
        print(f"  Cluster {cluster.cluster_id:2d} ({cluster.size:3d} events): {label!r}")
        if i < len(clusters) - 1:
            time.sleep(rate_limit_delay)

    return clusters


def _fallback_label(cluster: BlindspotCluster) -> str:
    label = _FALLBACK_LABEL_MAP.get(cluster.dominant_threat_type)
    if label:
        return label
    theme = cluster.dominant_threat_type.replace("_", " ").title()
    phase = cluster.dominant_game_phase
    return f"{theme} in the {phase}"
