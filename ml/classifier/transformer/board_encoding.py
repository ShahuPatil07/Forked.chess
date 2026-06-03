"""
Board encoding for the Stage-1 chess transformer.

Replicates the *input representation* of the Chessformer
("Mastering Chess with a Transformer Model", arXiv:2409.12272): the board is a
sequence of **64 tokens, one per square**, and the board is **flipped with the
side to move** so the model always reasons from the mover's perspective.

We are classifying a *single* position + the engine's solution move (not playing
chess), so unlike the paper we do **not** carry the 8-position history or the
self-play value/policy targets. Each token instead encodes:

    - which piece sits on the square (own vs. opponent, 12-way one-hot), and
    - whether the square is the move's *from* / *to* square, and the en-passant
      square — this is how the move-to-be-classified is injected into the
      per-square token space.

Castling rights are encoded as 4 globals broadcast onto every token.

This module produces a **compact integer encoding** (see `encode_position`) that
`prepare_tensors.py` caches to disk; the dense per-token feature tensor is built
on the fly in `model.py` from those integers (cheap, vectorised in torch).

Token feature layout (built later from this encoding), 19 dims/token:
    [0:12]  piece one-hot   (own P,N,B,R,Q,K then opp P,N,B,R,Q,K; empty = zeros)
    [12]    is move from-square
    [13]    is move to-square
    [14]    is en-passant square
    [15:19] castling rights  (own-K, own-Q, opp-K, opp-Q)  -- broadcast global
"""
from __future__ import annotations

import chess
import numpy as np

TOKEN_FEATURE_DIM = 19   # see layout above
NUM_SQUARES       = 64
NUM_PIECE_CODES    = 13  # 0 = empty, 1..6 = own P..K, 7..12 = opponent P..K


def _piece_code(piece: chess.Piece, mover: chess.Color) -> int:
    """1..6 for the mover's own pieces, 7..12 for the opponent's."""
    base = piece.piece_type  # 1..6 (PAWN..KING)
    return base if piece.color == mover else base + 6


def encode_position(fen: str, move_uci: str) -> dict[str, np.ndarray]:
    """
    Encode (fen, solution move) into compact integer arrays, oriented so the
    side to move always plays "up the board".

    Returns a dict with:
        codes  : int8  [64]  per-square piece code (0..12), board read a1..h8
                              in the mover's orientation
        meta   : int16 [4]   (from_sq, to_sq, ep_sq, promotion)  -- -1 if absent
        castle : int8  [4]   (own-K, own-Q, opp-K, opp-Q) castling rights
        Raises ValueError on an illegal FEN / move.
    """
    board = chess.Board(fen)               # raises on bad FEN
    move  = chess.Move.from_uci(move_uci)

    mover = board.turn
    # Flip with the side to move: mirror swaps colours + flips ranks, leaving
    # WHITE to move. Square indices then map through chess.square_mirror.
    if mover == chess.BLACK:
        board = board.mirror()
        move = chess.Move(
            chess.square_mirror(move.from_square),
            chess.square_mirror(move.to_square),
            promotion=move.promotion,
        )
    # After orientation the mover is always WHITE. Read the en-passant square in
    # the (possibly mirrored) oriented frame directly — board.mirror() already
    # maps ep into that frame, so DON'T mirror it again.
    own = chess.WHITE
    ep_raw = board.ep_square

    codes = np.zeros(NUM_SQUARES, dtype=np.int8)
    for sq, piece in board.piece_map().items():
        codes[sq] = _piece_code(piece, own)

    promo = move.promotion if move.promotion is not None else -1
    meta = np.array(
        [move.from_square, move.to_square,
         ep_raw if ep_raw is not None else -1,
         promo],
        dtype=np.int16,
    )

    castle = np.array([
        board.has_kingside_castling_rights(own),
        board.has_queenside_castling_rights(own),
        board.has_kingside_castling_rights(not own),
        board.has_queenside_castling_rights(not own),
    ], dtype=np.int8)

    return {"codes": codes, "meta": meta, "castle": castle}


# Precomputed 2-D relative-position index for Shaw-style relative attention.
# rel_index[i, j] buckets the (rank, file) displacement between squares i and j
# into one of 15*15 = 225 learnable relative-position embeddings.
def relative_index_matrix() -> np.ndarray:
    """[64, 64] int64 matrix of relative-position bucket ids (0..224)."""
    idx = np.zeros((NUM_SQUARES, NUM_SQUARES), dtype=np.int64)
    for i in range(NUM_SQUARES):
        ri, fi = divmod(i, 8)
        for j in range(NUM_SQUARES):
            rj, fj = divmod(j, 8)
            dr = (ri - rj) + 7          # 0..14
            df = (fi - fj) + 7          # 0..14
            idx[i, j] = dr * 15 + df
    return idx


NUM_RELATIVE_BUCKETS = 15 * 15  # 225
