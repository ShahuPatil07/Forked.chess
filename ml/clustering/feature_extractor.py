"""
Build fixed-length feature vectors from MistakeEvent objects.

Vector layout (111 dimensions total):
  [0:64]    piece_map       — piece value per square from mover's perspective
  [64:74]   material        — per-piece-type balance + aggregate metrics
  [74:86]   pawn_structure  — doubled/isolated/passed pawns, open files, advancement
  [86:94]   king_safety     — king position + pawn shield + king-zone attack count
  [94:111]  context         — eval metrics, game phase (one-hot), threat type (one-hot),
                              time pressure, move number, move properties, mobility
"""
from __future__ import annotations

import chess
import numpy as np

from ml.ingestion.mistake_extractor import MistakeEvent
from ml.ingestion.threat_classifier import PIECE_VALUES, THREAT_TYPES

_MAX_MATERIAL    = 39
_MAX_EVAL_CP     = 500
_MAX_MOVE_NUMBER = 60
_MAX_CLOCK_MS    = 10 * 60 * 1_000   # 10 minutes = "plenty of time"

FEATURE_DIM = 111


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_features(mistakes: list[MistakeEvent]) -> np.ndarray:
    """Return (N, FEATURE_DIM) float32 array — one row per mistake event."""
    return np.array([_feature_vector(m) for m in mistakes], dtype=np.float32)


def feature_names() -> list[str]:
    names = [f"sq_{chess.square_name(sq)}" for sq in chess.SQUARES]  # 64
    names += [
        "q_balance", "r_balance", "b_balance", "n_balance", "p_balance",
        "own_material", "opp_material", "material_balance",
        "total_material_frac", "material_ratio",
    ]  # 10
    names += [
        "own_doubled", "own_isolated", "own_passed",
        "opp_doubled", "opp_isolated", "opp_passed",
        "open_files", "own_half_open", "opp_half_open",
        "own_pawn_center", "opp_pawn_center", "own_pawn_advance",
    ]  # 12
    names += [
        "own_king_rank", "own_king_file", "own_king_shield", "own_king_zone_attacks",
        "opp_king_rank", "opp_king_file", "opp_king_shield", "opp_king_zone_attacks",
    ]  # 8
    names += ["eval_drop_norm", "eval_before_norm"]                   # 2
    names += ["phase_opening", "phase_middlegame", "phase_endgame"]   # 3
    names += [f"threat_{t}" for t in THREAT_TYPES]                   # 7
    names += [
        "time_pressure", "move_number_norm",
        "best_move_capture", "best_move_check", "mobility_ratio",
    ]  # 5
    assert len(names) == FEATURE_DIM, f"{len(names)} != {FEATURE_DIM}"
    return names


# ---------------------------------------------------------------------------
# Feature groups
# ---------------------------------------------------------------------------

def _feature_vector(event: MistakeEvent) -> list[float]:
    board = chess.Board(event.fen)
    mover = board.turn
    opp   = not mover

    feats: list[float] = []
    feats.extend(_piece_map(board, mover))           # 64
    feats.extend(_material(board, mover, opp))       # 10
    feats.extend(_pawn_structure(board, mover, opp)) # 12
    feats.extend(_king_safety(board, mover, opp))    # 8
    feats.extend(_context(event, board))             # 17
    assert len(feats) == FEATURE_DIM
    return feats


# ── Piece map (64-dim) ──────────────────────────────────────────────────────

def _piece_map(board: chess.Board, mover: chess.Color) -> list[float]:
    result = [0.0] * 64
    for sq in chess.SQUARES:
        piece = board.piece_at(sq)
        if piece is None:
            continue
        raw = PIECE_VALUES.get(piece.piece_type, 0)
        if piece.piece_type == chess.KING:
            raw = 9
        val = raw / 9.0
        result[sq] = val if piece.color == mover else -val
    return result


# ── Material (10-dim) ────────────────────────────────────────────────────────

def _material(board: chess.Board, mover: chess.Color, opp: chess.Color) -> list[float]:
    feats = []
    for pt, max_n in [
        (chess.QUEEN, 2), (chess.ROOK, 4),
        (chess.BISHOP, 4), (chess.KNIGHT, 4), (chess.PAWN, 8),
    ]:
        feats.append((len(board.pieces(pt, mover)) - len(board.pieces(pt, opp))) / max_n)

    def mat(c: chess.Color) -> float:
        return sum(
            len(board.pieces(pt, c)) * v
            for pt, v in PIECE_VALUES.items() if pt != chess.KING
        )

    own_m, opp_m = mat(mover), mat(opp)
    feats += [
        own_m / _MAX_MATERIAL,
        opp_m / _MAX_MATERIAL,
        (own_m - opp_m) / _MAX_MATERIAL,
        (own_m + opp_m) / (2 * _MAX_MATERIAL),
        own_m / max(opp_m, 1) - 1.0,
    ]
    return feats  # 10


# ── Pawn structure (12-dim) ──────────────────────────────────────────────────

