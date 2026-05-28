"""
Rule-based tactical threat classifier — 14 categories (13 classifiable + other).

Given the FEN before a mistake and the best move the engine preferred,
classify what type of tactic was available but missed.

Priority order (descending precision on the trained classifier):
  back_rank → fork → pin → skewer → hanging_piece → discovered_attack
  → removing_defender → deflection → trapped_piece → king_attack
  → passed_pawn → piece_activity → endgame_technique → other

These 14 categories match the ML model's output vocabulary exactly.
Absorbed categories (no separate rule, subsumed by neighbours):
  overloaded_piece  → removing_defender  (removing a piece that guarded 2+ targets)
  zwischenzug       → king_attack        (any in-between check)
  missed_threat     → hanging_piece      (opponent left piece undefended)
  pawn_structure    → passed_pawn        (structural pawn moves)
"""
import chess

PIECE_VALUES = {
    chess.PAWN:   1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK:   5,
    chess.QUEEN:  9,
    chess.KING:   0,
}

THREAT_TYPES = (
    "back_rank",          # R/Q delivers check/mate on opponent's back rank
    "fork",               # piece attacks 2+ valuable pieces simultaneously
    "pin",                # move creates an absolute pin on an opponent piece
    "skewer",             # slider attacks high-value piece, lower-value behind it
    "hanging_piece",      # best move captures undefended / under-defended piece
    "discovered_attack",  # moving piece reveals a slider's attack on a new target
    "removing_defender",  # capture removes the sole (or overloaded) guardian
    "deflection",         # non-capture forces a key defender away from its post
    "trapped_piece",      # after move, opponent piece has no safe escape
    "king_attack",        # delivers check OR piece invades the king's adjacent zone
    "passed_pawn",        # advances / promotes a passed pawn; structural pawn moves
    "piece_activity",     # dramatically activates a passive piece (+4 attacked squares)
    "endgame_technique",  # king move missed in a low-material endgame
    "other",              # true fallback — should be rare
)  # 14 types


def classify_threat(fen: str, best_move_uci: str) -> str:
    """Return the dominant tactical theme of `best_move_uci` in position `fen`."""
    if not best_move_uci:
        return "other"

    try:
        board = chess.Board(fen)
        move  = chess.Move.from_uci(best_move_uci)
    except (ValueError, chess.InvalidMoveError):
        return "other"

    if move not in board.legal_moves:
        return "other"

    if _is_back_rank(board, move):          return "back_rank"
    if _is_fork(board, move):               return "fork"
    if _creates_pin(board, move):           return "pin"
    if _is_skewer(board, move):             return "skewer"
    if _is_hanging_piece(board, move):      return "hanging_piece"
    if _is_discovered_attack(board, move):  return "discovered_attack"
    if _is_removing_defender(board, move):  return "removing_defender"
    if _is_deflection(board, move):         return "deflection"
    if _is_trapped_piece(board, move):      return "trapped_piece"
    if _is_king_attack(board, move):        return "king_attack"
    if _is_passed_pawn(board, move):        return "passed_pawn"
    if _is_piece_activity(board, move):     return "piece_activity"
    if _is_endgame_technique(board, move):  return "endgame_technique"
    return "other"


# ---------------------------------------------------------------------------
# Detectors
# ---------------------------------------------------------------------------

def _is_back_rank(board: chess.Board, move: chess.Move) -> bool:
    """True if the move delivers or strongly threatens a back-rank checkmate."""
    after = board.copy()
    after.push(move)

    if after.is_checkmate():
        piece = after.piece_at(move.to_square)
        if piece and piece.piece_type in (chess.ROOK, chess.QUEEN):
            opp_king = after.king(after.turn)
            if opp_king is not None and chess.square_rank(opp_king) in (0, 7):
                return True

    if after.is_check():
        piece = board.piece_at(move.from_square)
        if piece and piece.piece_type in (chess.ROOK, chess.QUEEN):
            opp_king = after.king(after.turn)
            if opp_king is not None and chess.square_rank(opp_king) in (0, 7):
                if len(list(after.legal_moves)) <= 2:
                    return True

    return False


def _is_fork(board: chess.Board, move: chess.Move) -> bool:
    """True if the move attacks two or more valuable enemy pieces simultaneously."""
    after = board.copy()
    after.push(move)

    moved_piece = after.piece_at(move.to_square)
    if not moved_piece:
        return False

    mover_value = PIECE_VALUES.get(moved_piece.piece_type, 0)
    opponent    = not moved_piece.color
    targets     = []

    for sq in after.attacks(move.to_square):
        victim = after.piece_at(sq)
        if victim is None or victim.color != opponent:
            continue
        if victim.piece_type == chess.PAWN:
            continue
        victim_value = PIECE_VALUES.get(victim.piece_type, 0)
        if (
            victim.piece_type == chess.KING
            or victim_value > mover_value
            or not after.is_attacked_by(opponent, sq)
        ):
            targets.append(sq)

    return len(targets) >= 2


