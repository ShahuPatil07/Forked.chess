"""
Legality-constrained decoding of a handwritten scoresheet into a legal game.

A reader (vision LLM / OCR) gives us, for each written cell, one or more noisy
readings. Real scoresheets are messy at the source as well as hard to read:
amateurs write "Nd7" when two knights can go there, "de" or "dxe" for a pawn
capture, "NxN" / "QxB" (capture by piece type), skip a move, cross one out, or
put a wrong square. The old corrector walked the sheet greedily and gave up at
the first cell it couldn't place, so one misread broke every move after it.

This module instead searches over *legal games*: a beam search that aligns the
sequence of written cells with a sequence of legal moves, where each step can

  match   a cell with a legal move    cost = how badly the move fits the reading
  delete  a cell (scribble/crossed-out/"resigns")         cost = DEL
  insert  a legal move nobody wrote down, then match      cost = INS + match

and keeps the B cheapest partial games (merged by position). The fit of a move
to a reading is the cheaper of
  - a handwriting-aware edit distance (b/6, g/9, S/5, N/H, Q/a, B/R ... are cheap
    substitutions; dropping 'x', '+' or a disambiguation letter is nearly free)
  - a structural reading of amateur shorthand ("de", "NxN", "R6", "Bg", "c1Q").

Every decoded ply comes back with a status the review screen can show:
  exact      the reading is the move
  corrected  the reading was off but only one legal move fits (e.g. "Bd7" -> "Bd6")
  uncertain  several legal moves fit about as well -> ask the user
  inferred   no cell for it: the move was missing from the sheet
plus the top alternative legal moves for one-tap fixing.
"""
from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field
from functools import lru_cache

import chess

# ── costs (units ~ "one clearly wrong character") ───────────────────────────
DEL = 2.4          # drop a written cell
DEL_TAIL = 0.9     # drop a cell after the last decoded move (results, scribbles)
INS = 2.6          # a legal move that has no cell
EMPTY = 0.9        # a blank cell that still had a move (players forget to write one); the prior picks it
DEL_EMPTY = 0.9    # drop a blank cell mid-game (shifts every later cell into the wrong column)
PARITY = 0.35      # move lands in the other colour's column
MAX_FIT = 4.0      # cap per-reading distance
BEAM = int(os.getenv("SCORESHEET_BEAM", "64"))          # partial games kept per cell (accuracy over speed)
PRIOR_W = 0.3      # weight of the human-move prior (nats -> cost), only where a cell needs correcting
PRIOR_W_EMPTY = 0.15  # on blank cells: two blanks together must never outweigh one clearly read cell
PRIOR_CAP = 2.5    # max prior penalty (nats) -- never outvotes clear handwriting evidence
PRIOR_STATES = 4   # only the best few partial games get the (batched) model call (~10 ms per position)
MAX_ROW_GAP = 6    # a jump in row numbers up to this is blank rows; larger = numbering jump
INS_CANDIDATES = 8 # with a prior, how many likely moves to try as the unwritten one
WIDE_BEAM = int(os.getenv("SCORESHEET_WIDE_BEAM", "400"))  # after a blank cell: many games fit until later cells rule them out
WIDE_SPAN = 6      # ... for this many cells

