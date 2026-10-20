"""Positions for the Coach's position editor ("set up a rook endgame to play").

Balanced material → an EQUAL position: random realistic placements screened with
Stockfish (|eval| ≤ 0.6 at depth 8, confirmed ≤ 0.8 at depth 12), with a mirrored
(symmetric) placement as the fallback. The user is to move.
Unbalanced material → the Endgames practice path (Lichess endgame puzzles with the
exact material first, then Stockfish-filtered generation).
"""
from __future__ import annotations

import random

import chess

from backend.endgames import (ByConfigRequest, _clamp_config, _describe_position, _mat_label, _material_sig,
                              _sf_analyse, _solve_by_config, PIECE_ORDER)

TYPE = {"Q": chess.QUEEN, "R": chess.ROOK, "B": chess.BISHOP, "N": chess.KNIGHT, "P": chess.PAWN}
SCREEN_CP, CONFIRM_CP = 60, 80


def _place(w: dict[str, int], b: dict[str, int], turn: chess.Color, rng: random.Random) -> chess.Board | None:
    board = chess.Board(None)
    free = set(range(64))

    def put(ptype: int, color: chess.Color) -> bool:
        if ptype == chess.PAWN:   # realistic pawns: not about to promote, not on the back ranks
            ranks = range(1, 5) if color == chess.WHITE else range(3, 7)
        else:
            ranks = range(8)
        options = [s for s in free if chess.square_rank(s) in ranks]
        if not options:
            return False
        sq = rng.choice(options)
        board.set_piece_at(sq, chess.Piece(ptype, color))
        free.discard(sq)
        return True

    for color in (chess.WHITE, chess.BLACK):
        if not put(chess.KING, color):
            return None
    for sym in PIECE_ORDER:
        for _ in range(w[sym]):
            if not put(TYPE[sym], chess.WHITE):
                return None
        for _ in range(b[sym]):
            if not put(TYPE[sym], chess.BLACK):
                return None
    board.turn = turn
    wk, bk = board.king(chess.WHITE), board.king(chess.BLACK)
    if chess.square_distance(wk, bk) <= 2 or not board.is_valid() or board.is_check():
        return None
    if board.is_game_over() or board.legal_moves.count() < 6:
        return None
    return board


def _mirror(w: dict[str, int], turn: chess.Color, rng: random.Random) -> chess.Board | None:
    """White's half placed randomly, Black's half as its mirror image: equal by construction."""
    for _ in range(60):
        half = _place(w, {k: 0 for k in w}, chess.WHITE, rng)
        if half is None:
            continue
        board = chess.Board(None)
        for sq, piece in half.piece_map().items():
            board.set_piece_at(sq, piece)
            board.set_piece_at(chess.square_mirror(sq), chess.Piece(piece.piece_type, chess.BLACK))
        board.turn = turn
        if board.is_valid() and not board.is_check() and not board.is_game_over():
            return board
    return None


def _equal_position(w: dict[str, int], b: dict[str, int], turn: chess.Color, exclude: set[str]) -> dict | None:
    rng = random.Random()
    for attempt in range(40):
        board = _place(w, b, turn, rng)
        if board is None or board.fen() in exclude:
            continue
        a = _sf_analyse(board.fen(), depth=8)
        if a["mate"] is not None or a["eval_cp"] is None or abs(a["eval_cp"]) > SCREEN_CP or a["pv_len"] < 4:
            continue
        final = _sf_analyse(board.fen(), depth=12)
        if final["mate"] is None and final["eval_cp"] is not None and abs(final["eval_cp"]) <= CONFIRM_CP:
            return {"fen": board.fen(), **final, "source": "generated_equal"}
    board = _mirror(w, turn, rng)
    if board is not None:
        return {"fen": board.fen(), **_sf_analyse(board.fen(), depth=12), "source": "mirrored"}
    return None


def generate_position(white: dict, black: dict, user_color: str = "white", exclude: set[str] | None = None) -> dict:
    w, b = _clamp_config(white or {}), _clamp_config(black or {})
    if sum(w.values()) + sum(b.values()) == 0:
        raise ValueError("Add at least one piece besides the kings.")
    exclude = exclude or set()
    color = chess.BLACK if str(user_color).lower().startswith("b") else chess.WHITE
    balanced = w == b
    if balanced:
        got = _equal_position(w, b, color, exclude)
        if got is None:
            raise ValueError("Couldn't build an equal position with that material — try adding a piece or pawn.")
        fen, eval_cp, mate, source = got["fen"], got["eval_cp"], got["mate"], got["source"]
        description = f"{_mat_label(w)} vs {_mat_label(b)} — equal position, {'White' if color else 'Black'} to move"
    else:
        res = _solve_by_config(ByConfigRequest(white_pieces=w, black_pieces=b, exclude_fens=list(exclude)))
        fen, eval_cp, source, description = res.fen, res.eval_cp, res.source, res.description
        mate = None
        aw, ab = _material_sig(fen)
        if eval_cp is None:
            a = _sf_analyse(fen, depth=12)
            eval_cp, mate = a["eval_cp"], a["mate"]
            description = _describe_position(aw, ab, eval_cp, mate)
    board = chess.Board(fen)
    aw, ab = _material_sig(fen)
    return {"fen": fen, "balanced": balanced, "eval_cp": eval_cp, "mate": mate, "source": source,
            "description": description, "side_to_move": "white" if board.turn else "black",
            "material": f"{_mat_label(aw)} vs {_mat_label(ab)}",
            "user_color": "black" if color == chess.BLACK else "white"}
