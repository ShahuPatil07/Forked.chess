"""Board truths for the warm-up drills, straight from python-chess.

Nothing here uses the threat classifier or the blindspot profile: loose pieces,
attacked pieces, checks, exchange outcomes and threats are all computed from the
position itself, so every drill answer is exact.
"""
from __future__ import annotations

import random

import chess

VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}
PIECES = (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)


def defended(board: chess.Board, square: int) -> bool:
    """Is the piece on `square` protected by its own side (ignoring pins, like a player scanning)."""
    piece = board.piece_at(square)
    return bool(piece and board.attackers(piece.color, square))


def loose_squares(board: chess.Board, include_pawns: bool = False) -> list[int]:
    """Undefended pieces of BOTH colours (kings excluded)."""
    out = []
    for sq, p in board.piece_map().items():
        if p.piece_type == chess.KING or (p.piece_type == chess.PAWN and not include_pawns):
            continue
        if not defended(board, sq):
            out.append(sq)
    return sorted(out)


def attacked_squares(board: chess.Board, color: chess.Color, undefended_only: bool = False) -> list[int]:
    """`color`'s pieces (not king, not pawns) attacked by the other side."""
    out = []
    for sq in chess.SquareSet(board.occupied_co[color]):
        p = board.piece_at(sq)
        if p.piece_type not in PIECES:
            continue
        if board.is_attacked_by(not color, sq) and (not undefended_only or not defended(board, sq)):
            out.append(sq)
    return sorted(out)


def capture_outcomes(board: chess.Board, color: chess.Color) -> dict[int, dict]:
    """For each of `color`'s pieces (N, B, R, Q) the OTHER side could capture
    if it were its move: the best material it nets (static exchange, LEGAL moves
    only, so pinned attackers and kings walking into defended squares don't
    count) and whether some capture of it can't be answered at all."""
    b = board.copy(stack=False)
    if b.turn == color:
        b.push(chess.Move.null())
    out: dict[int, dict] = {}
    for m in list(b.legal_moves):
        if not b.is_capture(m) or b.is_en_passant(m):
            continue
        victim = b.piece_at(m.to_square)
        if victim is None or victim.color != color or victim.piece_type not in PIECES:
            continue
        gain = see(b, m)
        b.push(m)
        answered = any(b.is_capture(r) and r.to_square == m.to_square for r in b.legal_moves)
        b.pop()
        cur = out.setdefault(m.to_square, {"gain": gain, "free": False})
        cur["gain"] = max(cur["gain"], gain)
        cur["free"] = cur["free"] or not answered
    return out


def threatened_squares(board: chess.Board, color: chess.Color, hanging_only: bool = False) -> list[int]:
    """`color`'s pieces that are genuinely in danger: the opponent wins material
    by taking them (attacked by something cheaper, or more attackers than
    defenders). A queen eyeing a defended knight is NOT a threat.
    hanging_only: pieces that can be taken for free (no recapture at all)."""
    res = capture_outcomes(board, color)
    return sorted(sq for sq, r in res.items() if (r["free"] if hanging_only else r["gain"] >= 1))


def see(board: chess.Board, move: chess.Move) -> int:
    """Static exchange evaluation of a capture (material the mover nets, in pawns),
    playing out the cheapest legal recaptures on the target square."""
    target = move.to_square
    if board.is_en_passant(move):
        first = VALUE[chess.PAWN]
    else:
        victim = board.piece_at(target)
        if victim is None:
            return 0
        first = VALUE[victim.piece_type]
    gains = [first]
    b = board.copy(stack=False)
    moved_value = VALUE[b.piece_at(move.from_square).piece_type]
    b.push(move)
    while True:
        caps = [m for m in b.legal_moves if m.to_square == target and b.is_capture(m)]
        if not caps:
            break
        m = min(caps, key=lambda m: VALUE[b.piece_at(m.from_square).piece_type])
        gains.append(moved_value - gains[-1])
        moved_value = VALUE[b.piece_at(m.from_square).piece_type]
        b.push(m)
    for i in range(len(gains) - 2, -1, -1):
        gains[i] = -max(-gains[i], gains[i + 1])
    return gains[0]