def _pawn_structure(board: chess.Board, mover: chess.Color, opp: chess.Color) -> list[float]:
    def doubled(c: chess.Color) -> int:
        fc = [0] * 8
        for sq in board.pieces(chess.PAWN, c):
            fc[chess.square_file(sq)] += 1
        return sum(max(0, x - 1) for x in fc)

    def isolated(c: chess.Color) -> int:
        files = {chess.square_file(sq) for sq in board.pieces(chess.PAWN, c)}
        return sum(1 for f in files if (f-1) not in files and (f+1) not in files)

    def passed(c: chess.Color) -> int:
        enemy = not c
        ep, count = board.pieces(chess.PAWN, enemy), 0
        for sq in board.pieces(chess.PAWN, c):
            f, r = chess.square_file(sq), chess.square_rank(sq)
            adj  = [ff for ff in (f-1, f, f+1) if 0 <= ff <= 7]
            ok   = True
            for esq in ep:
                if chess.square_file(esq) in adj:
                    er = chess.square_rank(esq)
                    if (c == chess.WHITE and er > r) or (c == chess.BLACK and er < r):
                        ok = False; break
            if ok:
                count += 1
        return count

    own_files = {chess.square_file(sq) for sq in board.pieces(chess.PAWN, mover)}
    opp_files = {chess.square_file(sq) for sq in board.pieces(chess.PAWN, opp)}
    open_files = sum(1 for f in range(8) if f not in own_files and f not in opp_files)
    own_half   = sum(1 for f in range(8) if f not in own_files and f in opp_files)
    opp_half   = sum(1 for f in range(8) if f not in opp_files and f in own_files)

    center = chess.SquareSet({chess.E4, chess.D4, chess.E5, chess.D5})

    own_pawns = board.pieces(chess.PAWN, mover)
    own_advance = 0.0
    if own_pawns:
        ranks = [chess.square_rank(sq) for sq in own_pawns]
        avg   = sum(ranks) / len(ranks)
        own_advance = (avg / 7.0) if mover == chess.WHITE else (1.0 - avg / 7.0)

    return [
        doubled(mover) / 4.0,  isolated(mover) / 4.0,  passed(mover) / 4.0,
        doubled(opp)   / 4.0,  isolated(opp)   / 4.0,  passed(opp)   / 4.0,
        open_files / 8.0,  own_half / 8.0,  opp_half / 8.0,
        len(board.pieces(chess.PAWN, mover) & center) / 4.0,
        len(board.pieces(chess.PAWN, opp)   & center) / 4.0,
        own_advance,
    ]  # 12


# ── King safety (8-dim) ──────────────────────────────────────────────────────

def _one_king(board: chess.Board, king_color: chess.Color, atk_color: chess.Color):
    sq = board.king(king_color)
    if sq is None:
        return 0.5, 0.5, 0.0, 0.0
    rank, file = chess.square_rank(sq), chess.square_file(sq)
    direction  = 1 if king_color == chess.WHITE else -1
    shield = sum(
        1 for df in (-1, 0, 1)
        if 0 <= file+df <= 7 and 0 <= rank+direction <= 7
        and (p := board.piece_at(chess.square(file+df, rank+direction)))
        and p.piece_type == chess.PAWN and p.color == king_color
    )
    zone_attacks = sum(
        1 for zsq in chess.SquareSet(chess.BB_KING_ATTACKS[sq])
        if board.is_attacked_by(atk_color, zsq)
    )
    return rank / 7.0, file / 7.0, shield / 3.0, min(1.0, zone_attacks / 8.0)


def _king_safety(board: chess.Board, mover: chess.Color, opp: chess.Color) -> list[float]:
    return list(_one_king(board, mover, opp)) + list(_one_king(board, opp, mover))  # 8


# ── Context (17-dim) ─────────────────────────────────────────────────────────

def _context(event: MistakeEvent, board: chess.Board) -> list[float]:
    feats: list[float] = []

    # Eval (2)
    feats.append(min(_MAX_EVAL_CP, event.eval_drop_cp)  / _MAX_EVAL_CP)
    feats.append(max(-_MAX_EVAL_CP, min(_MAX_EVAL_CP, event.eval_before_cp)) / _MAX_EVAL_CP)

    # Game phase one-hot (3)
    pv = [0.0, 0.0, 0.0]
    pv[{"opening": 0, "middlegame": 1, "endgame": 2}.get(event.game_phase, 1)] = 1.0
    feats.extend(pv)

    # Threat type one-hot (7)
    tv = [0.0] * len(THREAT_TYPES)
    if event.threat_type in THREAT_TYPES:
        tv[THREAT_TYPES.index(event.threat_type)] = 1.0
    feats.extend(tv)

    # Time pressure (1): 0 = plenty of time / no data, 1 = near flag
    feats.append(
        1.0 - min(1.0, event.time_remaining_ms / _MAX_CLOCK_MS)
        if event.time_remaining_ms is not None else 0.0
    )

    # Move number (1)
    feats.append(min(1.0, event.move_number / _MAX_MOVE_NUMBER))

    # Best-move properties (2)
    try:
        bm = chess.Move.from_uci(event.best_move_uci)
        feats.append(1.0 if board.is_capture(bm) else 0.0)
        after = board.copy(); after.push(bm)
        feats.append(1.0 if after.is_check() else 0.0)
    except Exception:
        feats.extend([0.0, 0.0])

    # Mobility ratio (1): mover legal moves / total legal moves
    own_moves = len(list(board.legal_moves))
    try:
        tmp = board.copy(); tmp.push(chess.Move.null())
        opp_moves = len(list(tmp.legal_moves))
    except Exception:
        opp_moves = own_moves
    total = own_moves + opp_moves
    feats.append(own_moves / total if total > 0 else 0.5)

    return feats  # 2+3+7+1+1+2+1 = 17