# Handwriting / OCR confusions -> substitution cost (default 1.0).
_CONF = [
    ("b", "6", .35), ("g", "9", .35), ("q", "9", .5), ("S", "5", .3), ("s", "5", .35), ("l", "1", .3),
    ("I", "1", .3), ("i", "1", .45), ("z", "2", .45), ("Z", "2", .45), ("o", "0", .3), ("O", "0", .2),
    ("D", "0", .6), ("N", "H", .35), ("N", "M", .4), ("N", "W", .55), ("N", "K", .7), ("B", "8", .35),
    ("B", "R", .55), ("B", "3", .6), ("R", "K", .65), ("Q", "O", .35), ("Q", "0", .45), ("Q", "a", .6),
    ("Q", "G", .5), ("Q", "g", .55), ("e", "c", .45), ("e", "a", .6), ("e", "l", .65), ("a", "d", .55),
    ("a", "o", .5), ("a", "q", .55), ("c", "o", .6), ("d", "a", .55), ("f", "t", .45), ("f", "l", .6),
    ("h", "b", .5), ("h", "n", .5), ("h", "k", .6), ("b", "d", .55), ("b", "h", .5), ("g", "q", .5),
    ("1", "7", .5), ("2", "7", .6), ("3", "8", .55), ("3", "5", .6), ("4", "9", .5), ("4", "A", .6),
    ("5", "6", .6), ("6", "0", .6), ("7", "/", .6), ("x", "X", .05), ("x", "*", .2), ("x", "+", .5),
    ("K", "k", .2), ("Q", "q", .2), ("R", "r", .25), ("N", "n", .2), ("B", "b", .45),
]
SUB: dict[tuple[str, str], float] = {}
for a, b, c in _CONF:
    SUB[(a, b)] = SUB[(b, a)] = min(c, SUB.get((a, b), 9))
CHEAP_INDEL = {"x": .25, "+": .05, "#": .05, "=": .1, "-": .2}

NAMES = {"K": chess.KING, "Q": chess.QUEEN, "R": chess.ROOK, "B": chess.BISHOP, "N": chess.KNIGHT, "P": chess.PAWN}
LETTER = {v: k for k, v in NAMES.items()}


# ── readings ────────────────────────────────────────────────────────────────

def norm_reading(s: str) -> str:
    """Canonicalise a raw cell reading without guessing at the chess content."""
    s = (s or "").strip()
    s = re.sub(r"\s+", "", s)
    s = s.replace("×", "x").replace("–", "-").replace("—", "-").replace("‐", "-")
    s = re.sub(r"[!?]+", "", s)
    s = re.sub(r"\(.*?\)", "", s)
    s = re.sub(r"(?i)e\.?p\.?$", "", s)
    if re.fullmatch(r"[0oO](?:-?[0oO]){2}[+#]?", s):
        return "O-O-O"
    if re.fullmatch(r"[0oO]-?[0oO][+#]?", s):
        return "O-O"
    return s


def san_key(san: str) -> str:
    return re.sub(r"[+#]", "", san)


def _lev(a: str, b: str) -> float:
    """Confusion-weighted edit distance."""
    n, m = len(a), len(b)
    prev = [0.0] * (m + 1)
    for j in range(1, m + 1):
        prev[j] = prev[j - 1] + CHEAP_INDEL.get(b[j - 1], 1.0)
    for i in range(1, n + 1):
        ca = a[i - 1]
        cur = [prev[0] + CHEAP_INDEL.get(ca, 1.0)] + [0.0] * m
        for j in range(1, m + 1):
            cb = b[j - 1]
            sub = 0.0 if ca == cb else SUB.get((ca, cb), 1.0)
            cur[j] = min(prev[j] + CHEAP_INDEL.get(ca, 1.0),
                         cur[j - 1] + CHEAP_INDEL.get(cb, 1.0),
                         prev[j - 1] + sub)
        prev = cur
    return prev[m]


@dataclass(frozen=True)
class MoveInfo:
    san: str
    key: str          # SAN without +/#
    plain: str        # minimal written form: no disambiguation, no 'x'
    piece: str        # K Q R B N P
    from_file: str
    to_file: str
    to_rank: str
    capture: str      # letter of captured piece, "" if none
    promo: str