def _creates_pin(board: chess.Board, move: chess.Move) -> bool:
    """True if the move creates an absolute pin on any opponent piece."""
    after = board.copy()
    after.push(move)

    opponent = after.turn
    for sq in chess.SQUARES:
        piece = after.piece_at(sq)
        if piece and piece.color == opponent and after.is_pinned(opponent, sq):
            return True
    return False


def _is_skewer(board: chess.Board, move: chess.Move) -> bool:
    """
    True if a slider (R/B/Q) move attacks a high-value piece (R/Q/K) and, on
    the same ray beyond that piece, there is another opponent piece.
    """
    after = board.copy()
    after.push(move)

    piece = after.piece_at(move.to_square)
    if not piece or piece.piece_type not in (chess.ROOK, chess.BISHOP, chess.QUEEN):
        return False

    opp   = not piece.color
    to_sq = move.to_square

    for att_sq in after.attacks(to_sq):
        target = after.piece_at(att_sq)
        if not target or target.color != opp:
            continue
        if target.piece_type not in (chess.KING, chess.QUEEN, chess.ROOK):
            continue

        pr, pf = chess.square_rank(to_sq),  chess.square_file(to_sq)
        tr, tf = chess.square_rank(att_sq), chess.square_file(att_sq)
        dr, df = tr - pr, tf - pf
        steps  = max(abs(dr), abs(df))
        if steps == 0:
            continue
        step_r, step_f = dr // steps, df // steps

        r, f = tr + step_r, tf + step_f
        while 0 <= r <= 7 and 0 <= f <= 7:
            beyond_sq = chess.square(f, r)
            behind    = after.piece_at(beyond_sq)
            if behind:
                if behind.color == opp:
                    return True
                break
            r += step_r
            f += step_f

    return False


def _is_hanging_piece(board: chess.Board, move: chess.Move) -> bool:
    """
    True if the best move captures a piece that is either:
      (a) completely undefended, or
      (b) defended but the attacker is worth less (winning exchange).
    """
    if not board.is_capture(move):
        return False

    victim   = board.piece_at(move.to_square)
    attacker = board.piece_at(move.from_square)

    if victim is None or attacker is None:
        return False

    victim_val   = PIECE_VALUES.get(victim.piece_type, 0)
    attacker_val = PIECE_VALUES.get(attacker.piece_type, 0)

    undefended = not board.is_attacked_by(victim.color, move.to_square)
    good_trade = victim_val > attacker_val

    return undefended or good_trade


def _is_discovered_attack(board: chess.Board, move: chess.Move) -> bool:
    """
    True if moving the piece reveals an attack from one of our OTHER sliders
    onto a high-value opponent piece (knight or better).
    """
    mover   = board.turn
    opp     = not mover
    from_sq = move.from_square

    after = board.copy()
    after.push(move)

    for sq in chess.SQUARES:
        piece = board.piece_at(sq)
        if not piece or piece.color != mover or sq == from_sq:
            continue
        if piece.piece_type not in (chess.ROOK, chess.BISHOP, chess.QUEEN):
            continue

        before_attacks = board.attacks(sq)
        after_attacks  = after.attacks(sq)
        new_attacks    = after_attacks & ~before_attacks

        for target_sq in new_attacks:
            target = after.piece_at(target_sq)
            if target and target.color == opp and PIECE_VALUES.get(target.piece_type, 0) >= 3:
                return True

    return False


def _is_removing_defender(board: chess.Board, move: chess.Move) -> bool:
    """
    True if the best move captures a piece that was the sole (or overloaded)
    guardian of another opponent piece, leaving it hanging.
    Subsumes the former overloaded_piece detector.
    """
    if not board.is_capture(move):
        return False

    mover       = board.turn
    opp         = not mover
    captured_sq = move.to_square

    after = board.copy()
    after.push(move)

    for defended_sq in board.attacks(captured_sq):
        defended = board.piece_at(defended_sq)
        if not defended or defended.color != opp:
            continue
        if PIECE_VALUES.get(defended.piece_type, 0) < 3:
            continue

        if (after.is_attacked_by(mover, defended_sq) and
                not after.is_attacked_by(opp, defended_sq)):
            return True

    return False


def _is_deflection(board: chess.Board, move: chess.Move) -> bool:
    """
    True if the best move (non-capture) attacks an opponent piece that is
    the sole defender of another valuable opponent piece.
    """
    if board.is_capture(move):
        return False

    after = board.copy()
    after.push(move)

    mover = board.turn
    opp   = not mover

    for attacked_sq in after.attacks(move.to_square):
        attacked = after.piece_at(attacked_sq)
        if not attacked or attacked.color != opp:
            continue
        if PIECE_VALUES.get(attacked.piece_type, 0) < 2:
            continue

        temp = after.copy()
        temp.remove_piece_at(attacked_sq)

        for other_sq in chess.SQUARES:
            if other_sq == attacked_sq:
                continue
            other_piece = temp.piece_at(other_sq)
            if not other_piece or other_piece.color != opp:
                continue
            if PIECE_VALUES.get(other_piece.piece_type, 0) < 3:
                continue
            if other_sq not in after.attacks(attacked_sq):
                continue
            if (temp.is_attacked_by(mover, other_sq) and
                    not temp.is_attacked_by(opp, other_sq)):
                return True

    return False


