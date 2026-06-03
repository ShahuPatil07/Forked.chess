"""
Chessformer-style encoder for Stage-1 threat classification.

Architecture (following arXiv:2409.12272, "Mastering Chess with a Transformer
Model", adapted from move-prediction to 16-class tactic classification):

  - 64 square-tokens, side-to-move oriented (see board_encoding.py).
  - Linear projection of the 19-dim per-token features to d_model, then a
    learned per-square multiplicative scale + additive bias (the paper's
    "add and multiply by learned offset vectors separate across tokens and
    depth" — supplies absolute positional information).
  - A stack of encoder layers using the relative-position scheme of
    Shaw et al. [4] (the paper's final, best-ablating choice): a learnable
    relative embedding is added to the keys (attention logits) and to the
    values (attention output), bucketed by the 2-D rank/file displacement
    between squares. QKV projections carry no bias (per the paper).
  - Mish activation in the feed-forward sublayer; Post-LN normalisation.
  - Classification head: mean-pooled board embedding concatenated with the
    move's from-square and to-square token embeddings (the tactic is defined by
    that move), then an MLP to 16 logits.

The contrastive (SupCon) objective from the handoff is a *later* iteration; this
first iteration is plain weighted cross-entropy to read off pure eval accuracy.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

from .board_encoding import (
    NUM_SQUARES,
    NUM_PIECE_CODES,
    TOKEN_FEATURE_DIM,
    NUM_RELATIVE_BUCKETS,
    relative_index_matrix,
)


@dataclass
class ModelConfig:
    n_classes:   int   = 16
    d_model:     int   = 256
    n_layers:    int   = 6
    n_heads:     int   = 8
    d_ff:        int   = 512
    dropout:     float = 0.1
    pool:        str   = "mean_move"   # mean over tokens + from/to token embeds
    proj_dim:    int   = 0             # >0 adds a SupCon projection head


def build_token_features(
    codes:  torch.Tensor,   # int64 [B, 64]
    from_sq: torch.Tensor,  # int64 [B]
    to_sq:   torch.Tensor,  # int64 [B]
    ep_sq:   torch.Tensor,  # int64 [B]  (-1 if none)
    castle:  torch.Tensor,  # float [B, 4]
) -> torch.Tensor:
    """Build the dense [B, 64, 19] per-token feature tensor from compact ints."""
    B = codes.shape[0]
    device = codes.device

    # Piece one-hot: 13-way (0=empty) -> drop the empty channel -> 12 dims.
    piece = F.one_hot(codes.clamp(min=0).long(), NUM_PIECE_CODES)[..., 1:].float()  # [B,64,12]

    squares = torch.arange(NUM_SQUARES, device=device).unsqueeze(0)  # [1,64]
    is_from = (squares == from_sq.unsqueeze(1)).float().unsqueeze(-1)  # [B,64,1]
    is_to   = (squares == to_sq.unsqueeze(1)).float().unsqueeze(-1)
    is_ep   = (squares == ep_sq.unsqueeze(1)).float().unsqueeze(-1)

    castle_b = castle.unsqueeze(1).expand(B, NUM_SQUARES, 4).float()   # [B,64,4]

    return torch.cat([piece, is_from, is_to, is_ep, castle_b], dim=-1)  # [B,64,19]


class ShawRelativeAttention(nn.Module):
    """Multi-head self-attention with Shaw et al. relative position embeddings
    added to keys (logits) and values (output). No bias on QKV projections."""

    def __init__(self, d_model: int, n_heads: int, dropout: float):
        super().__init__()
        assert d_model % n_heads == 0
        self.n_heads = n_heads
        self.d_head  = d_model // n_heads

        self.w_q = nn.Linear(d_model, d_model, bias=False)
        self.w_k = nn.Linear(d_model, d_model, bias=False)
        self.w_v = nn.Linear(d_model, d_model, bias=False)
        self.w_o = nn.Linear(d_model, d_model, bias=True)  # output proj keeps bias
        self.drop = nn.Dropout(dropout)

        # Per-head relative embeddings for keys and values.
        self.a_k = nn.Parameter(torch.zeros(n_heads, NUM_RELATIVE_BUCKETS, self.d_head))
        self.a_v = nn.Parameter(torch.zeros(n_heads, NUM_RELATIVE_BUCKETS, self.d_head))
        nn.init.normal_(self.a_k, std=0.02)
        nn.init.normal_(self.a_v, std=0.02)

        rel = torch.from_numpy(relative_index_matrix())  # [64,64] long
        self.register_buffer("rel_index", rel, persistent=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, _ = x.shape
        H, dh = self.n_heads, self.d_head

        q = self.w_q(x).view(B, T, H, dh).transpose(1, 2)  # [B,H,T,dh]
        k = self.w_k(x).view(B, T, H, dh).transpose(1, 2)
        v = self.w_v(x).view(B, T, H, dh).transpose(1, 2)

        # Content logits + relative-key logits. The relative terms are computed
        # as batched matmuls over the (head, query) axis so they hit BLAS rather
        # than the slow generic einsum path (≈5x faster on CPU, identical math).
        content = torch.matmul(q, k.transpose(-1, -2))          # [B,H,T,T]
        a_k_rel = self.a_k[:, self.rel_index]                   # [H,T,T,dh]
        # rel_k[b,h,i,j] = sum_d q[b,h,i,d] * a_k_rel[h,i,j,d]
        q2 = q.permute(1, 2, 0, 3).reshape(H * T, B, dh)        # [(h i), B, dh]
        ak2 = a_k_rel.reshape(H * T, T, dh).transpose(1, 2)     # [(h i), dh, T]
        rel_k = torch.bmm(q2, ak2).view(H, T, B, T).permute(2, 0, 1, 3)  # [B,H,T,T]
        logits = (content + rel_k) / math.sqrt(dh)

        attn = self.drop(F.softmax(logits, dim=-1))

        # Content output + relative-value output.
        out     = torch.matmul(attn, v)                         # [B,H,T,dh]
        a_v_rel = self.a_v[:, self.rel_index]                   # [H,T,T,dh]
        # rel_v[b,h,i,d] = sum_j attn[b,h,i,j] * a_v_rel[h,i,j,d]
        p2 = attn.permute(1, 2, 0, 3).reshape(H * T, B, T)      # [(h i), B, j]
        av2 = a_v_rel.reshape(H * T, T, dh)                     # [(h i), j, dh]
        rel_v = torch.bmm(p2, av2).view(H, T, B, dh).permute(2, 0, 1, 3)  # [B,H,T,dh]
        out = out + rel_v

        out = out.transpose(1, 2).reshape(B, T, H * dh)
        return self.w_o(out)


class EncoderLayer(nn.Module):
    """Post-LN encoder layer with Shaw relative attention and a Mish FFN."""

    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.attn = ShawRelativeAttention(cfg.d_model, cfg.n_heads, cfg.dropout)
        self.ln1  = nn.LayerNorm(cfg.d_model)
        self.ff   = nn.Sequential(
            nn.Linear(cfg.d_model, cfg.d_ff),
            nn.Mish(),
            nn.Dropout(cfg.dropout),
            nn.Linear(cfg.d_ff, cfg.d_model),
        )
        self.ln2  = nn.LayerNorm(cfg.d_model)
        self.drop = nn.Dropout(cfg.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.ln1(x + self.drop(self.attn(x)))    # Post-LN
        x = self.ln2(x + self.drop(self.ff(x)))
        return x


class ChessformerClassifier(nn.Module):
    def __init__(self, cfg: ModelConfig):
        super().__init__()
        self.cfg = cfg

        self.input_proj = nn.Linear(TOKEN_FEATURE_DIM, cfg.d_model)
        # Learned per-square multiplicative scale + additive bias (absolute pos).
        self.pos_scale = nn.Parameter(torch.ones(NUM_SQUARES, cfg.d_model))
        self.pos_bias  = nn.Parameter(torch.zeros(NUM_SQUARES, cfg.d_model))

        self.layers = nn.ModuleList(EncoderLayer(cfg) for _ in range(cfg.n_layers))
        self.norm   = nn.LayerNorm(cfg.d_model)

        head_in = cfg.d_model * 3 if cfg.pool == "mean_move" else cfg.d_model
        self.head = nn.Sequential(
            nn.Linear(head_in, cfg.d_model),
            nn.Mish(),
            nn.Dropout(cfg.dropout),
            nn.Linear(cfg.d_model, cfg.n_classes),
        )
        # Optional SupCon projection head (only built when proj_dim > 0, so plain
        # cross-entropy checkpoints still load with strict=True).
        self.proj = None
        if cfg.proj_dim > 0:
            self.proj = nn.Sequential(
                nn.Linear(head_in, cfg.d_model),
                nn.Mish(),
                nn.Linear(cfg.d_model, cfg.proj_dim),
            )

    def encode(self, batch: dict[str, torch.Tensor]) -> torch.Tensor:
        """Return the pooled board embedding (pre-head), useful for kNN / SupCon."""
        feats = build_token_features(
            batch["codes"], batch["from_sq"], batch["to_sq"],
            batch["ep_sq"], batch["castle"],
        )                                                   # [B,64,19]
        x = self.input_proj(feats) * self.pos_scale + self.pos_bias
        for layer in self.layers:
            x = layer(x)
        x = self.norm(x)                                    # [B,64,d]

        pooled = x.mean(dim=1)                              # [B,d]
        if self.cfg.pool == "mean_move":
            idx = torch.arange(x.shape[0], device=x.device)
            from_tok = x[idx, batch["from_sq"].clamp(min=0)]
            to_tok   = x[idx, batch["to_sq"].clamp(min=0)]
            pooled = torch.cat([pooled, from_tok, to_tok], dim=-1)  # [B,3d]
        return pooled

    def forward(self, batch: dict[str, torch.Tensor]) -> torch.Tensor:
        return self.head(self.encode(batch))               # [B, n_classes]


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)