def position_infos(board: chess.Board) -> tuple[list[MoveInfo], list[chess.Move]]:
    """MoveInfo for every legal move of a position in one pass.

    SAN (without check suffix) is built here instead of via board.san(): python-chess
    regenerates the legal moves for every single move to decide disambiguation, which
    made SAN the decoder's hottest path. Grouping the legal moves by (piece, target)
    once gives the same SAN (tests/test_scoresheet_decoder.py checks it) far faster."""
    moves = list(board.legal_moves)
    pieces = board.piece_map()
    groups: dict[tuple[int, int], list[chess.Move]] = {}
    for m in moves:
        pt = pieces[m.from_square].piece_type
        if pt not in (chess.PAWN, chess.KING):
            groups.setdefault((pt, m.to_square), []).append(m)
    infos = []
    for m in moves:
        pt = pieces[m.from_square].piece_type
        piece = LETTER[pt]
        to = chess.square_name(m.to_square)
        frm = chess.square_name(m.from_square)
        victim = pieces.get(m.to_square)
        ep = pt == chess.PAWN and board.ep_square == m.to_square and victim is None and frm[0] != to[0]
        cap = "P" if ep else (LETTER[victim.piece_type] if victim is not None and victim.color != board.turn else "")
        promo = LETTER[m.promotion] if m.promotion else ""
        if pt == chess.KING and board.is_castling(m):
            san = "O-O" if chess.square_file(m.to_square) > chess.square_file(m.from_square) else "O-O-O"
            plain = san
        elif pt == chess.PAWN:
            san = (frm[0] + "x" + to if cap else to) + (f"={promo}" if promo else "")
            plain = (frm[0] + to if cap else to) + (f"={promo}" if promo else "")
        else:
            dis = ""
            rivals = [o for o in groups.get((pt, m.to_square), []) if o.from_square != m.from_square]
            if rivals:
                if all(chess.square_file(o.from_square) != chess.square_file(m.from_square) for o in rivals):
                    dis = frm[0]
                elif all(chess.square_rank(o.from_square) != chess.square_rank(m.from_square) for o in rivals):
                    dis = frm[1]
                else:
                    dis = frm
            san = piece + dis + ("x" if cap else "") + to
            plain = piece + to
        infos.append(MoveInfo(san, san, plain, piece, frm[0], to[0], to[1], cap, promo))
    return infos, moves


def move_info(board: chess.Board, mv: chess.Move) -> MoveInfo:
    """MoveInfo for one move (convenience; the decoder uses position_infos)."""
    infos, moves = position_infos(board)
    return infos[moves.index(mv)]


_PAWN_CAP = re.compile(r"^([a-h])[x:]?([a-h])$")                  # de, dxe
_PIECE_X_PIECE = re.compile(r"^([KQRBNP]|[a-h])x([KQRBNP])$")    # NxN, QxB, exN
_PIECE_FILE = re.compile(r"^([KQRBN])x?([a-h])$")                 # Bg, Rxh
_PIECE_RANK = re.compile(r"^([KQRBN])x?([1-8])$")                 # R6, N4
_PROMO = re.compile(r"^([a-h]x?)?([a-h][18])=?([QRBN])$")         # c1Q, e8=Q, dxe8Q


def structural(mi: MoveInfo, r: str) -> float | None:
    """Fit of a move to amateur shorthand, or None if the reading isn't shorthand."""
    if (m := _PAWN_CAP.match(r)) and mi.piece == "P":
        return .3 if (mi.capture and mi.from_file == m.group(1) and mi.to_file == m.group(2)) else None
    if m := _PIECE_X_PIECE.match(r):
        mover, victim = m.group(1), m.group(2)
        ok_mover = mi.piece == mover or (mover in "abcdefgh" and mi.piece == "P" and mi.from_file == mover)
        return .35 if ok_mover and mi.capture == victim else None
    if (m := _PIECE_FILE.match(r)) and mi.piece == m.group(1) and mi.to_file == m.group(2):
        return .7
    if (m := _PIECE_RANK.match(r)) and mi.piece == m.group(1) and mi.to_rank == m.group(2):
        return .8
    if (m := _PROMO.match(r)) and mi.promo == m.group(3) and mi.to_file + mi.to_rank == m.group(2):
        return .1
    return None


@lru_cache(maxsize=200_000)
def fit(mi: MoveInfo, r: str) -> float:
    """How badly move `mi` fits one normalised reading `r` (0 = perfect)."""
    if not r:
        return EMPTY
    if r == mi.key:
        return 0.0
    if r.startswith("O-O") or mi.key.startswith("O-O"):
        return 0.0 if r == mi.key else (1.2 if r.startswith("O-O") and mi.key.startswith("O-O") else MAX_FIT)
    best = min(_lev(r, mi.key), _lev(r, mi.plain) + .15)
    # a lowercase leading letter is usually a piece written small, except b (pawn file)
    if r[0] in "kqrn" and len(r) > 1:
        best = min(best, _lev(r[0].upper() + r[1:], mi.key) + .2)
    s = structural(mi, r)
    if s is not None:
        best = min(best, s)
    return min(best, MAX_FIT)


