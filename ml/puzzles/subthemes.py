"""
Forked-only puzzle sub-themes, detected deterministically from a Lichess puzzle
(FEN before the opponent's trigger move + UCI moves, trigger first).

Lichess tags a puzzle "fork" whether a pawn forks two rooks or a knight forks
king and queen, and has no "opposition" or "rook + pawn vs rook" theme at all.
These detectors split the big themes into the sub-types a coach would actually
drill, and add endgame-technique / material-signature themes:

  tactic sub-types   knightFork, pawnFork, queenFork, bishopFork, rookFork,
                     royalFork, queenSacrifice, exchangeSacrifice
  endgame technique  opposition, pawnBreakthrough
  material endgames  rookPawnVsRook, oppositeBishops, bishopVsKnight,
                     rookVsMinor, queenVsRook

Fork detection reuses the lichess-puzzler `cook.py` port in
ml/classifier/verifier.py so a "knight fork" here is exactly a Lichess fork
whose forking piece is a knight. Everything is conservative: a sub-theme is
only emitted when the board proves it.
"""
from __future__ import annotations

import chess

from ml.classifier.verifier import KING_VALUES, _is_hanging, _is_in_bad_spot

FORK_PIECE_THEME = {
    chess.KNIGHT: "knightFork", chess.PAWN: "pawnFork", chess.QUEEN: "queenFork",
    chess.BISHOP: "bishopFork", chess.ROOK: "rookFork",
}

SUBTHEMES = (
    "knightFork", "pawnFork", "queenFork", "bishopFork", "rookFork", "royalFork",
    "queenSacrifice", "exchangeSacrifice",
    "opposition", "pawnBreakthrough",
    "rookPawnVsRook", "oppositeBishops", "bishopVsKnight", "rookVsMinor", "queenVsRook",
)


def _replay(fen: str, moves: list[str]) -> tuple[list[chess.Board], list[chess.Move]] | None:
    """Boards after each ply (index 0 = after the trigger) and the moves."""
    try:
        b = chess.Board(fen)
    except ValueError:
        return None
    boards, mvs = [], []
    for uci in moves:
        try:
            mv = chess.Move.from_uci(uci)
        except ValueError:
            return None
        if mv not in b.legal_moves:
            return None
        mvs.append(mv)
        b.push(mv)
        boards.append(b.copy(stack=False))
    return boards, mvs


def _fork_detail(boards: list[chess.Board], mvs: list[chess.Move], pov: chess.Color):
    """(forking piece type, attacked targets) of the first Lichess-style fork in
    the solution, or None. Solver plies are 1, 3, 5... (0 is the trigger)."""
    solver = list(range(1, len(mvs), 2))
    for k in solver[:-1] if len(solver) > 1 else solver[:0]:
        board, mv = boards[k], mvs[k]
        piece = board.piece_at(mv.to_square)
        if piece is None or piece.piece_type == chess.KING:
            continue
        if _is_in_bad_spot(board, mv.to_square):
            continue
        mover = KING_VALUES[piece.piece_type]
        targets = []
        for sq in board.attacks(mv.to_square):
            p = board.piece_at(sq)
            if p is None or p.color == pov or p.piece_type == chess.PAWN:
                continue
            if KING_VALUES[p.piece_type] > mover or (
                    _is_hanging(board, p, sq) and sq not in board.attackers(not pov, mv.to_square)):
                targets.append(p.piece_type)
        if len(targets) > 1:
            return piece.piece_type, targets
    return None


def _material(board: chess.Board, color: chess.Color) -> dict[int, int]:
    return {pt: len(board.pieces(pt, color)) for pt in (chess.PAWN, chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN)}


def _only(mat: dict[int, int], **want: int) -> bool:
    """Exactly these non-pawn pieces (pawns unconstrained unless given)."""
    names = {"N": chess.KNIGHT, "B": chess.BISHOP, "R": chess.ROOK, "Q": chess.QUEEN, "P": chess.PAWN}
    for key, pt in names.items():
        if key == "P" and "P" not in want:
            continue
        if mat[pt] != want.get(key, 0):
            return False
    return True


