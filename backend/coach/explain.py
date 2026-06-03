"""
Position explanation — explain_position tool backend.

Strategy (per the spec):
  1. C1 (CSSLab) — grounded chain-of-thought chess reasoning. C1 is a Qwen3 SFT/RL
     model that needs a GPU + vLLM, so we talk to it over an OpenAI-compatible
     endpoint when one is configured (env C1_ENDPOINT, optional C1_API_KEY,
     C1_MODEL). This means the moment a C1 vLLM server exists, it lights up — no
     code change. There are no public C1 weights yet, so by default this path is
     dormant.
  2. Stockfish depth-18 + structured template — always available, no GPU. This is
     the guaranteed fallback and what runs today.

Both return: {"explanation": str, "best_move_san": str|None, "eval": str|None,
              "source": "c1"|"stockfish"}
"""
from __future__ import annotations

import os
import logging
from typing import Optional

import chess

log = logging.getLogger(__name__)

C1_TIMEOUT_S = 3.0   # spec: fall back if C1 takes >3s


# ── C1 path (optional, endpoint-driven) ────────────────────────────────────────

def _c1_available() -> bool:
    return bool(os.environ.get("C1_ENDPOINT"))


def _explain_with_c1(fen: str, question: str) -> Optional[dict]:
    """Call a C1 vLLM OpenAI-compatible endpoint. Returns None on any failure so
    the caller falls back to Stockfish."""
    endpoint = os.environ.get("C1_ENDPOINT")
    if not endpoint:
        return None
    try:
        from openai import OpenAI  # vLLM serves an OpenAI-compatible API
        client = OpenAI(
            base_url=endpoint.rstrip("/"),
            api_key=os.environ.get("C1_API_KEY", "not-needed"),
            timeout=C1_TIMEOUT_S,
        )
        prompt = (
            f"FEN: {fen}\n"
            f"Question: {question or 'Explain the best move and the key idea in this position.'}\n"
            "Reason step by step about the position, then give the best move and the plan."
        )
        resp = client.chat.completions.create(
            model=os.environ.get("C1_MODEL", "c1"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=400,
        )
        text = (resp.choices[0].message.content or "").strip()
        if not text:
            return None
        return {"explanation": text, "best_move_san": None, "eval": None, "source": "c1"}
    except Exception as exc:
        log.info("C1 unavailable, falling back to Stockfish: %s", exc)
        return None


# ── Stockfish fallback (always works) ──────────────────────────────────────────

def _score_to_str(score: chess.engine.PovScore) -> str:
    white = score.white()
    if white.is_mate():
        m = white.mate()
        return f"mate in {abs(m)}" + (" (you)" if m and m > 0 else " (against you)")
    cp = white.score()
    if cp is None:
        return "unclear"
    val = cp / 100.0
    return f"{'+' if val >= 0 else ''}{val:.1f}"


def _explain_with_stockfish(fen: str, question: str) -> dict:
    from backend.main import _sf_lock, _ensure_engine
    import chess.engine

    board = chess.Board(fen)
    side = "White" if board.turn == chess.WHITE else "Black"

    with _sf_lock:
        engine = _ensure_engine()
        info = engine.analyse(board, chess.engine.Limit(depth=18))

    score = info.get("score")
    pv = info.get("pv") or []
    best_move = pv[0] if pv else None
    best_san = board.san(best_move) if best_move else None
    eval_str = _score_to_str(score) if score is not None else None

    # Name the motif of the engine's best move (reuse Stage-1 classifier).
    motif = ""
    if best_move:
        try:
            from ml.ingestion.threat_classifier import classify_threat
            t = classify_threat(fen, best_move.uci(), "")
            if t and t != "other":
                motif = t.replace("_", " ")
        except Exception:
            pass

    # Short PV in SAN for a concrete line.
    line_sans, tmp = [], chess.Board(fen)
    for mv in pv[:5]:
        try:
            line_sans.append(tmp.san(mv)); tmp.push(mv)
        except Exception:
            break
    line_str = " ".join(line_sans)

    parts = []
    if best_san:
        parts.append(f"The best move for {side} is {best_san}.")
    if eval_str:
        parts.append(f"After it the evaluation is {eval_str} (engine depth 18).")
    if motif:
        parts.append(f"The key idea is a {motif} motif.")
    if line_str:
        parts.append(f"A principal line: {line_str}.")
    if not parts:
        parts.append("This position is roughly balanced with no forcing continuation.")

    return {
        "explanation": " ".join(parts),
        "best_move_san": best_san,
        "eval": eval_str,
        "source": "stockfish",
    }


def explain_position(fen: str, question: str = "") -> dict:
    """Explain a FEN. Tries C1 (if configured) then Stockfish. Validates the FEN."""
    try:
        chess.Board(fen)
    except Exception:
        return {"explanation": f"That FEN looks invalid: {fen!r}.",
                "best_move_san": None, "eval": None, "source": "error"}

    if _c1_available():
        out = _explain_with_c1(fen, question)
        if out:
            return out
    return _explain_with_stockfish(fen, question)
