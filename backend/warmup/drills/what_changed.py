"""What Changed? -- the same position flickers with ONE piece moved (a legal, non-capturing
move). Tap the piece that moved (its new or old square both count)."""
from __future__ import annotations

import random

import chess

from .. import positions
from ..config import level_value


def generate(rng: random.Random, level: int, n: int, ctx: dict) -> list[dict]:
    pieces = tuple(level_value("what_changed", "pieces", level))
    show_ms = level_value("what_changed", "show_ms", level)
    pawn_moves = level_value("what_changed", "pawn_moves", level)
    out = []
    for p in positions.sample(rng, n * 2, ctx.get("username", ""), pieces=pieces):
        a = chess.Board(p["fen"])
        moves = [m for m in a.legal_moves if not a.is_capture(m) and not a.is_castling(m) and not m.promotion
                 and a.piece_at(m.from_square).piece_type != chess.KING
                 and (pawn_moves or a.piece_at(m.from_square).piece_type != chess.PAWN)]
        if not moves:
            continue
        m = rng.choice(moves)
        b = a.copy(stack=False)
        b.push(m)
        orientation = "white" if a.turn == chess.WHITE else "black"
        out.append({"id": f"wc-{rng.getrandbits(40):x}", "level": level, "fen_a": a.fen(), "fen_b": b.fen(),
                    "move": m.uci(), "answer": [chess.square_name(m.from_square), chess.square_name(m.to_square)],
                    "piece": a.piece_at(m.from_square).symbol(), "show_ms": show_ms, "orientation": orientation,
                    "own": p["src"].startswith("own:")})
        if len(out) >= n:
            break
    return out