def mates_in_one(board: chess.Board) -> list[chess.Move]:
    out = []
    for m in board.legal_moves:
        board.push(m)
        if board.is_checkmate():
            out.append(m)
        board.pop()
    return out


def threats(board: chess.Board, min_gain: int = 2) -> dict:
    """What the side NOT to move threatens if it got a free move (null-move probe):
    winning captures (SEE >= min_gain) and mates in one. Board unchanged."""
    if board.is_check():
        return {"kind": "check", "squares": [], "moves": []}
    b = board.copy(stack=False)
    b.push(chess.Move.null())
    mates = mates_in_one(b)
    if mates:
        king = board.king(board.turn)
        return {"kind": "mate", "squares": [king], "moves": [m.uci() for m in mates]}
    wins = [(see(b, m), m) for m in b.legal_moves if b.is_capture(m)]
    wins = [(g, m) for g, m in wins if g >= min_gain]
    if wins:
        squares = sorted({m.to_square for _, m in wins})
        return {"kind": "capture", "squares": squares, "moves": [m.uci() for _, m in sorted(wins, key=lambda t: -t[0])]}
    return {"kind": "none", "squares": [], "moves": []}


def piece_count(board: chess.Board) -> int:
    return len(board.piece_map())


# ── procedural mini-boards (check drills) ───────────────────────────────────

ATTACKER_TYPES = (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN)


def mini_position(rng: random.Random, region: int, n_attackers: int, n_blockers: int) -> tuple[chess.Board, tuple[int, int, int]]:
    """A legal position whose interesting part fits in a region x region window:
    the black king, `n_attackers` white pieces and `n_blockers` black blockers inside it,
    the white king parked outside. Black to move, so is_check() asks "is the king in check?"."""
    while True:
        f0, r0 = rng.randint(0, 8 - region), rng.randint(0, 8 - region)
        window = [chess.square(f, r) for f in range(f0, f0 + region) for r in range(r0, r0 + region)]
        squares = rng.sample(window, 1 + n_attackers + n_blockers)
        board = chess.Board(None)
        board.turn = chess.BLACK
        board.set_piece_at(squares[0], chess.Piece(chess.KING, chess.BLACK))
        ok = True
        for sq in squares[1:1 + n_attackers]:
            pt = rng.choice(ATTACKER_TYPES)
            if pt == chess.PAWN and chess.square_rank(sq) in (0, 7):
                pt = chess.KNIGHT
            board.set_piece_at(sq, chess.Piece(pt, chess.WHITE))
        for sq in squares[1 + n_attackers:]:
            pt = chess.PAWN if chess.square_rank(sq) not in (0, 7) and rng.random() < .6 else chess.KNIGHT
            board.set_piece_at(sq, chess.Piece(pt, chess.BLACK))
        outside = [s for s in chess.SQUARES if s not in window and board.piece_at(s) is None
                   and chess.square_distance(s, squares[0]) > 1]
        if not outside:
            continue
        board.set_piece_at(rng.choice(outside), chess.Piece(chess.KING, chess.WHITE))
        if ok and board.is_valid():
            return board, (f0, r0, region)


def random_window_board(rng: random.Random, region: int, n_attackers: int, n_blockers: int,
                        want_checkers: int | None) -> tuple[chess.Board, tuple[int, int, int]]:
    """mini_position with a required number of checkers (0, 1, 2) when given."""
    for _ in range(4000):
        board, window = mini_position(rng, region, n_attackers, n_blockers)
        if want_checkers is None or len(board.checkers()) == want_checkers:
            return board, window
    raise RuntimeError("could not generate the requested check position")
