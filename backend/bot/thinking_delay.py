"""
Human-like thinking delay for the bot game.

Runs as an async coroutine so it can execute concurrently with move
generation (whichever takes longer wins — user waits the maximum of the
two, making it feel natural when Maia2 is fast).
"""
from __future__ import annotations

import asyncio
import random

import chess


async def think(board_fen: str) -> None:
    """
    Sleep for a human-plausible duration based on position complexity.

    - Base: 1.5 – 3.5 s
    - Complexity bonus: up to 2.0 s (scales with legal-move count)
    - Check bonus: +0.5 s (finding the escape takes time)
    - Total: clamped to [1.0, 8.0] s
    """
    try:
        board = chess.Board(board_fen)
        legal_count = board.legal_moves.count()
        in_check    = board.is_check()
    except Exception:
        legal_count = 20
        in_check    = False

    base             = random.uniform(1.5, 3.5)
    complexity_bonus = min(2.0, (legal_count / 40) * 2.0)
    check_bonus      = 0.5 if in_check else 0.0

    delay = max(1.0, min(8.0, base + complexity_bonus + check_bonus))
    await asyncio.sleep(delay)
