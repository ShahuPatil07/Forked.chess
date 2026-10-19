"""
Mistake mechanism: did the player ALLOW a tactic, MISS one, both, or neither?

The Stage-1 classifier was trained on Lichess puzzles = (position after a blunder,
the winning reply). A real mistake is in that distribution only when we show the
classifier the right position:

    allowed  your move created a tactic for the opponent
             -> classify (fen_after_your_move, opponent's refutation)
    missed   you had a tactic and didn't play it
             -> classify (fen_before, engine best move)
    both     both of the above (classified both ways)
    quiet    no material/mate swing along either line (positional, slow, technique)

Swings are measured as SETTLED material along the engine principal variation,
relative to a baseline that ignores exchanges already in progress, so a plain
recapture is not mistaken for a tactic.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import chess

PIECE_CP = {chess.PAWN: 100, chess.KNIGHT: 300, chess.BISHOP: 300,
            chess.ROOK: 500, chess.QUEEN: 900, chess.KING: 0}
TACTIC_SWING_CP = 200        # >= two pawns of settled material = a tactic
MATE_HORIZON = 12            # mate scores within this many moves count as a mating tactic
SETTLE_PLIES = 10


def material(board: chess.Board, color: chess.Color) -> int:
    s = 0
    for p in board.piece_map().values():
        v = PIECE_CP[p.piece_type]
        s += v if p.color == color else -v
    return s


def settled_gain(board: chess.Board, line: list[str], baseline: Optional[int] = None,
                 plies: int = SETTLE_PLIES) -> int:
    """Material (cp) the side to move nets along `line`, relative to `baseline`
    (default: the current material balance).

    Measured at the last QUIET settled point within `plies`: after a defender
    reply, with no capture made by that reply and none pending on the next
    ply. Otherwise a line cut mid-exchange (…Qxe3+ with the recapture past the
    horizon) reads as a 9-pawn loss."""
    solver = board.turn
    base = material(board, solver) if baseline is None else baseline
    b = board.copy(stack=False)
    moves, mats, caps = [], [], []
    for uci in line[:plies + 1]:
        try:
            mv = chess.Move.from_uci(uci)
            if mv not in b.legal_moves:
                break
        except Exception:
            break
        caps.append(b.is_capture(mv))
        b.push(mv)
        moves.append(mv)
        mats.append(material(b, solver))
        if b.is_game_over():
            break
    n = min(len(moves), plies)
    if n == 0:
        return 0
    if b.is_game_over() and len(moves) <= plies:
        return mats[len(moves) - 1] - base
    pending = lambda i: i + 1 < len(caps) and caps[i + 1]
    settled = list(range(1, n, 2))                       # after each defender reply
    quiet = [i for i in settled if not caps[i] and not pending(i)]
    complete = [i for i in settled if not pending(i)]    # no recapture still to come
    pick = quiet[-1] if quiet else complete[-1] if complete else settled[0] if settled else n - 1
    return mats[pick] - base


EVAL_TACTIC_ES = 0.70       # the punishing side ends up clearly winning ...
EVAL_TACTIC_SWING = 0.15    # ... from a blunder-sized swing ...


def forcing(board: chess.Board, line: list[str], plies: int = 6) -> bool:
    """... along a forcing line: it starts with a check or capture, or the
    solver gives at least two checks within the first plies (an attack)."""
    if not line:
        return False
    b = board.copy(stack=False)
    checks = 0
    for i, uci in enumerate(line[:plies]):
        try:
            mv = chess.Move.from_uci(uci)
            if mv not in b.legal_moves:
                break
        except Exception:
            break
        if i == 0 and (b.is_capture(mv) or b.gives_check(mv)):
            return True
        if i % 2 == 0 and b.gives_check(mv):
            checks += 1
        b.push(mv)
    return checks >= 2


def mate_in(cp: Optional[int], mate: Optional[int]) -> Optional[int]:
    """Positive N if the side to move mates in N (within horizon)."""
    if mate is not None and 0 < mate <= MATE_HORIZON:
        return mate
    return None


@dataclass
class Mechanism:
    direction: str               # allowed | missed | both | quiet
    allowed_kind: Optional[str]  # walked_into | ignored_threat | None
    swing_missed_cp: int
    swing_allowed_cp: int
    mate_missed: Optional[int]
    mate_allowed: Optional[int]
    threat_before_cp: Optional[int]   # opponent's gain if it were their move before yours


def tag_mechanism(
    board_before: chess.Board,
    best_line: list[str],
    played_uci: str,
    reply_line: list[str],
    mate_before: Optional[int],
    mate_after_opp: Optional[int],
    prev_board: Optional[chess.Board] = None,
    threat_line: Optional[list[str]] = None,
    es_before: Optional[float] = None,
    es_after: Optional[float] = None,
) -> Mechanism:
    """
    board_before    position before the player's move (player to move)
    best_line       engine PV from board_before (UCI)
    reply_line      engine PV from the position after the played move (opponent to move)
    mate_before     player mates in N from board_before (engine), else None
    mate_after_opp  opponent mates in N after the played move, else None
    prev_board      position before the opponent's last move (exchange baseline)
    threat_line     engine PV for the OPPONENT from board_before with a null move
                    (what they threatened before the player moved), optional
    """
    me = board_before.turn
    base_me = material(board_before, me)
    if prev_board is not None:
        base_me = max(base_me, material(prev_board, me))
    swing_missed = settled_gain(board_before, best_line, base_me) if best_line else 0

    after = board_before.copy(stack=False)
    after.push(chess.Move.from_uci(played_uci))
    base_opp = max(material(after, not me), material(board_before, not me))
    swing_allowed = settled_gain(after, reply_line, base_opp) if reply_line else 0

    mm = mate_in(None, mate_before)
    ma = mate_in(None, mate_after_opp)
    missed = mm is not None or swing_missed >= TACTIC_SWING_CP
    allowed = ma is not None or swing_allowed >= TACTIC_SWING_CP
    # Sacrificial / attacking tactics win on the board before they win
    # material (Bh7+ Kxh7 Rf7+ …): a forcing line to a clearly winning
    # position after a blunder-sized swing is a tactic too — Lichess builds
    # puzzles on exactly that criterion, not on material.
    if es_before is not None and es_after is not None and es_before - es_after >= EVAL_TACTIC_SWING:
        if not allowed and 1.0 - es_after >= EVAL_TACTIC_ES and forcing(after, reply_line):
            allowed = True
        if not missed and es_before >= EVAL_TACTIC_ES and best_line and best_line[0] != played_uci \
                and forcing(board_before, best_line):
            missed = True

    threat_cp = None
    kind = None
    if allowed:
        kind = "walked_into"
        if threat_line:
            nb = board_before.copy(stack=False)
            nb.push(chess.Move.null())
            threat_cp = settled_gain(nb, threat_line, material(board_before, not me))
            # The opponent already had (roughly) this win before you moved.
            if threat_cp >= TACTIC_SWING_CP and threat_line[:1] == reply_line[:1]:
                kind = "ignored_threat"
            elif threat_cp >= max(TACTIC_SWING_CP, swing_allowed - 100):
                kind = "ignored_threat"

    if missed and allowed:
        direction = "both"
    elif allowed:
        direction = "allowed"
    elif missed:
        direction = "missed"
    else:
        direction = "quiet"
    return Mechanism(direction, kind if allowed else None, int(swing_missed),
                     int(swing_allowed), mm, ma, threat_cp)


def opportunity_gain(board: chess.Board, best_line: list[str], mate: Optional[int],
                     prev_board: Optional[chess.Board] = None) -> tuple[bool, int]:
    """Was a tactic available to the side to move? (for found/missed hit rates)"""
    me = board.turn
    base = material(board, me)
    if prev_board is not None:
        base = max(base, material(prev_board, me))
    gain = settled_gain(board, best_line, base) if best_line else 0
    return (mate_in(None, mate) is not None or gain >= TACTIC_SWING_CP), int(gain)