@dataclass
class Cell:
    row: int
    color: str                      # "w" / "b"
    reads: list[tuple[str, float]]  # (normalised reading, weight), weights sum to 1
    raw: str = ""

    @property
    def empty(self) -> bool:
        return not any(r for r, _ in self.reads)


def cell_cost(mi: MoveInfo, cell: Cell) -> float:
    if cell.empty:
        return EMPTY
    # soft-min over readings, weighted
    return min(fit(mi, r) - .6 * math.log(max(w, 1e-3)) for r, w in cell.reads if r) if any(
        r for r, _ in cell.reads) else EMPTY


# ── beam search ─────────────────────────────────────────────────────────────

@dataclass(order=True)
class _State:
    cost: float
    board: chess.Board = field(compare=False)
    path: list = field(compare=False, default_factory=list)  # (kind, cell_idx|None, san, uci, cost)


class _InfoCache:
    """Legal moves (+ their MoveInfo) per position, keyed by python-chess's cheap transposition key."""

    def __init__(self):
        self.d: dict[tuple, tuple[list[MoveInfo], list[chess.Move]]] = {}

    def get(self, board: chess.Board) -> tuple[list[MoveInfo], list[chess.Move]]:
        k = board._transposition_key()
        if k not in self.d:
            self.d[k] = position_infos(board)
        return self.d[k]


