"""
"Why it works" for a solved puzzle - a deterministic, board-proven narration of
the solution line. No LLM: every sentence is read off python-chess, so it can't
hallucinate a piece that isn't there.

Input is the Lichess puzzle format (FEN before the opponent's trigger move, UCI
moves with the trigger first). For each solver move it reports what the board
proves: checks / double / discovered checks, captures (and whether the victim
was undefended), forks with their targets, new pins, unmasked line attacks,
sacrifices and promotions. Opponent replies are marked forced when they are the
only legal move. A summary gives the net material swing or the forced mate.
"""
from __future__ import annotations

import chess

from ml.classifier.verifier import VALUES, _is_hanging, _material_diff, verify
from ml.puzzles.subthemes import _in_opposition

NAMES = {chess.PAWN: "pawn", chess.KNIGHT: "knight", chess.BISHOP: "bishop",
         chess.ROOK: "rook", chess.QUEEN: "queen", chess.KING: "king"}
SIDE = {chess.WHITE: "White", chess.BLACK: "Black"}
LINE_PIECES = (chess.BISHOP, chess.ROOK, chess.QUEEN)


def _piece(board: chess.Board, sq: int) -> str:
    p = board.piece_at(sq)
    return f"the {NAMES[p.piece_type]} on {chess.square_name(sq)}" if p else chess.square_name(sq)


def _first_behind(board: chess.Board, origin: int, target: int) -> int | None:
    """The first occupied square past `target` on the line origin -> target."""
    df = (chess.square_file(target) > chess.square_file(origin)) - (chess.square_file(target) < chess.square_file(origin))
    dr = (chess.square_rank(target) > chess.square_rank(origin)) - (chess.square_rank(target) < chess.square_rank(origin))
    f, r = chess.square_file(target) + df, chess.square_rank(target) + dr
    while 0 <= f < 8 and 0 <= r < 8:
        sq = chess.square(f, r)
        if board.piece_at(sq):
            return sq
        f, r = f + df, r + dr
    return None


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


def _targets(board: chess.Board, sq: int, pov: chess.Color) -> list[int]:
    """Enemy pieces the piece on `sq` attacks that are worth more than it, or loose."""
    mover = board.piece_at(sq)
    if mover is None:
        return []
    mv = 99 if mover.piece_type == chess.KING else VALUES[mover.piece_type]
    out = []
    for t in board.attacks(sq):
        p = board.piece_at(t)
        if p is None or p.color == pov or p.piece_type == chess.PAWN:
            continue
        if p.piece_type == chess.KING or VALUES[p.piece_type] > mv or _is_hanging(board, p, t):
            out.append(t)
    return out


