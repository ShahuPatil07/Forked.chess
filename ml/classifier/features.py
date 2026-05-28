"""
Feature extraction for the ML threat classifier.

Raw feature vector layout (805 dims):
  [0:768]    bitboard  — 8×8×12 binary piece-placement tensor (flattened)
  [768:788]  move      — 20 features describing the solution move
  [788:800]  context   — 12 positional context features
  [800:805]  post_move — 5 consequence features after the move

After PCA on the bitboard block (768 → PCA_COMPONENTS = 64):
  final dim = 64 + 20 + 12 + 5 = 101

Usage:
  raw = extract_raw(fen, uci)        # 805-dim, for training data building
  vec = extract_features(fen, uci, pca=pca_obj)  # 101-dim, for inference
"""
from __future__ import annotations

import chess
import numpy as np

# ---------------------------------------------------------------------------
# Dimension constants
# ---------------------------------------------------------------------------

BITBOARD_DIM    = 768   # 12 piece-type channels × 64 squares
MOVE_DIM        = 20    # 4 coords + 3 flags + 6 piece one-hot + 7 capture one-hot
CONTEXT_DIM     = 12    # position-level context features
POST_MOVE_DIM   = 5     # consequences after applying the solution move

RAW_FEATURE_DIM   = BITBOARD_DIM + MOVE_DIM + CONTEXT_DIM + POST_MOVE_DIM  # 805
PCA_COMPONENTS    = 64
FINAL_FEATURE_DIM = PCA_COMPONENTS + MOVE_DIM + CONTEXT_DIM + POST_MOVE_DIM  # 101


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_raw(fen: str, move_uci: str) -> np.ndarray:
    """Return the 805-dim raw feature vector (no PCA applied)."""
    board = chess.Board(fen)
    move  = chess.Move.from_uci(move_uci)

    arr = np.empty(RAW_FEATURE_DIM, dtype=np.float32)
    arr[:BITBOARD_DIM]                        = _encode_bitboard(board)
    arr[BITBOARD_DIM:BITBOARD_DIM+MOVE_DIM]   = _move_features(board, move)
    arr[BITBOARD_DIM+MOVE_DIM:
        BITBOARD_DIM+MOVE_DIM+CONTEXT_DIM]    = _context_features(board)
    arr[BITBOARD_DIM+MOVE_DIM+CONTEXT_DIM:]   = _post_move_features(board, move)
    return arr


def extract_features(fen: str, move_uci: str, pca=None) -> np.ndarray:
    """
    Return the final feature vector for inference.
    - With pca: 101-dim (PCA-compressed bitboard + other features).
    - Without pca: 805-dim raw vector (useful for offline analysis).
    """
    raw = extract_raw(fen, move_uci)
    if pca is None:
        return raw
    bb_compressed = pca.transform(raw[:BITBOARD_DIM].reshape(1, -1))[0]
    return np.concatenate([bb_compressed, raw[BITBOARD_DIM:]], dtype=np.float32)


# ---------------------------------------------------------------------------
# Feature groups
# ---------------------------------------------------------------------------

# Piece-type channel order in the bitboard (12 channels × 64 squares)
_PIECE_CHANNELS: list[tuple[int, chess.Color]] = [
    (chess.PAWN,   chess.WHITE), (chess.KNIGHT, chess.WHITE),
    (chess.BISHOP, chess.WHITE), (chess.ROOK,   chess.WHITE),
    (chess.QUEEN,  chess.WHITE), (chess.KING,   chess.WHITE),
    (chess.PAWN,   chess.BLACK), (chess.KNIGHT, chess.BLACK),
    (chess.BISHOP, chess.BLACK), (chess.ROOK,   chess.BLACK),
    (chess.QUEEN,  chess.BLACK), (chess.KING,   chess.BLACK),
]

_PIECE_VALUES = {
    chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3,
    chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0,
}


def _encode_bitboard(board: chess.Board) -> np.ndarray:
    arr = np.zeros(BITBOARD_DIM, dtype=np.float32)
    for ch, (pt, color) in enumerate(_PIECE_CHANNELS):
        for sq in board.pieces(pt, color):
            arr[ch * 64 + sq] = 1.0
    return arr


def _one_hot(index: int, size: int) -> list[float]:
    v = [0.0] * size
    if 0 <= index < size:
        v[index] = 1.0
    return v


def _move_features(board: chess.Board, move: chess.Move) -> list[float]:
    """20-dim move descriptor."""
    piece = board.piece_at(move.from_square)
    piece_type_idx = (piece.piece_type - 1) if piece is not None else 0  # 0-5

    is_cap = board.is_capture(move)
    if is_cap:
        if board.is_en_passant(move):
            cap_idx = chess.PAWN - 1  # 0
        else:
            cap_piece = board.piece_at(move.to_square)
            cap_idx = (cap_piece.piece_type - 1) if cap_piece else 6
    else:
        cap_idx = 6  # "no capture" slot

    feats = [
        chess.square_file(move.from_square) / 7.0,
        chess.square_rank(move.from_square) / 7.0,
        chess.square_file(move.to_square)   / 7.0,
        chess.square_rank(move.to_square)   / 7.0,
        float(is_cap),
        float(board.gives_check(move)),
        float(move.promotion is not None),
        *_one_hot(piece_type_idx, 6),   # 6 dims
        *_one_hot(cap_idx, 7),          # 7 dims (6 piece types + "no capture")
    ]
    return feats  # 4+3+6+7 = 20


def _material_sum(board: chess.Board, color: chess.Color) -> float:
    return sum(
        len(board.pieces(pt, color)) * v
        for pt, v in _PIECE_VALUES.items()
        if pt != chess.KING
    )


