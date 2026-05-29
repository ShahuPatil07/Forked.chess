"""
Maia2 move generator for the bot game.

Uses the maia2 Python package to pick the most human-like move at a
target ELO.  The same maia2 model already installed for maia_annotator.py
is reused here via a module-level singleton (loaded once, shared across games).

ELO range clamped to 1100–1900 (Maia2 training distribution).

Root cause of the Nf3→Ng1 oscillation bug
  maia2 was trained on real game data.  In real games, nobody plays a
  piece (knight, bishop) as their VERY FIRST MOVE without then pushing a
  central pawn immediately after.  So positions like:
      1.Nf3 c5 — white to move, all white pawns still on rank 2
  are essentially never seen during training.  The model falls back to a
  degenerate "return the piece to its starting square" pattern (~97% prob).

Fix
  1. FIRST-MOVE OVERRIDE: if the side to move has not yet moved any
     pieces (all non-pawn pieces still on the back rank), skip maia2
     entirely and pick from a curated list of strong central pawn moves.
     This guarantees every game starts with a real move that puts maia2
     into in-distribution territory for all subsequent calls.

  2. OOD RETREAT FILTER (secondary safety net): if maia2 returns >70%
     probability for a move that returns a piece to its canonical starting
     square, discard that choice and pick the next best.  This catches any
     remaining edge cases.
"""
from __future__ import annotations

import logging
import random
import threading
import time

import chess

log = logging.getLogger(__name__)

_MAIA2_ELO_MIN = 1100
_MAIA2_ELO_MAX = 1900

_lock      = threading.Lock()
_model     = None
_prepared  = None
_available = None   # None = not yet checked


def _ensure_loaded() -> bool:
    global _model, _prepared, _available
    if _available is not None:
        return _available
    with _lock:
        if _available is not None:
            return _available
        try:
            import maia2.model as m2_model
            import maia2.inference as m2_inf
            log.info("[BotEngine] Loading Maia2 model (rapid, cpu) ...")
            _model     = m2_model.from_pretrained(type="rapid", device="cpu")
            _prepared  = m2_inf.prepare()
            _available = True
            log.info("[BotEngine] Maia2 ready.")
        except Exception as exc:
            log.warning("[BotEngine] Maia2 unavailable: %s — using random fallback.", exc)
            _available = False
    return _available


# ── First-move override ───────────────────────────────────────────────────────

# Central pawn openings the bot should pick for its very first move.
# Weighted by approximate frequency at 1900 ELO in real games.
_FIRST_MOVE_WHITE = [("e2e4", 0.40), ("d2d4", 0.35), ("c2c4", 0.25)]
_FIRST_MOVE_BLACK = [("e7e5", 0.30), ("d7d5", 0.30), ("c7c5", 0.25), ("c7c6", 0.15)]


def _is_first_move(board: chess.Board) -> bool:
    """
    True if this is move 1 for either side (fullmove_number == 1).
    White's first move: fullmove 1, white to move.
    Black's first move: fullmove 1, black to move.
    After both sides have made their first moves, fullmove becomes 2 and
    this never fires again.
    """
    return board.fullmove_number == 1


def _pick_first_move(board: chess.Board) -> str:
    """Return a weighted-random central pawn first move for the side to move."""
    candidates = _FIRST_MOVE_WHITE if board.turn == chess.WHITE else _FIRST_MOVE_BLACK
    legal_ucis = {m.uci() for m in board.legal_moves}
    valid      = [(uci, w) for uci, w in candidates if uci in legal_ucis]
    if not valid:
        # Fallback: any legal pawn push
        pawn_moves = [m.uci() for m in board.legal_moves
                      if board.piece_at(m.from_square) and
                      board.piece_at(m.from_square).piece_type == chess.PAWN]
        return random.choice(pawn_moves) if pawn_moves else list(board.legal_moves)[0].uci()
    ucis, weights = zip(*valid)
    return random.choices(list(ucis), weights=list(weights), k=1)[0]


# ── Out-of-distribution guard (secondary) ─────────────────────────────────────