def _solver_notes(before: chess.Board, mv: chess.Move, after: chess.Board,
                  nxt: chess.Move | None, nxt2: chess.Move | None) -> list[str]:
    pov = before.turn
    notes: list[str] = []
    moved = after.piece_at(mv.to_square)
    captured = before.piece_at(mv.to_square)
    if before.is_en_passant(mv):
        notes.append("captures en passant")
    elif captured:
        loose = _is_hanging(before, captured, mv.to_square)
        notes.append(f"takes {_piece(before, mv.to_square)}" + (", which was undefended" if loose else ""))
    if mv.promotion:
        notes.append(f"promotes to a {NAMES[mv.promotion]}")
    if before.is_castling(mv):
        notes.append("castles")
    if before.is_check() and moved and moved.piece_type != chess.KING and not captured:
        notes.append("blocks the check")

    if after.is_checkmate():
        notes.append("checkmate")
        return notes
    checkers = after.checkers()
    if len(checkers) > 1:
        notes.append("double check, so the king has to move")
    elif checkers and mv.to_square not in checkers:
        notes.append(f"discovered check from {_piece(after, next(iter(checkers)))}")
    elif checkers:
        notes.append("check")

    # fork: the moved piece hits two or more valuable / loose targets
    tg = _targets(after, mv.to_square, pov)
    taken_next = nxt is not None and nxt.to_square == mv.to_square
    if moved and len(tg) >= 2 and not taken_next:
        notes.append(f"forks {_join([_piece(after, t) for t in tg])}")

    # new pins created by the moved line piece
    if moved and moved.piece_type in LINE_PIECES:
        for sq, p in after.piece_map().items():
            if p.color == pov or p.piece_type == chess.KING:
                continue
            if after.is_pinned(not pov, sq) and not before.is_pinned(not pov, sq):
                ray = chess.SquareSet.ray(mv.to_square, sq)
                if ray and after.king(not pov) in ray:
                    notes.append(f"pins {_piece(after, sq)} to the king")

    # skewer: the moved line piece hits a valuable piece with another one behind it
    if moved and moved.piece_type in LINE_PIECES:
        for t in after.attacks(mv.to_square):
            front = after.piece_at(t)
            if not front or front.color == pov or front.piece_type == chess.PAWN:
                continue
            if front.piece_type != chess.KING and VALUES[front.piece_type] <= VALUES[moved.piece_type]:
                continue
            beyond = _first_behind(after, mv.to_square, t)
            if beyond is None:
                continue
            back = after.piece_at(beyond)
            if back.color != pov and back.piece_type != chess.PAWN:
                notes.append(f"skewers {_piece(after, t)} to {_piece(after, beyond)}")
                break

    if moved and moved.piece_type == chess.KING and _in_opposition(after) \
            and not (after.pieces(chess.QUEEN, chess.WHITE) | after.pieces(chess.QUEEN, chess.BLACK)):
        notes.append("takes the opposition")

    # discovered attack: a line piece behind the moved one now hits a big target
    for sq in after.pieces(chess.BISHOP, pov) | after.pieces(chess.ROOK, pov) | after.pieces(chess.QUEEN, pov):
        if sq == mv.to_square:
            continue
        for t in after.attacks(sq):
            p = after.piece_at(t)
            if not p or p.color == pov or p.piece_type in (chess.PAWN, chess.KING):
                continue
            if t in before.attacks(sq):
                continue
            if mv.from_square in chess.SquareSet.between(sq, t) and (
                    VALUES[p.piece_type] > VALUES[after.piece_at(sq).piece_type] or _is_hanging(after, p, t)):
                notes.append(f"uncovers {_piece(after, sq)} against {_piece(after, t)}")

    # sacrifice / attraction: the opponent's reply captures the piece that just moved
    if nxt is not None and nxt.to_square == mv.to_square and moved and moved.piece_type != chess.PAWN:
        taken_val = VALUES[moved.piece_type]
        got = VALUES[captured.piece_type] if captured else 0
        if taken_val > got + 1:
            capturer = after.piece_at(nxt.from_square)
            if nxt2 is not None and nxt2.to_square == mv.to_square and capturer:
                notes.append(f"lures the {NAMES[capturer.piece_type]} onto {chess.square_name(mv.to_square)}")
            else:
                notes.append(f"offers the {NAMES[moved.piece_type]} as a sacrifice")
    return notes


def _material_phrase(gain: int) -> str:
    if gain >= 9:
        return f"you come out a queen's worth ahead (+{gain})"
    if gain >= 5:
        return f"you come out a rook's worth ahead (+{gain})"
    if gain >= 3:
        return f"you win a piece (+{gain})"
    if gain >= 1:
        return f"you win {'a pawn' if gain == 1 else f'{gain} pawns'} (+{gain})"
    if gain == 0:
        return "material stays level, but your position is far better"
    return f"you give up material ({gain}) for a winning position"


def explain(fen: str, moves: list[str] | str) -> dict:
    if isinstance(moves, str):
        moves = moves.split()
    board = chess.Board(fen)
    trigger = None
    steps = []
    if moves:
        trig = chess.Move.from_uci(moves[0])
        trigger = {"san": board.san(trig), "side": SIDE[board.turn]}
        board.push(trig)
    start = board.copy(stack=False)
    pov = board.turn
    line = moves[1:]
    mvs = [chess.Move.from_uci(u) for u in line]
    for i, mv in enumerate(mvs):
        if mv not in board.legal_moves:
            break
        before = board.copy(stack=False)
        forced = before.legal_moves.count() == 1
        san = before.san(mv)
        board.push(mv)
        mine = before.turn == pov
        if mine:
            nxt = mvs[i + 1] if i + 1 < len(mvs) else None
            nxt2 = mvs[i + 2] if i + 2 < len(mvs) else None
            notes = _solver_notes(before, mv, board, nxt, nxt2)
        else:
            notes = []
            cap = before.piece_at(mv.to_square)
            if cap:
                notes.append(f"takes {_piece(before, mv.to_square)}")
            if forced:
                notes.append("the only legal move")
            elif before.is_check():
                notes.append("gets out of check")
        steps.append({"san": san, "uci": mv.uci(), "mine": mine, "notes": notes,
                      "move_no": before.fullmove_number, "white": before.turn == chess.WHITE})

    gain = _material_diff(board, pov) - _material_diff(start, pov)
    my_moves = sum(1 for s in steps if s["mine"])
    if board.is_checkmate():
        summary = f"Forced mate in {my_moves}." if my_moves > 1 else "Mate in one."
    else:
        summary = _material_phrase(gain)
        summary = summary[0].upper() + summary[1:] + "."
    motifs = sorted(verify(start, line, moves[0] if moves else None, chess.Board(fen)))
    return {"trigger": trigger, "steps": steps, "summary": summary, "material": gain,
            "mate": board.is_checkmate(), "verified": motifs, "solver": SIDE[pov]}
