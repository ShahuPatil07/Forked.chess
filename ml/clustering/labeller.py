"""
LLM cluster labeller — asks Claude to name each blindspot cluster.

Sends 5 representative positions (FEN + move info) and the dominant
tactical theme to claude-haiku-4-5; receives a ≤5-word blindspot name.

Uses prompt caching on the system prompt (it's identical across all clusters
in one session, so repeated calls benefit from the cache hit).
"""
from __future__ import annotations

import os
import time
from typing import Optional

from ml.clustering.blindspot import BlindspotCluster

_SYSTEM_PROMPT = """\
You are a chess coach analysing a player's recurring mistakes to identify their specific tactical blindspots.

You will be given up to 5 chess positions (FEN notation) where this player made a significant mistake, the move they played, the move the engine recommended, and the dominant tactical theme across these positions.

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


def label_cluster(
    cluster: BlindspotCluster,
    client,    # anthropic.Anthropic instance
    model:     str = "claude-haiku-4-5-20251001",
) -> str:
    """Return a ≤5-word label for the cluster, or a fallback if the API call fails."""
    events = cluster.representative_events
    if not events:
        return f"{cluster.dominant_threat_type.replace('_', ' ').title()} mistakes"

    position_lines = []
    for i, ev in enumerate(events, 1):
        position_lines.append(
            f"{i}. FEN: {ev['fen']}\n"
            f"   Played: {ev['move_played']}  |  Engine best: {ev['best_move']}"
            f"  |  Eval drop: {ev['eval_drop_cp']}cp"
        )

    user_content = (
        f"Dominant tactical theme: {cluster.dominant_threat_type.replace('_', ' ')}\n"
        f"Game phase: {cluster.dominant_game_phase}\n"
        f"Occurrences: {cluster.size}\n\n"
        f"Representative positions where the player missed the key move:\n\n"
        + "\n\n".join(position_lines)
    )

    try:
        response = client.messages.create(
            model=model,
            max_tokens=30,
            system=[
                {
                    "type":       "text",
                    "text":       _SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},  # cache across cluster calls
                }
            ],
            messages=[{"role": "user", "content": user_content}],
        )
        label = response.content[0].text.strip().strip('"').strip("'")
        return label if label else _fallback_label(cluster)
    except Exception as exc:
        print(f"  [labeller] API error for cluster {cluster.cluster_id}: {exc}")
        return _fallback_label(cluster)


def label_all_clusters(
    clusters:   list[BlindspotCluster],
    api_key:    Optional[str] = None,
    model:      str = "claude-haiku-4-5-20251001",
    rate_limit_delay: float = 0.3,   # seconds between API calls
) -> list[BlindspotCluster]:
    """
    Label all clusters in-place. Returns the updated list.
    Skips the API call and uses fallback labels if no api_key is provided.
    """
    key = api_key or os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        print("No Anthropic API key — using fallback labels.")
        for c in clusters:
            c.label = _fallback_label(c)
        return clusters

    import anthropic
    client = anthropic.Anthropic(api_key=key)

    print(f"Labelling {len(clusters)} clusters with Claude ({model})...")
    for i, cluster in enumerate(clusters):
        label = label_cluster(cluster, client, model)
        cluster.label = label
        print(f"  Cluster {cluster.cluster_id:2d} ({cluster.size:3d} events): {label!r}")
        if i < len(clusters) - 1:
            time.sleep(rate_limit_delay)

    return clusters


def _fallback_label(cluster: BlindspotCluster) -> str:
    theme = cluster.dominant_threat_type.replace("_", " ").title()
    phase = cluster.dominant_game_phase
    return f"{theme} in the {phase}"
