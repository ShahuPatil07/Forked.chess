"""
Deterministic motif verifier — a port of the relevant detectors from Lichess's
own puzzle tagger (lichess-puzzler `tagger/cook.py`), which is what produced the
theme labels our classifier is trained on.

Given a position (solver to move), the solving line (engine PV or puzzle
solution, UCI, solver first) and optionally the opponent's previous move, return
the set of v2 motif classes the board PROVES: mate, back-rank mate, hanging
piece, fork, discovered attack/check, skewer, absolute pin, capturing the
defender, advanced pawn / promotion.

Not a classifier (recall is partial by design). Used as
  - independent "silver" labels to evaluate the transformer on real games, and
  - extra evidence in production: a verified motif's probability is combined
    with the transformer's by noisy-OR, weighted by VERIFIER_PRECISION — the
    per-motif precision measured on 4,000 held-out real-game puzzles with
    engine lines (scripts/eval_stage12.py, E2).
"""
from __future__ import annotations

import chess

VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 99}
KING_VALUES = {**VALUES, chess.KING: 99}
RAY = (chess.BISHOP, chess.ROOK, chess.QUEEN)
LINE_PLIES = 8   # engine PVs run past the tactic; Lichess solutions are short

# Measured precision vs Lichess themes (held-out real-game puzzles, engine PV
# framing). Overwritten from reports/stage12_eval/verifier_precision.json when present.
VERIFIER_PRECISION: dict[str, float] = {
    "mate": 0.97, "backRankMate": 0.9, "hangingPiece": 0.7, "fork": 0.8,
    "discoveredAttack": 0.75, "skewer": 0.6, "pin": 0.6, "capturingDefender": 0.5,
    "advancedPawn": 0.9,
}


def _load_measured() -> None:
    import json
    from pathlib import Path
    p = Path(__file__).resolve().parents[2] / "reports" / "stage12_eval" / "verifier_precision.json"
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        for k, v in data.items():
            if isinstance(v, (int, float)):
                VERIFIER_PRECISION[k] = float(v)
    except Exception:
        pass


_load_measured()


# ── lichess-puzzler util ports ──────────────────────────────────────────────

def _is_defended(board: chess.Board, piece: chess.Piece, square: int) -> bool:
    if board.attackers(piece.color, square):
        return True
    for attacker in board.attackers(not piece.color, square):
        ap = board.piece_at(attacker)
        if ap and ap.piece_type in RAY:          # x-ray defence through the attacker
            bc = board.copy(stack=False)
            bc.remove_piece_at(attacker)
            if bc.attackers(piece.color, square):
                return True
    return False


def _is_hanging(board: chess.Board, piece: chess.Piece, square: int) -> bool:
    return not _is_defended(board, piece, square)


def _is_in_bad_spot(board: chess.Board, square: int) -> bool:
    piece = board.piece_at(square)
    if piece is None:
        return False
    if not board.attackers(not piece.color, square):
        return False
    return _is_hanging(board, piece, square) or any(
        VALUES[board.piece_at(a).piece_type] < VALUES[piece.piece_type]
        for a in board.attackers(not piece.color, square))


def _material_diff(board: chess.Board, color: chess.Color) -> int:
    s = 0
    for p in board.piece_map().values():
        if p.piece_type == chess.KING:
            continue
        s += VALUES[p.piece_type] if p.color == color else -VALUES[p.piece_type]
    return s


class _Line:
    """Board/move access with lichess-puzzler mainline indexing.
    B(k): board after solver-line ply k (B(-1) = start, B(-2) = before the
    opponent's last move). M(k): move of ply k (M(-1) = opponent's last move)."""

    def __init__(self, board: chess.Board, line: list[str], last_move: str | None,
                 prev_board: chess.Board | None):
        self.boards = {-1: board.copy(stack=False)}
        self.moves: dict[int, chess.Move] = {}
        if prev_board is not None:
            self.boards[-2] = prev_board.copy(stack=False)
        if last_move:
            try:
                self.moves[-1] = chess.Move.from_uci(last_move)
            except ValueError:
                pass
        b = board.copy(stack=False)
        self.n = 0
        for k, uci in enumerate(line[:LINE_PLIES]):
            try:
                mv = chess.Move.from_uci(uci)
            except ValueError:
                break
            if mv not in b.legal_moves:
                break
            b.push(mv)
            self.moves[k] = mv
            self.boards[k] = b.copy(stack=False)
            self.n = k + 1
        self.pov = board.turn

    def B(self, k): return self.boards.get(k)
    def M(self, k): return self.moves.get(k)
    def solver_plies(self): return list(range(0, self.n, 2))

    def moved_type(self, k):
        b = self.B(k)
        mv = self.M(k)
        p = b.piece_at(mv.to_square) if b and mv else None
        return p.piece_type if p else None


