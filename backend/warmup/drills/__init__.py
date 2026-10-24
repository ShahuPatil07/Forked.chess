"""Drill generators. Each module exposes generate(rng, level, n, ctx) -> list[item].

An item carries everything the client needs to render it AND its exact answer
(computed on the board), so scoring is instant and response times aren't polluted
by network latency. ctx: {"username", "rating", "band", "seen": set of ids}.
"""
from __future__ import annotations

from . import (check_flash, double_check_hunt, easy_sprint, loose_pieces, opponent_threat, threat_count,
               two_candidates, what_changed)

GENERATORS = {
    "check_flash": check_flash.generate,
    "double_check_hunt": double_check_hunt.generate,
    "loose_pieces": loose_pieces.generate,
    "threat_count": threat_count.generate,
    "what_changed": what_changed.generate,
    "opponent_threat": opponent_threat.generate,
    "two_candidates": two_candidates.generate,
    "easy_sprint": easy_sprint.generate,
}

BOARD_DRILLS = tuple(GENERATORS)
