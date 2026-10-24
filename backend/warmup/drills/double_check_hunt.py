"""Double-Check Hunt -- six 4x4 boards, each a king and two attackers; exactly one shows
a double check, the others a single check or none. Tap the double check."""
from __future__ import annotations

import random

from ..chesskit import random_window_board
from ..config import level_value


def generate(rng: random.Random, level: int, n: int, ctx: dict) -> list[dict]:
    blockers = level_value("double_check_hunt", "blockers", level)
    out = []
    for _ in range(n):
        target = rng.randrange(6)
        boards = []
        for k in range(6):
            want = 2 if k == target else rng.choice((0, 1, 1))
            b, window = random_window_board(rng, 4, 2, blockers, want_checkers=want)
            boards.append({"fen": b.fen(), "window": list(window), "checkers": len(b.checkers())})
        out.append({"id": f"dc-{rng.getrandbits(40):x}", "level": level, "boards": boards, "answer": target})
    return out
