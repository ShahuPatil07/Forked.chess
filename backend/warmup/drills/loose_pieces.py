"""Loose Pieces -- tap every undefended piece, both colours. Real positions (own games
first); ground truth from python-chess attack maps. Scored by F1."""
from __future__ import annotations

import random

import chess

from .. import positions
from ..chesskit import loose_squares
from ..config import level_value


def generate(rng: random.Random, level: int, n: int, ctx: dict) -> list[dict]:
    pieces = tuple(level_value("loose_pieces", "pieces", level))
    lo, hi = level_value("loose_pieces", "loose", level)
    pawns = level_value("loose_pieces", "pawns", level)
    out = []
    for p in positions.sample(rng, n * 4, ctx.get("username", ""), pieces=pieces):
        b = chess.Board(p["fen"])
        loose = loose_squares(b, include_pawns=pawns)
        if not lo <= len(loose) <= hi:
            continue
        out.append({"id": f"lp-{rng.getrandbits(40):x}", "level": level, "fen": b.fen(),
                    "orientation": "white" if b.turn == chess.WHITE else "black", "include_pawns": pawns,
                    "answer": [chess.square_name(s) for s in loose], "own": p["src"].startswith("own:")})
        if len(out) >= n:
            break
    return out
