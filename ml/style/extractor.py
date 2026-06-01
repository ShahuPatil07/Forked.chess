"""
Chess DNA — playing-style profile (5 axes + archetype).

Computed from the user's persisted mistake events + game metadata. We do NOT
re-annotate every move (too expensive at request time); instead each axis is
derived from the rich mistake dataset with documented proxies, and any axis
that lacks enough data is reported as `None` so the card omits it.

Output (cached in {username}_style.json):
  {
    "archetype": "The Attacker",
    "axis1".."axis5": int 0..100 | None,
    "n_games": int,
    "n_mistakes": int,
    "computed_at": iso8601,
    "insufficient": bool,        # True when < MIN_GAMES
  }

Axis semantics (0..100):
  axis1  Positional(0) ↔ Tactical(100)
  axis2  Solid(0)      ↔ Aggressive(100)
  axis3  Conservative(0) ↔ Risk-taker(100)
  axis4  Endgame(0)    ↔ Middlegame(100)
  axis5  Time pressure(0) ↔ Time calm(100)
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import statistics
from pathlib import Path
from typing import Optional

from ml.config import DATA_DIR

log = logging.getLogger("forked.style")

OUTPUT_DIR = DATA_DIR / "output"

MIN_GAMES         = 50    # below this, no style profile
MIN_AXIS_MISTAKES = 20    # per-phase / per-axis minimum for a meaningful score

TACTICAL_THREATS = {
    "fork", "pin", "skewer", "discovered_attack", "back_rank",
    "removing_defender", "deflection", "trapped_piece", "king_attack",
    "overloaded_piece", "zwischenzug", "hanging_piece", "missed_threat",
}
POSITIONAL_THREATS = {
    "piece_activity", "endgame_technique", "passed_pawn", "pawn_structure",
}

ARCHETYPE_DESCRIPTIONS = {
    "The Attacker":   "You play sharp, risky chess and look for the kill",
    "The Tactician":  "You spot combinations but choose your battles",
    "The Gambiteer":  "You sacrifice material for initiative and complexity",
    "The Calculator": "You calculate precisely and exploit tactical chaos",
    "The Strategist": "You outmanoeuvre opponents with long-term plans",
    "The Grinder":    "You convert advantages slowly and surely",
    "The Pragmatist": "You adapt your style to what the position demands",
    "The Fortress":   "You defend tenaciously and wait for opponent errors",
}


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _clamp(x: float) -> int:
    return int(round(max(0.0, min(100.0, x))))


# ── Axis computations ─────────────────────────────────────────────────────────

def _axis1_tactical(mistakes: list[dict], games: dict) -> Optional[int]:
    """Positional(0) ↔ Tactical(100). threat-type mix + eval volatility."""
    classified = [m for m in mistakes if m.get("threat_type") not in (None, "other")]
    tac = sum(1 for m in classified if m["threat_type"] in TACTICAL_THREATS)
    pos = sum(1 for m in classified if m["threat_type"] in POSITIONAL_THREATS)
    denom = tac + pos
    if denom < MIN_AXIS_MISTAKES:
        # Fall back to all-classified ratio if the tactical/positional split is thin
        if len(classified) < MIN_AXIS_MISTAKES:
            return None
        tactical_ratio = tac / max(1, len(classified))
    else:
        tactical_ratio = tac / denom

    # Eval volatility proxy: stdev of eval_before across each game's mistakes,
    # averaged over games (high swing → sharper, more tactical games).
    per_game_std = []
    for evs in games.values():
        evals = [e.get("eval_before_cp") for e in evs if e.get("eval_before_cp") is not None]
        if len(evals) >= 2:
            per_game_std.append(statistics.pstdev(evals))
    norm_var = 0.5
    if per_game_std:
        avg_std = statistics.mean(per_game_std)
        norm_var = max(0.0, min(1.0, avg_std / 300.0))   # ~300cp stdev → fully tactical

    score = (tactical_ratio * 0.6 + norm_var * 0.4) * 100
    return _clamp(score)


def _axis2_aggressive(mistakes: list[dict]) -> Optional[int]:
    """
    Solid(0) ↔ Aggressive(100). We lack full-game evals, so proxy aggression
    from WHERE/HOW the user errs: aggressive players blunder more in sharp
    attacking phases (king_attack / sacrifice motifs) and earlier in games.
    """
    classified = [m for m in mistakes if m.get("threat_type") not in (None, "other")]
    if len(classified) < MIN_AXIS_MISTAKES:
        return None
    attacking = {"king_attack", "fork", "discovered_attack", "back_rank", "skewer"}
    attack_ratio = sum(1 for m in classified if m["threat_type"] in attacking) / len(classified)

    # Earlier-phase error share (aggressive players force matters early).
    early = sum(1 for m in mistakes if m.get("game_phase") in ("opening", "middlegame"))
    early_ratio = early / max(1, len(mistakes))

    # Average size of swings the user creates/suffers — bigger swings → sharper play.
    drops = [m.get("eval_drop_cp", 0) for m in mistakes if m.get("eval_drop_cp")]
    drop_norm = min(1.0, (statistics.mean(drops) / 400.0)) if drops else 0.5

    score = (attack_ratio * 0.45 + early_ratio * 0.30 + drop_norm * 0.25) * 100
    return _clamp(score)


def _axis3_risk(mistakes: list[dict], games: dict) -> Optional[int]:
    """
    Conservative(0) ↔ Risk-taker(100). Proxy from volatility of the user's
    positions: large per-game eval swings and frequently sitting in worse
    positions (eval_before < -100 from mover POV) indicate risk tolerance.
    """
    if len(mistakes) < MIN_AXIS_MISTAKES:
        return None
    # Fraction of mistake positions where the user had already accepted a worse
    # position (eval_before < -100cp from their POV) — tolerance for complexity.
    worse = sum(1 for m in mistakes
                if m.get("eval_before_cp") is not None and m["eval_before_cp"] < -100)
    worse_ratio = worse / len(mistakes)

    # Average peak-to-trough eval swing per game (from mistake eval_before values).
    swings = []
    for evs in games.values():
        evals = [e.get("eval_before_cp") for e in evs if e.get("eval_before_cp") is not None]
        if len(evals) >= 2:
            swings.append(max(evals) - min(evals))
    swing_norm = 0.5
    if swings:
        swing_norm = max(0.0, min(1.0, statistics.mean(swings) / 600.0))

    score = (worse_ratio * 0.5 + swing_norm * 0.5) * 100
    return _clamp(score)


def _axis4_phase(mistakes: list[dict]) -> Optional[int]:
    """Endgame(0) ↔ Middlegame(100) specialist, via phase-relative accuracy."""
    def phase_drop(phase: str):
        drops = [m.get("eval_drop_cp", 0) for m in mistakes if m.get("game_phase") == phase]
        if len(drops) < MIN_AXIS_MISTAKES:
            return None
        return statistics.mean(drops)

    mid = phase_drop("middlegame")
    end = phase_drop("endgame")
    if mid is None or end is None:
        return None

    MAXD = 600.0  # normaliser for "max possible drop"
    mid_acc = max(0.0, 1.0 - mid / MAXD)
    end_acc = max(0.0, 1.0 - end / MAXD)
    if (mid_acc + end_acc) == 0:
        return None
    # higher → better in middlegame than endgame → middlegame specialist
    return _clamp(mid_acc / (mid_acc + end_acc) * 100)


def _axis5_time(mistakes: list[dict]) -> Optional[int]:
    """
    Time pressure(0) ↔ Time calm(100). Compare mistake rate in low-clock vs
    high-clock states. time_remaining_ms is the clock AFTER the move.
    """
    timed = [m for m in mistakes if m.get("time_remaining_ms") is not None]
    if len(timed) < MIN_AXIS_MISTAKES:
        return None
    low  = sum(1 for m in timed if m["time_remaining_ms"] < 30_000)   # < 30s
    high = sum(1 for m in timed if m["time_remaining_ms"] > 60_000)   # > 60s
    if low + high == 0:
        return None
    low_ratio = low / (low + high)     # high → many blunders under time pressure
    # calm score is the inverse of the low-clock blunder share
    return _clamp((1.0 - low_ratio) * 100)


# ── Archetype ──────────────────────────────────────────────────────────────────

def _archetype(a1: Optional[int], a2: Optional[int], a3: Optional[int]) -> str:
    """Threshold rules on tactical/aggressive/risk (default missing axes to 50)."""
    tactical    = (a1 if a1 is not None else 50) > 55
    aggressive  = (a2 if a2 is not None else 50) > 55
    risk        = (a3 if a3 is not None else 50) > 55
    table = {
        (True,  True,  True):  "The Attacker",
        (True,  True,  False): "The Tactician",
        (True,  False, True):  "The Gambiteer",
        (True,  False, False): "The Calculator",
        (False, True,  True):  "The Strategist",
        (False, True,  False): "The Grinder",
        (False, False, True):  "The Pragmatist",
        (False, False, False): "The Fortress",
    }
    return table[(tactical, aggressive, risk)]


# ── Public API ──────────────────────────────────────────────────────────────────

def compute_style(username: str, output_dir: Optional[Path] = None) -> dict:
    """Compute + cache the style profile. Always writes {username}_style.json."""
    out_dir = output_dir or OUTPUT_DIR
    mistakes = _read_json(out_dir / f"{username}_mistakes.json", [])
    n_games  = len(set(m.get("game_id") for m in mistakes if m.get("game_id")))

    base = {
        "username":    username,
        "archetype":   None,
        "axis1": None, "axis2": None, "axis3": None, "axis4": None, "axis5": None,
        "n_games":     n_games,
        "n_mistakes":  len(mistakes),
        "computed_at": dt.datetime.utcnow().isoformat(),
        "insufficient": n_games < MIN_GAMES,
    }

    if n_games < MIN_GAMES:
        _write(out_dir, username, base)
        return base

    games: dict[str, list] = {}
    for m in mistakes:
        games.setdefault(m.get("game_id"), []).append(m)

    a1 = _axis1_tactical(mistakes, games)
    a2 = _axis2_aggressive(mistakes)
    a3 = _axis3_risk(mistakes, games)
    a4 = _axis4_phase(mistakes)
    a5 = _axis5_time(mistakes)

    base.update({
        "axis1": a1, "axis2": a2, "axis3": a3, "axis4": a4, "axis5": a5,
        "archetype": _archetype(a1, a2, a3),
    })
    _write(out_dir, username, base)
    log.info("Style for %s: %s  axes=%s", username, base["archetype"],
             [a1, a2, a3, a4, a5])
    return base


def _write(out_dir: Path, username: str, data: dict) -> None:
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_dir / f"{username}_style.json", "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, default=str)
    except Exception as exc:
        log.warning("Could not write style profile for %s: %s", username, exc)


def load_style(username: str, output_dir: Optional[Path] = None) -> Optional[dict]:
    out_dir = output_dir or OUTPUT_DIR
    return _read_json(out_dir / f"{username}_style.json", None)
