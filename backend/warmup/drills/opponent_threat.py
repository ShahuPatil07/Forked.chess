"""What Does It Threaten? -- the opponent's last move is shown; tap the piece they now
threaten to win, or answer "mate threat" / "nothing".

Ground truth is a null-move probe on the board (chesskit.threats): if the opponent got a
free move, which captures would WIN material (static exchange >= 2) and is there a mate in
one. No motif labels, no classifier. Positions come from the player's own games first
(the threats they actually faced), then from real Lichess games. Mixed ~70% threat /
30% nothing so "nothing" is a real answer.
"""
from __future__ import annotations

import random

import chess

from .. import positions
from ..chesskit import threats
from ..config import level_value


def _item(rng, level, p, t, b) -> dict:
    return {"id": f"ot-{rng.getrandbits(40):x}", "level": level, "before": p["before"], "last": p["last"],
            "fen": b.fen(), "orientation": "white" if b.turn == chess.WHITE else "black",
            # EVERY threatening move, so the player can answer by playing any of them on the board
            "answer": {"kind": t["kind"], "squares": [chess.square_name(s) for s in t["squares"]],
                       "moves": t["moves"]},
            "own": p["src"].startswith("own:")}


def generate(rng: random.Random, level: int, n: int, ctx: dict) -> list[dict]:
    lo, hi = level_value("opponent_threat", "rating", level)
    want_none = max(1, round(n * .3))
    want_threat = n - want_none
    threat_items, none_items = [], []
    for attempt in range(6):
        strict = attempt < 3                      # then relax the rating window rather than come up short
        for p in positions.sample(rng, n * 8, ctx.get("username", ""), own_share=.5 if attempt == 0 else .2):
            if "last" not in p:
                continue
            if strict and not p["src"].startswith("own:") and not lo <= p.get("rating", lo) <= hi:
                continue
            b = chess.Board(p["fen"])
            t = threats(b)
            if t["kind"] == "check" or (t["kind"] == "mate" and level < 2):
                continue
            if t["kind"] == "none":
                # "nothing" must really be nothing: not even a pawn is won by a capture
                if threats(b, min_gain=1)["kind"] != "none":
                    continue
                if len(none_items) < want_none:
                    none_items.append(_item(rng, level, p, t, b))
            elif len(threat_items) < want_threat and len(t["squares"]) <= 2:
                threat_items.append(_item(rng, level, p, t, b))
            if len(threat_items) >= want_threat and len(none_items) >= want_none:
                break
        if len(threat_items) >= want_threat and len(none_items) >= want_none:
            break
    out = threat_items + none_items
    rng.shuffle(out)
    return out