def _material_themes(board: chess.Board, pov: chess.Color) -> set[str]:
    me, op = _material(board, pov), _material(board, not pov)
    out: set[str] = set()
    for a, b in ((me, op), (op, me)):
        if _only(a, R=1, P=1) and _only(b, R=1, P=0):
            out.add("rookPawnVsRook")
        if _only(a, B=1) and _only(b, N=1):
            out.add("bishopVsKnight")
        if _only(a, R=1) and (_only(b, B=1) or _only(b, N=1)):
            out.add("rookVsMinor")
        if _only(a, Q=1) and _only(b, R=1):
            out.add("queenVsRook")
    if _only(me, B=1) and _only(op, B=1):
        wb = next(iter(board.pieces(chess.BISHOP, chess.WHITE)))
        bb = next(iter(board.pieces(chess.BISHOP, chess.BLACK)))
        if (chess.square_file(wb) + chess.square_rank(wb)) % 2 != (chess.square_file(bb) + chess.square_rank(bb)) % 2:
            out.add("oppositeBishops")
    return out


def _in_opposition(board: chess.Board) -> bool:
    """Kings on one file or rank with an odd number of squares between them
    (direct opposition = 1, distant = 3/5), side NOT to move holds it."""
    wk, bk = board.king(chess.WHITE), board.king(chess.BLACK)
    if wk is None or bk is None:
        return False
    df = abs(chess.square_file(wk) - chess.square_file(bk))
    dr = abs(chess.square_rank(wk) - chess.square_rank(bk))
    if df == 0 and dr >= 2:
        return (dr - 1) % 2 == 1
    if dr == 0 and df >= 2:
        return (df - 1) % 2 == 1
    return False


def detect(fen: str, moves: list[str] | str, themes: set[str] | str) -> set[str]:
    """Forked sub-themes provable for one Lichess-format puzzle."""
    if isinstance(moves, str):
        moves = moves.split()
    if isinstance(themes, str):
        themes = set(themes.split())
    if len(moves) < 2:
        return set()
    rep = _replay(fen, moves)
    if rep is None:
        return set()
    boards, mvs = rep
    start = boards[0]                      # solver to move
    pov = start.turn
    out: set[str] = set()

    if "fork" in themes:
        fd = _fork_detail(boards, mvs, pov)
        if fd:
            ptype, targets = fd
            if ptype in FORK_PIECE_THEME:
                out.add(FORK_PIECE_THEME[ptype])
            if chess.KING in targets and chess.QUEEN in targets:
                out.add("royalFork")

    if "sacrifice" in themes:
        for k in range(2, len(mvs), 2):            # opponent replies
            before = boards[k - 1]
            victim = before.piece_at(mvs[k].to_square)
            if victim is None or victim.color != pov:
                continue
            capturer = before.piece_at(mvs[k].from_square)
            prev_capture = boards[k - 2].piece_at(mvs[k - 1].to_square) if k >= 2 else None
            if victim.piece_type == chess.QUEEN and not (prev_capture and prev_capture.piece_type == chess.QUEEN):
                out.add("queenSacrifice")
            if victim.piece_type == chess.ROOK and capturer and capturer.piece_type in (chess.KNIGHT, chess.BISHOP) \
                    and not (prev_capture and prev_capture.piece_type == chess.ROOK):
                out.add("exchangeSacrifice")

    if "pawnEndgame" in themes:
        first = mvs[1]
        mover = start.piece_at(first.from_square)
        if mover and mover.piece_type == chess.KING and _in_opposition(boards[1]):
            out.add("opposition")
        if mover and mover.piece_type == chess.PAWN:
            # pushes onto a square an enemy pawn covers (a pawn sacrifice) and the
            # line ends in promotion or a pawn on the 7th: the classic breakthrough
            to = first.to_square
            covered = any(start.piece_at(a) and start.piece_at(a).piece_type == chess.PAWN
                          for a in start.attackers(not pov, to))
            promotes = any(m.promotion for m in mvs[1::2]) or "promotion" in themes or "advancedPawn" in themes
            if covered and promotes:
                out.add("pawnBreakthrough")

    if "endgame" in themes:
        out |= _material_themes(start, pov)

    return out
