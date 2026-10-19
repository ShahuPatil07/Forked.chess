"""
Win-probability math for mistake detection (Lichess's model).

A centipawn drop means different things in different positions: +900 -> +600
changes nothing, 0 -> -300 loses the game. Lichess judges moves by the change in
*winning chances*, so we do the same:

    winning_chances(cp) = 2 / (1 + exp(-0.00368208 * cp)) - 1      in [-1, 1]
    expected_score(cp)  = (winning_chances + 1) / 2                 in [0, 1]

Lichess Advice thresholds on winning chances (0.1 / 0.2 / 0.3) are 0.05 / 0.10 /
0.15 in expected-score terms. Mate scores map to +/-1 naturally (no 30000cp
artefacts).
"""
from __future__ import annotations

import math

_K = 0.00368208
MATE_CP = 30_000

INACCURACY_ES = 0.05
MISTAKE_ES = 0.10       # Stage-1 mistake threshold
BLUNDER_ES = 0.15
LOST_ES = 0.15          # skip positions already this lost (~ -480cp)


def expected_score(cp: int | float | None) -> float:
    if cp is None:
        return 0.5
    if abs(cp) >= MATE_CP - 1000:
        return 1.0 if cp > 0 else 0.0
    cp = max(-2000.0, min(2000.0, float(cp)))
    return 1.0 / (1.0 + math.exp(-_K * cp))


def es_loss(cp_before: int, cp_after: int) -> float:
    """Expected-score lost by the mover (both evals from the mover's POV)."""
    return max(0.0, expected_score(cp_before) - expected_score(cp_after))


def judgement(loss: float) -> str | None:
    if loss >= BLUNDER_ES:
        return "blunder"
    if loss >= MISTAKE_ES:
        return "mistake"
    if loss >= INACCURACY_ES:
        return "inaccuracy"
    return None