def decode(cells: list[Cell], start_fen: str = chess.STARTING_FEN, beam: int = BEAM,
           pins: dict[int, str] | None = None, prior=None) -> dict:
    """Best legal game for the written cells. See module docstring.

    `pins` maps a ply index to a UCI move the user confirmed on the review
    screen; the search only keeps games that play exactly that move there, so
    one correction re-aligns everything after it.

    `prior(boards) -> [ {uci: logprob} ] | None` (e.g. Maia2, backend/scoresheet_prior.py)
    re-ranks candidates at cells whose writing matches no legal move exactly."""
    pins = pins or {}
    cache = _InfoCache()
    start_ply = chess.Board(start_fen).ply()

    def allowed(board: chess.Board, mv: chess.Move) -> bool:
        want = pins.get(board.ply() - start_ply)
        return want is None or mv.uci() == want

    last_real = max((i for i, c in enumerate(cells) if not c.empty), default=-1)
    cells = cells[:last_real + 1]
    tail_after = [0.0] * (len(cells) + 1)          # cost of dropping every cell from j on
    for j in range(len(cells) - 1, -1, -1):
        tail_after[j] = tail_after[j + 1] + (0.0 if cells[j].empty else DEL_TAIL)

    beams = [_State(0.0, chess.Board(start_fen), [])]
    finished: list[_State] = []
    wide_until = -1
    for j, cell in enumerate(cells):
        if cell.empty:
            wide_until = j + WIDE_SPAN
        cand: dict[tuple, _State] = {}

        def push(st: _State) -> None:
            k = st.board._transposition_key()
            if k not in cand or st.cost < cand[k].cost:
                cand[k] = st

        # phase 1: score every state's legal moves against this cell
        scored = []
        for st in beams:
            infos, moves = cache.get(st.board)
            if not infos:          # mate / stalemate: everything left on the sheet is tail
                finished.append(_State(st.cost + tail_after[j], st.board, st.path + [("end", j, None, None, 0)]))
                continue
            want = "w" if st.board.turn == chess.WHITE else "b"
            par = 0.0 if want == cell.color else PARITY
            costs = sorted(((cell_cost(mi, cell) + par, mi, u) for mi, u in zip(infos, moves)
                            if allowed(st.board, u)), key=lambda t: t[0])
            if costs:
                scored.append((st, infos, moves, costs))
        # phase 2: where the writing fits no legal move exactly, let the human-move prior
        # re-rank the near candidates (one batched model call for all such states)
        state_lp: dict[int, dict[str, float]] = {}
        if prior is not None:
            # Ask the model only where it can change something: the prior adds at most
            # PRIOR_W*PRIOR_CAP, so a candidate leading by more than that keeps its place
            # (lossless skip). Blank cells always need it, and so do the top states where an
            # unwritten move may be inserted (its candidates are ranked by the prior).
            reach = PRIOR_W * PRIOR_CAP
            need = [k for k, (_, _, _, c) in enumerate(scored[:PRIOR_STATES])
                    if cell.empty
                    or (c[0][0] > .15 and len(c) > 1 and c[1][0] - c[0][0] < reach)
                    or (k < 2 and c[0][0] > 1.2)]
            lps = prior([scored[k][0].board for k in need]) if need else None
            if lps:
                for k, lp in zip(need, lps):
                    state_lp[k] = lp
                    st, infos, moves, costs = scored[k]
                    near = [t for t in costs if t[0] <= costs[0][0] + 1.6]
                    top = max(lp.get(u.uci(), -9.0) for _, _, u in near)
                    w = PRIOR_W_EMPTY if cell.empty else PRIOR_W
                    adj = [(c + w * min(PRIOR_CAP, top - lp.get(u.uci(), -9.0)), mi, u) for c, mi, u in near]
                    scored[k] = (st, infos, moves, sorted(adj, key=lambda t: t[0]))

        for idx, (st, infos, moves, costs) in enumerate(scored):
            best = costs[0][0]
            for c, mi, u in costs:
                if c > best + 2.5:
                    break
                b2 = st.board.copy(stack=False)
                b2.push(u)
                push(_State(st.cost + c, b2, st.path + [("match", j, mi.san, u.uci(), c)]))
            # drop this cell (scribble, crossed-out move, duplicate)
            push(_State(st.cost + (DEL_EMPTY if cell.empty else DEL), st.board, st.path + [("del", j, None, None, DEL)]))
            # a move nobody wrote down, then this cell -- only when the cell fits badly
            if idx < 2 and (best > 1.2 or (st.board.ply() - start_ply) in pins) and not cell.empty:
                # a forgotten move is almost always a natural one: with the prior, try the
                # few most likely moves instead of every legal move (35x35 -> 8x35 positions)
                lp = state_lp.get(idx)
                cands = list(zip(infos, moves))
                if lp:
                    cands = sorted(cands, key=lambda t: -lp.get(t[1].uci(), -9.0))[:INS_CANDIDATES]
                    top1 = lp.get(cands[0][1].uci(), -9.0)
                for mi1, u1 in cands:
                    if not allowed(st.board, u1):
                        continue
                    ins_cost = INS + (PRIOR_W * min(PRIOR_CAP, top1 - lp.get(u1.uci(), -9.0)) if lp else 0.0)
                    b1 = st.board.copy(stack=False)
                    b1.push(u1)
                    infos2, moves2 = cache.get(b1)
                    for mi2, u2 in zip(infos2, moves2):
                        if not allowed(b1, u2):
                            continue
                        c2 = cell_cost(mi2, cell)
                        if c2 < 1.0:
                            b2 = b1.copy(stack=False)
                            b2.push(u2)
                            push(_State(st.cost + ins_cost + c2, b2, st.path + [
                                ("ins", None, mi1.san, u1.uci(), ins_cost), ("match", j, mi2.san, u2.uci(), c2)]))
        beams = sorted(cand.values())[:WIDE_BEAM if j <= wide_until else beam]
        # the game may also stop after this cell (the rest is result text / scribbles)
        if j + 1 < len(cells) and beams:
            b0 = beams[0]
            finished.append(_State(b0.cost + tail_after[j + 1] + 1.0, b0.board,
                                   b0.path + [("end", j + 1, None, None, 0)]))

    final = min(beams + finished, key=lambda s: s.cost)
    return _report(final, cells, start_fen, cache, set(pins), prior)


