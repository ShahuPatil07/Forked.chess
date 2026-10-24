"""
Move selection for every Forked opponent (Play vs Maia, opening practice,
endgame practice, the Coach's play mode).

    choose_move(board, engine="maia" | "stockfish", target_elo=<Lichess scale>, opp_elo=...)

Engines
  stockfish  Full-strength Stockfish (dedicated process, separate from the
             analysis engine so a game never waits behind a review). "The most
             accurate chess" — used as the top level everywhere.
  maia       Human-like play. The human move distribution comes from
               * Maia-3 when installed (CSSLab, 2026; the successor to Maia-2 with
                 better human-move matching). Opt-in: install the `maia3`
                 package (see README) or set MAIA3_UCI_CMD; it is detected at
                 runtime and used automatically, Maia-2 otherwise;
               * Maia-2 (rapid model) — its rating buckets are <1100,
                 1100–1999 in 100s and ≥2000 (Lichess ratings).
             Level mapping on the Lichess scale:
               < 2000   pure Maia. Below 1800 we SAMPLE from Maia's distribution
                        (moves with p ≥ 5%, temperature by level) instead of always
                        playing the single most likely move: argmax Maia is known
                        to play well above its nominal rating because it never
                        makes the occasional human mistake.
               ≥ 2000   "Maia+": Maia's most human candidates at the top bucket,
                        each checked by Stockfish; a candidate is allowed only if it
                        loses less than a level-dependent margin (120 → 15 cp from
                        2000 → 2800). Among the safe ones the MOST human is played,
                        so it stays human-like while matching stronger players.
Ratings arriving from the UI are converted to the Lichess scale first
(backend/ratings.py) because Maia was trained on Lichess games.
"""
from __future__ import annotations

import logging
import os
import random
import shutil
import threading
from typing import Optional

import chess
import chess.engine

from ml.config import STOCKFISH_PATH

log = logging.getLogger("forked.bot.engines")

MAIA_MAX = 2000          # Maia-2's top bucket starts here
PLUS_MAX = 2800

_sf_lock = threading.Lock()
_sf: Optional[chess.engine.SimpleEngine] = None
_m3_lock = threading.Lock()
_m3: Optional[chess.engine.SimpleEngine] = None
_m3_failed = False


# ── Stockfish (bot play) ────────────────────────────────────────────────────

def _stockfish() -> chess.engine.SimpleEngine:
    global _sf
    if _sf is None:
        _sf = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH))
        try:
            _sf.configure({"Threads": 2, "Hash": 128})
        except Exception:
            pass
    return _sf


def stockfish_move(board: chess.Board, think_s: float = 0.8) -> str:
    with _sf_lock:
        try:
            res = _stockfish().play(board, chess.engine.Limit(time=think_s, depth=22))
        except chess.engine.EngineTerminatedError:
            globals()["_sf"] = None
            res = _stockfish().play(board, chess.engine.Limit(time=think_s, depth=22))
    return res.move.uci()


def _evaluate(board: chess.Board, moves: list[chess.Move], depth: int = 12) -> dict[str, int]:
    """Centipawn score (mover POV) of each candidate, plus the best overall under '__best__'."""
    out: dict[str, int] = {}
    with _sf_lock:
        eng = _stockfish()
        infos = eng.analyse(board, chess.engine.Limit(depth=depth), multipv=len(moves), root_moves=moves)
        best = eng.analyse(board, chess.engine.Limit(depth=depth))
    for info in infos:
        if info.get("pv"):
            out[info["pv"][0].uci()] = info["score"].pov(board.turn).score(mate_score=10_000)
    out["__best__"] = best["score"].pov(board.turn).score(mate_score=10_000)
    if best.get("pv"):
        out["__best_move__"] = best["pv"][0].uci()   # type: ignore[assignment]
    return out


# ── Maia-3 (optional) ───────────────────────────────────────────────────────

def _maia3_cmd() -> Optional[list[str]]:
    env = os.environ.get("MAIA3_UCI_CMD")
    if env:
        return env.split()
    exe = shutil.which("maia3-uci")
    if not exe:
        return None
    model = os.environ.get("MAIA3_MODEL", "maia3-23m")
    return [exe, "--model", model, "--use-uci-history", "--device", "cpu", "--no-use-amp"]


def maia3_available() -> bool:
    return not _m3_failed and _maia3_cmd() is not None


def _maia3_candidates(board: chess.Board, self_elo: int, opp_elo: int, k: int) -> Optional[list[str]]:
    """Maia-3's top-k human moves (most likely first), or None if unavailable."""
    global _m3, _m3_failed
    if _m3_failed:
        return None
    cmd = _maia3_cmd()
    if not cmd:
        return None
    with _m3_lock:
        try:
            if _m3 is None:
                _m3 = chess.engine.SimpleEngine.popen_uci(cmd)
                log.info("Maia-3 engine started: %s", " ".join(cmd))
            opts = {}
            for name, value in (("SelfElo", self_elo), ("OppoElo", opp_elo), ("Temperature", 0)):
                if name in _m3.options:
                    opts[name] = value
            if opts:
                _m3.configure(opts)
            infos = _m3.analyse(board, chess.engine.Limit(nodes=1), multipv=k)
            return [i["pv"][0].uci() for i in infos if i.get("pv")]
        except Exception as exc:
            log.warning("Maia-3 unavailable (%s) — using Maia-2.", exc)
            _m3_failed = True
            try:
                if _m3 is not None:
                    _m3.quit()
            except Exception:
                pass
            _m3 = None
            return None


