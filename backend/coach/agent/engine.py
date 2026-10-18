"""Stockfish access for the agent: shared singleton, bounded searches, LRU cache.

All searches go through `backend.main`'s engine + `_sf_lock`. Results are
cached per (fen, kind, params) so follow-up questions about the same board are
instant and do not re-spend the engine budget.
"""
from __future__ import annotations

import math
import threading
from collections import OrderedDict
from dataclasses import dataclass

import chess
import chess.engine

_CACHE: "OrderedDict[tuple, object]" = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_SIZE = 512
VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


@dataclass
class Eval:
    """Score from White's point of view."""
    cp: int | None
    mate: int | None

    @property
    def sort_key(self) -> float:
        if self.mate is not None:
            return (100000 - abs(self.mate)) * (1 if self.mate > 0 else -1)
        return float(self.cp or 0)

    def pov(self, color: chess.Color) -> float:
        return self.sort_key if color == chess.WHITE else -self.sort_key

    def short(self) -> str:
        if self.mate is not None:
            return f"M{abs(self.mate)} for {'White' if self.mate > 0 else 'Black'}"
        return f"{(self.cp or 0) / 100:+.2f}"

    def words(self) -> str:
        if self.mate is not None:
            side = "White" if self.mate > 0 else "Black"
            return f"{side} has a forced mate in {abs(self.mate)}"
        cp = self.cp or 0
        side, a = ("White" if cp > 0 else "Black"), abs(cp)
        if a < 35:
            return "roughly equal"
        if a < 90:
            return f"{side} is slightly better"
        if a < 200:
            return f"{side} is clearly better"
        if a < 450:
            return f"{side} has a winning advantage"
        return f"{side} is completely winning"

    def win_chance(self, color: chess.Color) -> int:
        """Expected score % for `color` (Lichess win% model)."""
        if self.mate is not None:
            return 100 if (self.mate > 0) == (color == chess.WHITE) else 0
        cp = max(-2000, min(2000, self.cp or 0)) * (1 if color == chess.WHITE else -1)
        return round(100 / (1 + math.exp(-0.00368208 * cp)))


def to_eval(score: chess.engine.PovScore | None) -> Eval:
    if score is None:
        return Eval(None, None)
    w = score.white()
    return Eval(w.score(), w.mate())


def san_line(board: chess.Board, pv: list[chess.Move], plies: int = 8) -> tuple[list[str], list[str], list[str]]:
    """Replay a PV legally → (san, uci, fens). Stops at the first illegal move."""
    b = board.copy()
    sans, ucis, fens = [], [], [b.fen()]
    for mv in pv[:plies]:
        if mv not in b.legal_moves:
            break
        sans.append(b.san(mv)); ucis.append(mv.uci())
        b.push(mv); fens.append(b.fen())
        if b.is_game_over():
            break
    return sans, ucis, fens


def numbered(board: chess.Board, sans: list[str]) -> str:
    """'12. Nd5 Bxd5 13. exd5' / '12... Bxd5 13. exd5' notation."""
    out, num, white = [], board.fullmove_number, board.turn == chess.WHITE
    for i, s in enumerate(sans):
        if white:
            out.append(f"{num}. {s}")
        else:
            out.append(f"{num}... {s}" if i == 0 else s)
            num += 1
        white = not white
    return " ".join(out)


def _cached(key: tuple, fn):
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    value = fn()
    with _CACHE_LOCK:
        _CACHE[key] = value
        while len(_CACHE) > _CACHE_SIZE:
            _CACHE.popitem(last=False)
    return value


def _analyse(board: chess.Board, limit: chess.engine.Limit, multipv: int = 1, root_moves=None) -> list[dict]:
    from backend.main import _sf_lock, _ensure_engine
    with _sf_lock:
        engine = _ensure_engine()
        infos = engine.analyse(board, limit, multipv=multipv, root_moves=root_moves)
    return infos if isinstance(infos, list) else [infos]