# ── detectors (cook.py) ─────────────────────────────────────────────────────

def _mate(L: _Line) -> bool:
    return L.n > 0 and L.B(L.n - 1).is_checkmate() and (L.n - 1) % 2 == 0


def _back_rank_mate(L: _Line) -> bool:
    if not _mate(L):
        return False
    board = L.B(L.n - 1)
    pov = L.pov
    king = board.king(not pov)
    back_rank = 7 if pov == chess.WHITE else 0
    if king is None or chess.square_rank(king) != back_rank:
        return False
    fwd = -8 if pov == chess.WHITE else 8
    squares = chess.SquareSet.from_square(king + fwd)
    f = chess.square_file(king)
    if pov == chess.WHITE:
        if f < 7: squares.add(king - 7)
        if f > 0: squares.add(king - 9)
    else:
        if f < 7: squares.add(king + 9)
        if f > 0: squares.add(king + 7)
    for sq in squares:
        p = board.piece_at(sq)
        if p is None or p.color == pov or board.attackers(pov, sq):
            return False
    return any(chess.square_rank(c) == back_rank for c in board.checkers())


def _hanging_piece(L: _Line) -> bool:
    if L.n < 1:
        return False
    start = L.B(-1)
    to = L.M(0).to_square
    captured = start.piece_at(to)
    if start.is_check() and (not captured or captured.piece_type == chess.PAWN):
        return False
    if not captured or captured.piece_type == chess.PAWN or not _is_hanging(start, captured, to):
        return False
    op_move, before = L.M(-1), L.B(-2)
    if op_move is not None and before is not None and op_move.to_square == to:
        op_capture = before.piece_at(op_move.to_square)
        if op_capture and VALUES[op_capture.piece_type] >= VALUES[captured.piece_type]:
            return False                      # a recapture, not a hanging piece
    if L.n < 3:
        return True
    return _material_diff(L.B(2), L.pov) >= _material_diff(L.B(0), L.pov)


def _fork(L: _Line) -> bool:
    plies = L.solver_plies()[:-1] if L.n > 1 else []
    for k in plies:
        if L.moved_type(k) == chess.KING:
            continue
        board = L.B(k)
        to = L.M(k).to_square
        if _is_in_bad_spot(board, to):
            continue
        mover = KING_VALUES[L.moved_type(k)]
        nb = 0
        for sq in board.attacks(to):
            p = board.piece_at(sq)
            if p is None or p.color == L.pov or p.piece_type == chess.PAWN:
                continue
            if KING_VALUES[p.piece_type] > mover or (
                    _is_hanging(board, p, sq) and sq not in board.attackers(not L.pov, to)):
                nb += 1
        if nb > 1:
            return True
    return False


def _discovered_check(L: _Line) -> bool:
    for k in L.solver_plies():
        checkers = L.B(k).checkers()
        if checkers and L.M(k).to_square not in checkers:
            return True
    return False


def _double_check(L: _Line) -> bool:
    return any(len(L.B(k).checkers()) > 1 for k in L.solver_plies())


def _discovered_attack(L: _Line) -> bool:
    if _discovered_check(L) or _double_check(L):
        return True
    for k in L.solver_plies()[1:]:
        mv, prev_b = L.M(k), L.B(k - 1)
        if not prev_b.is_capture(mv):
            continue
        between = chess.SquareSet.between(mv.from_square, mv.to_square)
        if L.M(k - 1).to_square == mv.to_square:
            return False
        pm = L.M(k - 2)
        pb = L.B(k - 3)
        castling = pb is not None and pb.is_castling(pm)
        if pm.from_square in between and mv.to_square != pm.to_square \
                and mv.from_square != pm.to_square and not castling:
            return True
    return False