# ── Maia-2 ──────────────────────────────────────────────────────────────────

def _maia2_probs(board: chess.Board, self_elo: int, opp_elo: int) -> dict[str, float]:
    from backend.bot import maia_engine
    if not maia_engine._ensure_loaded():
        return {}
    import maia2.inference as m2_inf
    with maia_engine._lock:
        probs, _ = m2_inf.inference_each(maia_engine._model, maia_engine._prepared, board.fen(), self_elo, opp_elo)
    legal = {m.uci() for m in board.legal_moves}
    probs = {u: p for u, p in probs.items() if u in legal}
    return maia_engine._filter_ood_retreats(probs, board)


def _temperature(target: int) -> float:
    if target < 1400:
        return 1.0
    if target < 1800:
        return 0.6
    return 0.0


def _sample(probs: dict[str, float], temperature: float, rng: random.Random) -> str:
    top = max(probs, key=probs.__getitem__)
    if temperature <= 0:
        return top
    pool = {u: p for u, p in probs.items() if p >= 0.05} or {top: 1.0}
    weights = [p ** (1.0 / temperature) for p in pool.values()]
    return rng.choices(list(pool), weights=weights, k=1)[0]


def _margin(target: int) -> int:
    """How much worse than Stockfish's best a 'Maia+' move may be, by level."""
    pts = [(2000, 120), (2200, 80), (2400, 50), (2600, 30), (2800, 15)]
    if target <= pts[0][0]:
        return pts[0][1]
    for (a, ma), (b, mb) in zip(pts, pts[1:]):
        if target <= b:
            return int(round(ma + (mb - ma) * (target - a) / (b - a)))
    return pts[-1][1]


def maia_move(board: chess.Board, target: int, opp: int, rng: Optional[random.Random] = None) -> tuple[str, dict]:
    from backend.bot import maia_engine
    rng = rng or random.Random()
    # Maia-2 is out of distribution on move 1 from the standard start (see maia_engine);
    # only then use the central-pawn override — never in endgame / custom positions.
    if len(board.move_stack) <= 1 and board.root().board_fen() == chess.STARTING_BOARD_FEN \
            and board.fullmove_number == 1:
        return maia_engine._pick_first_move(board), {"engine": "book"}

    self_elo = max(600, min(MAIA_MAX, target))
    opp_elo = max(600, min(MAIA_MAX, opp))

    # human candidates: Maia-3 if present, else Maia-2 probabilities
    m3 = _maia3_candidates(board, min(target, PLUS_MAX), opp, 8) if maia3_available() else None
    probs: dict[str, float] = {}
    if m3:
        n = len(m3)
        probs = {u: (n - i) / (n * (n + 1) / 2) for i, u in enumerate(m3)}   # rank weights, most likely first
        source = "maia3"
    else:
        probs = _maia2_probs(board, self_elo, opp_elo)
        source = "maia2"
    if not probs:
        legal = list(board.legal_moves)
        return rng.choice(legal).uci(), {"engine": "random"}

    if target < MAIA_MAX:
        temp = 0.0 if source == "maia3" else _temperature(target)
        return _sample(probs, temp, rng), {"engine": source, "mode": "human", "temperature": temp}

    # Maia+ : most human move that stays within the level's margin of Stockfish's best
    ranked = sorted(probs, key=probs.__getitem__, reverse=True)
    cands, cum = [], 0.0
    for u in ranked:
        cands.append(u)
        cum += probs[u]
        if cum >= 0.95 or len(cands) >= 8:
            break
    try:
        evals = _evaluate(board, [chess.Move.from_uci(u) for u in cands])
    except Exception as exc:
        log.warning("Maia+ check failed (%s) — playing Maia's choice.", exc)
        return ranked[0], {"engine": source, "mode": "human"}
    best_cp = evals.get("__best__", 0)
    margin = _margin(target)
    safe = [u for u in cands if u in evals and best_cp - evals[u] <= margin]
    if safe:
        return safe[0], {"engine": source, "mode": "maia+", "margin": margin}
    best_move = evals.get("__best_move__")
    return (best_move if isinstance(best_move, str) else ranked[0]), {"engine": "stockfish-check", "mode": "maia+"}


def choose_move(board: chess.Board, engine: str = "maia", target_elo: int = 1500, opp_elo: int = 1500) -> tuple[str, dict]:
    if board.is_game_over():
        raise ValueError("Game is over")
    if engine == "stockfish":
        return stockfish_move(board), {"engine": "stockfish"}
    return maia_move(board, int(target_elo), int(opp_elo))


def engine_info() -> dict:
    return {"maia3": maia3_available(), "maia_max": MAIA_MAX, "plus_max": PLUS_MAX,
            "levels": "Maia-2 (rapid) below 2000 Lichess, Maia+ 2000–2800, Stockfish full strength"}