def top_lines(fen: str, multipv: int = 3, depth: int = 18, seconds: float = 2.5) -> list[dict]:
    """MultiPV search → [{move_san, move_uci, eval, line_san, line_uci, fens, depth}]."""
    def run():
        board = chess.Board(fen)
        if board.is_game_over():
            return []
        n = min(multipv, board.legal_moves.count())
        infos = _analyse(board, chess.engine.Limit(depth=depth, time=seconds), n)
        out = []
        for info in infos:
            pv = info.get("pv") or []
            if not pv:
                continue
            sans, ucis, fens = san_line(board, pv)
            out.append({"move_san": sans[0], "move_uci": ucis[0], "eval": to_eval(info.get("score")),
                        "line_san": sans, "line_uci": ucis, "fens": fens, "depth": int(info.get("depth", 0))})
        out.sort(key=lambda c: c["eval"].pov(board.turn), reverse=True)
        return out
    return _cached(("top", fen, multipv, depth), run)


def move_line(fen: str, uci: str, depth: int = 18, seconds: float = 1.5) -> dict:
    """Search one root move → same shape as a top_lines entry."""
    def run():
        board = chess.Board(fen)
        move = chess.Move.from_uci(uci)
        after = board.copy(); after.push(move)
        if after.is_game_over():
            outcome = after.outcome()
            ev = Eval(0, None) if outcome.winner is None else Eval(None, 1 if outcome.winner else -1)
            return {"move_san": board.san(move), "move_uci": uci, "eval": ev, "line_san": [board.san(move)],
                    "line_uci": [uci], "fens": [board.fen(), after.fen()], "depth": depth}
        # Search the resulting position directly (root_moves searches can miss
        # short mating replies); prepend the move to its PV.
        info = _analyse(after, chess.engine.Limit(depth=depth - 1, time=seconds))[0]
        sans, ucis, fens = san_line(board, [move] + (info.get("pv") or []))
        ev = to_eval(info.get("score"))
        if ev.mate is not None:   # mate distance counted from the root position
            ev = Eval(None, ev.mate + (1 if ev.mate > 0 else -1) * (1 if board.turn == (ev.mate > 0) else 0))
        return {"move_san": sans[0], "move_uci": uci, "eval": ev, "line_san": sans, "line_uci": ucis,
                "fens": fens, "depth": int(info.get("depth", 0)) + 1}
    return _cached(("move", fen, uci, depth), run)


def evaluate(fen: str, depth: int = 16, seconds: float = 1.2) -> dict:
    lines = top_lines(fen, 1, depth, seconds)
    board = chess.Board(fen)
    if not lines:
        outcome = board.outcome()
        ev = Eval(0, None) if outcome is None or outcome.winner is None else Eval(None, 1 if outcome.winner else -1)
        return {"eval": ev, "best": None, "terminal": outcome.termination.name.lower() if outcome else None}
    return {"eval": lines[0]["eval"], "best": lines[0], "terminal": None}


def null_move_threat(fen: str, depth: int = 14, seconds: float = 1.0) -> dict | None:
    """What would the opponent play if it were their turn? (classic threat probe)"""
    board = chess.Board(fen)
    if board.is_check() or board.is_game_over():
        return None
    flipped = board.copy(stack=False)
    flipped.push(chess.Move.null())
    flipped = chess.Board(flipped.fen())   # drop the null move from the stack
    if not flipped.is_valid() or flipped.is_game_over():
        return None
    lines = top_lines(flipped.fen(), 1, depth, seconds)
    return lines[0] if lines else None


def pick_move_for_strength(fen: str, strength: str) -> dict:
    """Human-like weakened move choice without touching shared engine options."""
    import random
    presets = {"beginner": (5, 6, 220), "intermediate": (9, 5, 90), "advanced": (13, 4, 35),
               "strong": (16, 3, 12), "engine": (20, 1, 1)}
    depth, mpv, temp = presets.get(strength, presets["intermediate"])
    board = chess.Board(fen)
    lines = top_lines(fen, mpv, depth, 1.5)
    if not lines:
        raise ValueError("The game is over.")
    best = lines[0]["eval"].pov(board.turn)
    weights = []
    for c in lines:
        loss = min(2000.0, best - c["eval"].pov(board.turn))
        weights.append(math.exp(-loss / temp))
    choice = random.choices(lines, weights=weights, k=1)[0]
    return {"move_uci": choice["move_uci"], "move_san": choice["move_san"],
            "eval": choice["eval"].short(), "best_san": lines[0]["move_san"]}
