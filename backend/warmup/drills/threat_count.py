"""Threat Count -- "How many of your pieces are really in danger?" (variant: "...hanging?").

You are the side to move. Pieces = knights, bishops, rooks, queens (no pawns, no king).
A piece is IN DANGER when the opponent would win material by taking it (static
exchange on legal moves): attacked by something cheaper, or attacked more times
than it is defended. A queen attacking a defended knight is not a threat.
HANGING = can be taken and nothing can take back."""
from __future__ import annotations

import random

import chess

from .. import positions
from ..chesskit import threatened_squares
from ..config import level_value


def generate(rng: random.Random, level: int, n: int, ctx: dict) -> list[dict]:
    pieces = tuple(level_value("threat_count", "pieces", level))
    variant_ok = level_value("threat_count", "undefended_variant", level)
    out = []
    zeros = 0
    for p in positions.sample(rng, n * 4, ctx.get("username", ""), pieces=pieces):
        b = chess.Board(p["fen"])
        if b.is_check():
            continue
        hanging = variant_ok and rng.random() < .5
        squares = threatened_squares(b, b.turn, hanging_only=hanging)
        if len(squares) > 4 or (not squares and zeros >= max(1, n // 6)):
            continue
        zeros += not squares
        out.append({"id": f"tc-{rng.getrandbits(40):x}", "level": level, "fen": b.fen(),
                    "orientation": "white" if b.turn == chess.WHITE else "black",
                    "variant": "hanging" if hanging else "threatened",
                    "answer": len(squares), "squares": [chess.square_name(s) for s in squares],
                    "own": p["src"].startswith("own:")})
        if len(out) >= n:
            break
    return out