def _skewer(L: _Line) -> bool:
    for k in L.solver_plies()[1:]:
        prev_b = L.B(k - 1)
        mv = L.M(k)
        capture = prev_b.piece_at(mv.to_square)
        if capture and L.moved_type(k) in RAY and not L.B(k).is_checkmate():
            between = chess.SquareSet.between(mv.from_square, mv.to_square)
            op_move = L.M(k - 1)
            if op_move.to_square == mv.to_square or op_move.from_square not in between:
                continue
            op_type = L.moved_type(k - 1)
            if op_type and KING_VALUES[op_type] > KING_VALUES[capture.piece_type] \
                    and _is_in_bad_spot(prev_b, mv.to_square):
                return True
    return False


def _pin(L: _Line) -> bool:
    for k in L.solver_plies():
        board = L.B(k)
        for sq, piece in board.piece_map().items():
            if piece.color == L.pov:
                continue
            pin_dir = board.pin(piece.color, sq)
            if int(pin_dir) == chess.BB_ALL:
                continue
            # pin prevents escape: attacked along the pin ray by something cheaper
            for a in board.attackers(L.pov, sq):
                if a in pin_dir and VALUES[piece.piece_type] > VALUES[board.piece_at(a).piece_type]:
                    return True
            # pin prevents attack: the pinned piece cannot take what it attacks
            for att in board.attacks(sq):
                t = board.piece_at(att)
                if t and t.color == L.pov and att not in pin_dir and (
                        VALUES[t.piece_type] > VALUES[piece.piece_type] or _is_hanging(board, t, att)):
                    return True
    return False


def _capturing_defender(L: _Line) -> bool:
    for k in L.solver_plies()[1:]:
        board, parent_b = L.B(k), L.B(k - 1)
        mv = L.M(k)
        capture = parent_b.piece_at(mv.to_square)
        mtype = L.moved_type(k)
        if board.is_checkmate() or (
                capture and mtype != chess.KING
                and VALUES[capture.piece_type] <= VALUES[mtype]
                and _is_hanging(parent_b, capture, mv.to_square)
                and L.M(k - 1).to_square != mv.to_square):
            prev_m, prev_b = L.M(k - 2), L.B(k - 2)
            init_b = L.B(k - 3)
            if prev_m is None or prev_b is None or init_b is None:
                continue
            if not prev_b.is_check() and prev_m.to_square != mv.from_square:
                dsq = prev_m.to_square
                defender = init_b.piece_at(dsq)
                if defender and dsq in init_b.attackers(defender.color, mv.to_square) \
                        and not init_b.is_check():
                    return True
    return False


def _advanced_pawn(L: _Line) -> bool:
    for k in L.solver_plies():
        mv = L.M(k)
        if mv.promotion:
            return True
        if L.moved_type(k) != chess.PAWN:
            continue
        r = chess.square_rank(mv.to_square)
        if (L.pov == chess.WHITE and r >= 6) or (L.pov == chess.BLACK and r <= 1):
            return True
    return False


_DETECTORS = (
    ("mate", _mate), ("backRankMate", _back_rank_mate), ("hangingPiece", _hanging_piece),
    ("fork", _fork), ("discoveredAttack", _discovered_attack), ("skewer", _skewer),
    ("pin", _pin), ("capturingDefender", _capturing_defender), ("advancedPawn", _advanced_pawn),
)


def verify(board: chess.Board, line: list[str], last_move: str | None = None,
           prev_board: chess.Board | None = None) -> set[str]:
    """Motifs provable from (board, solving line). Solver = side to move.
    `last_move`/`prev_board`: the opponent's move into `board` and the position
    before it (lets the hanging-piece check rule out plain recaptures)."""
    if not line:
        return set()
    L = _Line(board, line, last_move, prev_board)
    if L.n == 0:
        return set()
    found = set()
    for name, fn in _DETECTORS:
        try:
            if fn(L):
                found.add(name)
        except Exception:
            continue
    return found