def _report(final: _State, cells: list[Cell], start_fen: str, cache: _InfoCache,
            pinned: set[int] = frozenset(), prior=None) -> dict:
    board = chess.Board(start_fen)
    plies = []
    dropped = []
    for kind, j, san, uci, cost in final.path:
        if kind == "end":
            dropped += [k for k in range(j, len(cells)) if not cells[k].empty]
            break
        if kind == "del":
            if not cells[j].empty:
                dropped.append(j)
            continue
        infos, moves = cache.get(board)
        cell = cells[j] if j is not None else None
        if kind == "ins" or (cell is not None and cell.empty):
            # not on the sheet: offer the most natural moves (prior) as alternatives
            lp = (prior([board]) or [None])[0] if prior else None
            ranked = sorted(((-lp.get(m.uci(), -9.0), mi.san) for mi, m in zip(infos, moves)),
                            key=lambda t: t[0]) if lp else []
            status = "inferred"
        else:
            ranked = sorted(((cell_cost(mi, cell), mi.san) for mi in infos), key=lambda t: t[0])
            own = next(c for c, s in ranked if s == san)
            others = [c for c, s in ranked if s != san]
            gap = (others[0] - own) if others else 9.0
            if own < .15 and gap >= .45:
                status = "exact"
            elif own <= 1.6 and gap >= .55:
                status = "corrected"
            else:
                status = "uncertain"
        if len(plies) in pinned:
            status = "confirmed"
        alts = [s for _, s in ranked[:4] if s != san][:3] if ranked else []
        plies.append({
            "ply": len(plies), "san": board.san(chess.Move.from_uci(uci)), "uci": uci, "status": status,
            "cell": j, "row": cell.row if cell else None, "color": cell.color if cell else None,
            "read": cell.raw if cell else "", "cost": round(cost, 2), "alternatives": alts,
        })
        board.push_uci(uci)
    return {"plies": plies, "dropped_cells": dropped, "cost": round(final.cost, 2), "fen": board.fen()}


def cells_from_rows(rows: list[dict]) -> list[Cell]:
    """Rows of {number, white, black, white_alt?, black_alt?} -> cells in writing order.
    Multiple readings of one cell (alternatives, other passes) become weighted reads.
    Missing row numbers (a skipped row) become blank cells, so the decoder can infer
    the unwritten moves instead of sliding later moves into the wrong column."""
    cells: list[Cell] = []
    rows = sorted(rows, key=lambda r: r.get("number", 0))
    filled: list[dict] = []
    for r in rows:
        n = int(r.get("number", 0) or 0)
        if filled:
            prev = int(filled[-1].get("number", 0) or 0)
            if 1 < n - prev <= MAX_ROW_GAP:
                filled += [{"number": k, "white": "", "black": ""} for k in range(prev + 1, n)]
        filled.append(r)
    for r in filled:
        for color, k in (("w", "white"), ("b", "black")):
            primary = r.get(k) or ""
            alts = [a for a in (r.get(f"{k}_alt") or []) if a]
            votes = r.get(f"{k}_votes")
            n_pass = r.get("passes")
            reads: dict[str, float] = {}
            if votes and n_pass:
                # independent passes voted: a reading's weight is its vote share (passes that
                # saw the cell blank count against it), so split cells stay doubtful
                for v, c in votes:
                    nv = norm_reading(v)
                    reads[nv] = max(reads.get(nv, 0.0), min(1.0, c / n_pass))
                for a in alts:
                    na = norm_reading(a)
                    reads.setdefault(na, .2)
                weights = list(reads.items())
            else:
                if primary:
                    reads[norm_reading(primary)] = 1.0
                for a in alts:
                    na = norm_reading(a)
                    reads[na] = max(reads.get(na, 0.0), .45)
                tot = sum(reads.values()) or 1.0
                weights = [(t, w / tot) for t, w in reads.items()]
            cells.append(Cell(int(r.get("number", 0) or 0), color, weights, raw=primary))
    while cells and cells[-1].empty:
        cells.pop()
    return cells
