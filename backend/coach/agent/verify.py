"""Grounding checks for a drafted answer (before it is shown).

Two cheap, high-precision checks catch the classic LLM chess hallucinations:
  1. a move that is not legal in, or reachable from, any position the tools saw;
  2. "the knight on f3"-style piece placements that exist in none of those positions.
Issues are returned as text for one repair round; they never silently replace
the answer with a template.
"""
from __future__ import annotations

import re

import chess

SAN_RE = re.compile(r"(?<![\w/\-])(?:\d+\.(?:\.\.)?\s*)?((?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|[a-h][1-8])(?:=[QRBN])?[+#!?]*)(?![\w\-])")
PIECE_ON_RE = re.compile(r"\b(white|black)?\s*(king|queen|rook|bishop|knight|pawn)\s+on\s+([a-h][1-8])\b", re.I)
TYPES = {"king": chess.KING, "queen": chess.QUEEN, "rook": chess.ROOK,
         "bishop": chess.BISHOP, "knight": chess.KNIGHT, "pawn": chess.PAWN}


def _legal_sans(fen: str) -> set[str]:
    out = set()
    for turn in (chess.WHITE, chess.BLACK):
        b = chess.Board(fen)
        b.turn = turn
        b.ep_square = None
        if turn != chess.Board(fen).turn and not b.is_valid():
            continue
        for m in b.legal_moves:
            out.add(b.san(m).rstrip("+#"))
    return out


def check_answer(text: str, fens: set[str], sans: set[str]) -> list[str]:
    if not fens:
        return []
    boards = [chess.Board(f) for f in fens]
    allowed = set(sans)
    for f in list(fens)[:60]:
        try:
            allowed |= _legal_sans(f)
        except Exception:
            continue
    issues = []
    bad_moves = []
    # Strip move-free contexts like square lists "the d5 square" from move checks:
    # bare squares (e.g. "d5") are ambiguous in prose, so only pawn moves that
    # look like moves inside a numbered line are checked; piece moves always are.
    for m in SAN_RE.finditer(text):
        token = m.group(1).rstrip("!?").rstrip("+#")
        whole = m.group(0)
        is_piece_or_capture = token.startswith(("O-O", "K", "Q", "R", "B", "N")) or "x" in token
        in_line = bool(re.match(r"\d+\.", whole.strip())) or bool(re.search(r"\.\.\.\s*$", text[max(0, m.start() - 4):m.start()]))
        if not (is_piece_or_capture or in_line):
            continue
        if token not in allowed and token.replace("=", "") not in allowed:
            bad_moves.append(token)
    if bad_moves:
        uniq = list(dict.fromkeys(bad_moves))[:4]
        issues.append("These moves are not legal in, or reached by, any position you analysed: "
                      + ", ".join(uniq) + ". Check them with a tool (explore_line / evaluate_moves) or remove them.")
    wrong = []
    for m in PIECE_ON_RE.finditer(text):
        before = text[max(0, m.start(2) - 30):m.start(2)].lower()
        if re.search(r"\b(a|an|get|put|bring|place|land|plant|reach|establish|aim|want|would|could|if)\s+(\w+\s+)?$", before):
            continue   # hypothetical/plan ("aim to get a knight on d5"), not a claim about the board
        color, ptype, sq = m.group(1), TYPES[m.group(2).lower()], chess.parse_square(m.group(3).lower())
        ok = False
        for b in boards:
            p = b.piece_at(sq)
            if p and p.piece_type == ptype and (color is None or p.color == (color.lower() == "white")):
                ok = True
                break
        if not ok:
            wrong.append(m.group(0).strip())
    if wrong:
        issues.append("These piece placements don't match the board or any analysed line: "
                      + "; ".join(dict.fromkeys(wrong)) + ". Re-read CURRENT BOARD and fix them.")
    bad_files = []
    for m in FILE_RE.finditer(text):
        f = chess.FILE_NAMES.index(m.group(2).lower())
        if all(_file_kind(b, f) == "closed" for b in boards):
            bad_files.append(m.group(0))
    if bad_files:
        issues.append("File claims that don't match any analysed position (a file with pawns of both colours is "
                      "closed): " + "; ".join(dict.fromkeys(bad_files)) + ".")
    if re.search(r"\b(?:open|half-open|semi-open) files?\b", text, re.I) and not FILE_RE.search(text):
        if all(_file_kind(b, f) == "closed" for b in boards for f in range(8)):
            issues.append("You mention an open/half-open file, but every file has pawns of both colours in the "
                          "analysed positions. Remove that claim.")
    bad_pins = [m.group(0) for m in PIN_RE.finditer(text)
                if not any(_is_pinned(b, chess.parse_square(m.group(2).lower()), TYPES[m.group(1).lower()]) for b in boards)]
    if bad_pins:
        issues.append("Pin claims not true in any analysed position: " + "; ".join(dict.fromkeys(bad_pins)) + ".")
    return issues


FILE_RE = re.compile(r"(?<![\w-])(open|half-open|semi-open)\s+([a-h])-file", re.I)
PIN_RE = re.compile(r"\b(king|queen|rook|bishop|knight|pawn) on ([a-h][1-8]) (?:is|was|gets|will be|stays|remains) pinned", re.I)
VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}


def _file_kind(board: chess.Board, f: int) -> str:
    w = any(chess.square_file(s) == f for s in board.pieces(chess.PAWN, chess.WHITE))
    b = any(chess.square_file(s) == f for s in board.pieces(chess.PAWN, chess.BLACK))
    return "open" if not w and not b else "closed" if w and b else "half-open"


def _is_pinned(board: chess.Board, sq: int, ptype: int) -> bool:
    """Absolute or relative pin: an enemy slider attacks `sq` with a more valuable
    friendly piece (or the king) directly behind it on the same line."""
    piece = board.piece_at(sq)
    if not piece or piece.piece_type != ptype:
        return False
    if board.is_pinned(piece.color, sq):
        return True
    for s in board.attackers(not piece.color, sq):
        if board.piece_type_at(s) not in (chess.BISHOP, chess.ROOK, chess.QUEEN):
            continue
        ray = chess.SquareSet(chess.ray(s, sq))
        beyond = [t for t in ray if t not in chess.SquareSet(chess.between(s, sq)) and t not in (s, sq)
                  and chess.square_distance(s, t) > chess.square_distance(s, sq)]
        beyond.sort(key=lambda t: chess.square_distance(sq, t))
        for t in beyond:
            behind = board.piece_at(t)
            if behind:
                if behind.color == piece.color and VALUE[behind.piece_type] > VALUE[ptype]:
                    return True
                break
    return False