def _is_trapped_piece(board: chess.Board, move: chess.Move) -> bool:
    """
    True if after our move an opponent piece (>= bishop value) is attacked by us
    and has no safe escape square (heuristic).
    """
    mover = board.turn
    opp   = not mover

    after = board.copy()
    after.push(move)

    for sq in chess.SQUARES:
        piece = after.piece_at(sq)
        if not piece or piece.color != opp:
            continue
        if PIECE_VALUES.get(piece.piece_type, 0) < 3:
            continue
        if not after.is_attacked_by(mover, sq):
            continue

        has_escape = False
        for target_sq in after.attacks(sq):
            occupant = after.piece_at(target_sq)
            if occupant and occupant.color == opp:
                continue
            if not after.is_attacked_by(mover, target_sq):
                has_escape = True
                break

        if not has_escape:
            return True

    return False


def _is_king_attack(board: chess.Board, move: chess.Move) -> bool:
    """
    True if the move:
      (a) delivers check (including discovered check / zwischenzug), OR
      (b) a non-pawn piece lands on a square directly adjacent to the enemy king.
    """
    after = board.copy()
    after.push(move)

    if after.is_check():
        return True

    opp_king = after.king(after.turn)
    if opp_king is None:
        return False

    piece = after.piece_at(move.to_square)
    if not piece or piece.piece_type == chess.PAWN:
        return False

    king_adjacent = chess.BB_KING_ATTACKS[opp_king]
    return bool(chess.BB_SQUARES[move.to_square] & king_adjacent)


def _is_passed_pawn(board: chess.Board, move: chess.Move) -> bool:
    """
    True if the move involves advancing or promoting a passed pawn,
    or is a pawn move that creates a new passed pawn (structural benefit).
    Subsumes the former pawn_structure detector.
    """
    piece = board.piece_at(move.from_square)
    if piece is None or piece.piece_type != chess.PAWN:
        return False

    if move.promotion:
        return True

    mover = piece.color
    opp   = not mover
    file  = chess.square_file(move.from_square)
    rank  = chess.square_rank(move.from_square)

    # Check if this pawn is already passed (no opposing pawns blocking/adjacent ahead)
    adj_files = [f for f in (file - 1, file, file + 1) if 0 <= f <= 7]
    opp_pawns = board.pieces(chess.PAWN, opp)
    is_passed = True
    for pawn_sq in opp_pawns:
        if chess.square_file(pawn_sq) not in adj_files:
            continue
        pawn_rank = chess.square_rank(pawn_sq)
        if mover == chess.WHITE and pawn_rank > rank:
            is_passed = False
            break
        if mover == chess.BLACK and pawn_rank < rank:
            is_passed = False
            break

    if is_passed:
        return True

    # Also fire if the push *creates* a new passed pawn
    def _count_passed(b: chess.Board, color: chess.Color) -> int:
        enemy = not color
        ep    = b.pieces(chess.PAWN, enemy)
        count = 0
        for sq in b.pieces(chess.PAWN, color):
            f2, r2 = chess.square_file(sq), chess.square_rank(sq)
            adj2   = [ff for ff in (f2 - 1, f2, f2 + 1) if 0 <= ff <= 7]
            ok = True
            for esq in ep:
                if chess.square_file(esq) in adj2:
                    er = chess.square_rank(esq)
                    if (color == chess.WHITE and er > r2) or (color == chess.BLACK and er < r2):
                        ok = False
                        break
            if ok:
                count += 1
        return count

    after = board.copy()
    after.push(move)
    return _count_passed(after, mover) > _count_passed(board, mover)


def _is_piece_activity(board: chess.Board, move: chess.Move) -> bool:
    """
    True if the best move dramatically activates a passive piece: non-capture,
    non-check, non-pawn/king move that gains >= 4 new attacked squares.
    """
    piece = board.piece_at(move.from_square)
    if piece is None or piece.piece_type in (chess.PAWN, chess.KING):
        return False
    if board.is_capture(move):
        return False

    after = board.copy()
    after.push(move)

    if after.is_check():
        return False

    attacks_before = len(board.attacks(move.from_square))
    attacks_after  = len(after.attacks(move.to_square))
    return (attacks_after - attacks_before) >= 4


def _is_endgame_technique(board: chess.Board, move: chess.Move) -> bool:
    """
    True if the best move is a king move in a low-material position
    (total non-pawn material <= 20 points).
    """
    piece = board.piece_at(move.from_square)
    if piece is None or piece.piece_type != chess.KING:
        return False

    total_material = sum(
        len(board.pieces(pt, chess.WHITE) | board.pieces(pt, chess.BLACK))
        * PIECE_VALUES[pt]
        for pt in (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT)
    )
    return total_material <= 20