# Canonical starting squares for non-pawn pieces (white).
# Their black equivalents are just the mirror (rank 1 ↔ rank 8).
_WHITE_START: dict[int, set[int]] = {
    chess.KNIGHT: {chess.B1, chess.G1},
    chess.BISHOP: {chess.C1, chess.F1},
    chess.ROOK:   {chess.A1, chess.H1},
    chess.QUEEN:  {chess.D1},
}
_BLACK_START: dict[int, set[int]] = {
    chess.KNIGHT: {chess.B8, chess.G8},
    chess.BISHOP: {chess.C8, chess.F8},
    chess.ROOK:   {chess.A8, chess.H8},
    chess.QUEEN:  {chess.D8},
}


def _is_return_to_start(board: chess.Board, uci: str) -> bool:
    """True if the move returns a piece to its canonical starting square."""
    try:
        move  = chess.Move.from_uci(uci)
        piece = board.piece_at(move.from_square)
        if piece is None or piece.piece_type == chess.PAWN or piece.piece_type == chess.KING:
            return False
        starts = (_WHITE_START if piece.color == chess.WHITE else _BLACK_START)
        return move.to_square in starts.get(piece.piece_type, set())
    except Exception:
        return False


def _filter_ood_retreats(
    legal_probs: dict[str, float],
    board: chess.Board,
) -> dict[str, float]:
    """
    Remove moves that return a piece to its starting square when maia2 assigns
    them extreme confidence (>70%).  This catches the specific OOD failure mode
    where maia2 sees "piece not on starting square, all pawns unmoved" and
    assigns ~90–97% probability to the retreat.

    A threshold of 0.7 is conservative enough to never fire on legitimate
    retreats in developed positions (those typically score <20%).
    """
    if not legal_probs:
        return legal_probs

    top_uci  = max(legal_probs, key=legal_probs.__getitem__)
    top_prob = legal_probs[top_uci]

    if top_prob > 0.70 and _is_return_to_start(board, top_uci):
        log.warning(
            "[BotEngine] OOD retreat detected: %s (%.1f%%) — filtering and repicking.",
            top_uci, top_prob * 100,
        )
        filtered = {
            uci: p for uci, p in legal_probs.items()
            if not _is_return_to_start(board, uci)
        }
        return filtered if filtered else legal_probs

    return legal_probs


# ── Public API ────────────────────────────────────────────────────────────────

def get_move(
    fen: str,
    target_elo: int,
    user_elo: int = 1500,
    position_history: list[str] | None = None,   # kept for API compat, not used
) -> str:
    """
    Return the best UCI move for *target_elo* in position *fen*.
    Runs synchronously (CPU-bound) — call via run_in_executor from async code.
    """
    elo_self = max(_MAIA2_ELO_MIN, min(_MAIA2_ELO_MAX, target_elo))
    elo_oppo = max(_MAIA2_ELO_MIN, min(_MAIA2_ELO_MAX, user_elo))

    t0    = time.time()
    board = chess.Board(fen)

    # First-move override: only on move 1 — avoids maia2 OOD "piece before pawns" failure
    if _is_first_move(board):
        chosen = _pick_first_move(board)
        log.info("[BotEngine] first-move override: %s", chosen)
        return chosen

    if _ensure_loaded():
        try:
            import maia2.inference as m2_inf
            with _lock:
                move_probs, _ = m2_inf.inference_each(
                    _model, _prepared, fen, elo_self, elo_oppo
                )

            legal_ucis  = {m.uci() for m in board.legal_moves}
            legal_probs = {uci: p for uci, p in move_probs.items() if uci in legal_ucis}

            if not legal_probs:
                chosen = random.choice(list(board.legal_moves)).uci()
            else:
                legal_probs = _filter_ood_retreats(legal_probs, board)
                chosen = max(legal_probs, key=legal_probs.__getitem__)

            log.info(
                "[BotEngine] move=%s elo=%d time=%.2fs fen=%s…",
                chosen, elo_self, time.time() - t0, fen[:30],
            )
            return chosen

        except Exception as exc:
            log.warning("[BotEngine] inference failed (%s) — falling back", exc)

    # ── Fallback: prefer captures and checks ─────────────────────────────────
    legal = list(board.legal_moves)
    if not legal:
        raise RuntimeError("No legal moves in position")

    def _priority(m: chess.Move) -> int:
        score = 0
        if board.gives_check(m):
            score += 2
        if board.is_capture(m):
            score += 1
        return score

    legal.sort(key=_priority, reverse=True)
    chosen = legal[0].uci()
    log.info("[BotEngine] fallback move=%s", chosen)
    return chosen