def _count_pawn_shield(board: chess.Board, color: chess.Color) -> int:
    king_sq = board.king(color)
    if king_sq is None:
        return 0
    direction = 1 if color == chess.WHITE else -1
    king_rank = chess.square_rank(king_sq)
    king_file = chess.square_file(king_sq)
    shield = 0
    for df in (-1, 0, 1):
        nf = king_file + df
        for dr in (1, 2):
            nr = king_rank + direction * dr
            if 0 <= nf <= 7 and 0 <= nr <= 7:
                sq = chess.square(nf, nr)
                p  = board.piece_at(sq)
                if p and p.piece_type == chess.PAWN and p.color == color:
                    shield += 1
    return shield


def _estimate_game_phase(board: chess.Board) -> float:
    """0.0 = full material (opening), 1.0 = no material (pure endgame)."""
    material = sum(
        len(board.pieces(pt, chess.WHITE) | board.pieces(pt, chess.BLACK)) * v
        for pt, v in _PIECE_VALUES.items()
        if pt not in (chess.KING, chess.PAWN)
    )
    max_material = 2*9 + 4*5 + 4*3 + 4*3  # 2Q+4R+4B+4N = 62
    return 1.0 - min(1.0, material / max_material)


def _count_doubled_pawns(board: chess.Board, color: chess.Color) -> int:
    file_counts = [0] * 8
    for sq in board.pieces(chess.PAWN, color):
        file_counts[chess.square_file(sq)] += 1
    return sum(max(0, c - 1) for c in file_counts)


def _count_isolated_pawns(board: chess.Board, color: chess.Color) -> int:
    files = {chess.square_file(sq) for sq in board.pieces(chess.PAWN, color)}
    return sum(1 for f in files if (f - 1) not in files and (f + 1) not in files)


def _has_back_rank_weakness(board: chess.Board, color: chess.Color) -> bool:
    """King on back rank with no pawn shield in front of it."""
    king_sq = board.king(color)
    if king_sq is None:
        return False
    back_rank = 0 if color == chess.WHITE else 7
    if chess.square_rank(king_sq) != back_rank:
        return False
    return _count_pawn_shield(board, color) == 0


def _mobility_proxy(board: chess.Board) -> float:
    """Cheap mobility estimate: sum of pseudo-legal destinations for the side to move.
    Avoids full legal-move generation (which checks pins and is ~10x slower)."""
    total = 0
    for sq in board.pieces(chess.PAWN,   board.turn): total += bin(int(board.attacks_mask(sq))).count('1')
    for sq in board.pieces(chess.KNIGHT, board.turn): total += bin(int(board.attacks_mask(sq))).count('1')
    for sq in board.pieces(chess.BISHOP, board.turn): total += bin(int(board.attacks_mask(sq))).count('1')
    for sq in board.pieces(chess.ROOK,   board.turn): total += bin(int(board.attacks_mask(sq))).count('1')
    for sq in board.pieces(chess.QUEEN,  board.turn): total += bin(int(board.attacks_mask(sq))).count('1')
    for sq in board.pieces(chess.KING,   board.turn): total += bin(int(board.attacks_mask(sq))).count('1')
    return total / 40.0


def _context_features(board: chess.Board) -> list[float]:
    """12-dim positional context."""
    own_mat = _material_sum(board, board.turn)
    opp_mat = _material_sum(board, not board.turn)
    max_m   = 39.0  # rough single-side max (Q+2R+2B+2N+8P)

    return [
        (own_mat - opp_mat) / max_m,                       # material balance
        _estimate_game_phase(board),                       # phase [0,1]
        _count_pawn_shield(board, chess.WHITE) / 6.0,
        _count_pawn_shield(board, chess.BLACK) / 6.0,
        _mobility_proxy(board),                            # pseudo-legal mobility
        float(board.is_check()),
        _count_doubled_pawns(board, chess.WHITE) / 4.0,
        _count_doubled_pawns(board, chess.BLACK) / 4.0,
        _count_isolated_pawns(board, chess.WHITE) / 4.0,
        _count_isolated_pawns(board, chess.BLACK) / 4.0,
        float(_has_back_rank_weakness(board, chess.WHITE)),
        float(_has_back_rank_weakness(board, chess.BLACK)),
    ]  # 12


def _count_attacked_pieces(board: chess.Board, color: chess.Color) -> int:
    """Count own pieces attacked by opponent. Iterates occupied squares only."""
    attacker = not color
    count = 0
    for pt in chess.PIECE_TYPES:
        for sq in board.pieces(pt, color):
            if board.is_attacked_by(attacker, sq):
                count += 1
    return count


def _count_hanging_pieces(board: chess.Board, color: chess.Color) -> int:
    """Count own pieces attacked but not defended. Iterates occupied squares only."""
    attacker = not color
    count = 0
    for pt in chess.PIECE_TYPES:
        for sq in board.pieces(pt, color):
            if board.is_attacked_by(attacker, sq) and not board.is_attacked_by(color, sq):
                count += 1
    return count


def _post_move_features(board: chess.Board, move: chess.Move) -> list[float]:
    """5-dim consequences after the solution move is played."""
    after = board.copy()
    after.push(move)

    own_before = _material_sum(board, board.turn)
    own_after  = _material_sum(after, board.turn)
    mat_change = (own_after - own_before) / 9.0

    # Avoid is_checkmate() — it generates all legal moves (very slow).
    # is_check() + material change already capture the key signal.
    gives_check = after.is_check()
    return [
        float(gives_check),
        float(gives_check and not any(True for _ in after.legal_moves)),  # fast checkmate: only generate if already in check
        mat_change,
        _count_attacked_pieces(after, not board.turn) / 8.0,
        _count_hanging_pieces(after, not board.turn)  / 8.0,
    ]  # 5
