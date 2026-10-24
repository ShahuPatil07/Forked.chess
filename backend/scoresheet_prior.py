"""
Human-move prior for the scoresheet decoder: Maia2 move probabilities, batched.

When a written move is illegal (a player's slip or a misread), several legal
moves can be equally close on paper -- "Bd7" might be Bd6 or Be7. A human reader
breaks that tie by asking which move a player would actually make; Maia2 (the
human-move model the Play-vs-Maia bot already loads) gives exactly that. The
decoder only consults it at cells that need a correction.
"""
from __future__ import annotations

import logging
from collections import OrderedDict
from threading import Lock

import chess

log = logging.getLogger("forked.ocr")
_cache: "OrderedDict[tuple, dict[str, float]]" = OrderedDict()
_lock = Lock()
_MAX = 20_000


def _mirror(uci: str) -> str:
    def m(sq: str) -> str:
        return sq[0] + str(9 - int(sq[1]))
    return m(uci[:2]) + m(uci[2:4]) + uci[4:]


def move_logprobs(boards: list[chess.Board], elo: int = 1500) -> list[dict[str, float]] | None:
    """log P(move) over legal moves for each board, or None if Maia2 isn't available."""
    from backend.bot import maia_engine
    if not maia_engine._ensure_loaded():
        return None
    import torch
    from maia2.inference import preprocessing
    model, prepared = maia_engine._model, maia_engine._prepared
    all_moves_dict, elo_dict, rev = prepared

    out: list[dict[str, float] | None] = []
    todo: list[int] = []
    for i, b in enumerate(boards):
        if not any(b.generate_legal_moves()):      # mate / stalemate: nothing to rank (Maia can't take it)
            out.append({})
            continue
        k = (b._transposition_key(), elo)
        with _lock:
            hit = _cache.get(k)
        out.append(hit)
        if hit is None:
            todo.append(i)
    if todo:
        tens, es, eo, legal = [], [], [], []
        for i in todo:
            bi, s, o, lm = preprocessing(boards[i].fen(), elo, elo, elo_dict, all_moves_dict)
            tens.append(bi); es.append(s); eo.append(o); legal.append(lm)
        with torch.no_grad():
            logits, _, _ = model(torch.stack(tens), torch.tensor(es), torch.tensor(eo))
            mask = torch.stack(legal) > 0
            logp = torch.log_softmax(logits.masked_fill(~mask, float("-inf")), dim=-1)
        for row, i in enumerate(todo):
            black = boards[i].turn == chess.BLACK
            idx = mask[row].nonzero().flatten().tolist()
            vals = logp[row, idx].tolist()
            d = {(_mirror(rev[j]) if black else rev[j]): v for j, v in zip(idx, vals)}
            out[i] = d
            with _lock:
                _cache[(boards[i]._transposition_key(), elo)] = d
                if len(_cache) > _MAX:
                    _cache.popitem(last=False)
    return out  # type: ignore[return-value]
