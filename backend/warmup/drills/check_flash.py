"""Check or Not? -- a small region with a king and 1-3 potential attackers is flashed;
answer Check / Not check. Procedural, legal (python-chess is_valid), ~50/50 balanced."""
from __future__ import annotations

import random

from ..chesskit import random_window_board
from ..config import level_value


def generate(rng: random.Random, level: int, n: int, ctx: dict) -> list[dict]:
    region = level_value("check_flash", "region", level)
    lo, hi = level_value("check_flash", "attackers", level)
    blockers = level_value("check_flash", "blockers", level)
    flash = level_value("check_flash", "flash_ms", level)
    answers = [i % 2 == 0 for i in range(n)]
    rng.shuffle(answers)
    out = []
    for i, want_check in enumerate(answers):
        attackers = rng.randint(lo, hi)
        board, window = random_window_board(rng, region, attackers, blockers,
                                            want_checkers=None if want_check else 0)
        if want_check and not board.is_check():
            board, window = random_window_board(rng, region, max(1, attackers), blockers, want_checkers=1)
        out.append({"id": f"cf-{rng.getrandbits(40):x}", "level": level, "fen": board.fen(),
                    "window": list(window), "answer": board.is_check(), "flash_ms": flash})
    return out
