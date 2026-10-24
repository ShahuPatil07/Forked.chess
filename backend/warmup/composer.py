"""Session composer: band + time control + minutes (+ the player's own-game facts, tilt
state and saved routine) -> an ordered warm-up with its items pre-generated.

Default order: setup_check -> (breathing_reset after a loss / on tilt) -> perception drills
-> thinking drill(s) -> easy_sprint -> ready screen. Every drill step ships item pools at
three difficulty levels (easier / current / harder) so the client can adapt between items
without a network round-trip (ease below ~70% accuracy, harden above ~95%).
"""
from __future__ import annotations

import math
import random

from . import games as G
from . import signals
from .config import cap_ms, cfg, drill_cfg, flash_ms, level_value
from .drills import GENERATORS
from .drills.two_candidates import available as candidates_available

STATE = ("setup_check", "breathing_reset", "worry_dump", "move_nudge")
PERCEPTION = ("check_flash", "double_check_hunt", "loose_pieces", "threat_count", "what_changed")
THINKING = ("opponent_threat", "two_candidates")
ALL_ACTIVITIES = STATE + PERCEPTION + THINKING + ("easy_sprint",)


def _weighted_pick(rng: random.Random, options: list[str], weights: dict[str, float], k: int) -> list[str]:
    pool = [o for o in options if weights.get(o, 0) > 0]
    picked = []
    while pool and len(picked) < k:
        total = sum(weights[o] for o in pool)
        x, acc = rng.random() * total, 0.0
        for o in pool:
            acc += weights[o]
            if x <= acc:
                picked.append(o)
                pool.remove(o)
                break
    return picked


def drill_step(drill: str, band: dict, time_control: str, count: int, ctx: dict, rng: random.Random,
               level: int | None = None) -> dict | None:
    """A drill step with pools at level-1 / level / level+1."""
    lvl = max(1, min(5, level or band["start_level"]))
    levels = sorted({max(1, lvl - 1), lvl, min(5, lvl + 1)})
    pools: dict[str, list[dict]] = {}
    for lv in levels:
        n = count if lv == lvl else math.ceil(count / 2)
        items = GENERATORS[drill](rng, lv, n, ctx)
        for it in items:                         # time scaling for this band / time control
            if "flash_ms" in it:
                it["flash_ms"] = flash_ms(it["flash_ms"], band, time_control)
            if "show_ms" in it:
                it["show_ms"] = flash_ms(it["show_ms"], band, time_control)
        pools[str(lv)] = items
    if not pools.get(str(lvl)):
        return None
    d = drill_cfg(drill)
    return {"activity": drill, "kind": d["kind"], "title": d["title"], "level": lvl, "count": count,
            "cap_ms": cap_ms(drill, band, time_control), "est_s": d["est_s"], "pools": pools}


def state_step(activity: str) -> dict:
    d = drill_cfg(activity)
    return {"activity": activity, "kind": "state", "title": d["title"], "est_s": d["est_s"]}


def play_url(platform: str, time_control: str) -> str:
    """Where "Play now" goes: the Lichess pool for this time control, or chess.com's play page."""
    tc = cfg()["time_controls"].get(time_control, cfg()["time_controls"]["rapid"])
    return (f"https://lichess.org/#pool/{tc['lichess_pool']}" if platform == "lichess"
            else "https://www.chess.com/play/online")


def compose(*, username: str, platform: str, time_control: str, minutes: int, fallback_rating: int | None,
            manual_rating: int | None = None, routine: list[str] | None = None, seed: int | None = None,
            seen: set[str] | None = None) -> dict:
    rng = random.Random(seed)
    band, rating, games = G.band_info(username, platform, time_control, fallback_rating, manual_rating)
    tilt = G.tilt(games, band) if games else {"streak": 0, "triggered": False, "last_result": None,
                                              "threshold": band["tilt_losses"], "break_until": None}
    f = signals.facts(username)
    boost = signals.drill_weights(f)
    budget = cfg()["session"]["budgets"].get(str(minutes)) or cfg()["session"]["budgets"]["5"]
    ctx = {"username": username, "rating": rating["rating"], "band": band, "seen": seen or set()}
    has_bank = candidates_available()

    def items_for(drill: str) -> int:
        if drill == "easy_sprint":
            return budget["sprint_items"]
        return max(3, round(drill_cfg(drill)["items"] * budget["item_scale"]))

    reasons: dict[str, str] = {}
    for item in f.get("focus", []):
        for d in item["drills"]:
            reasons.setdefault(d, f"You {item['label']} in {item['count']} of your imported mistakes.")

    if routine:
        plan = [a for a in routine if a in ALL_ACTIVITIES]
    else:
        pw = {d: (3.0 if d in band["emphasis"] else 1.0) * boost.get(d, 1.0) for d in PERCEPTION}
        tw = {d: (3.0 if d in band["thinking"] else .5) * boost.get(d, 1.0) for d in THINKING
              if d != "two_candidates" or has_bank}
        plan = ["setup_check"]
        if tilt.get("triggered") or tilt.get("last_result") == 0.0:
            plan.append("breathing_reset")
        plan += _weighted_pick(rng, list(PERCEPTION), pw, budget["perception"])
        plan += _weighted_pick(rng, list(tw), tw, budget["thinking"])
        plan.append("easy_sprint")

    steps = []
    for a in plan:
        if a in STATE:
            steps.append(state_step(a))
            continue
        if a == "two_candidates" and not has_bank:
            continue
        step = drill_step(a, band, time_control, items_for(a), ctx, rng)
        if step:
            if a in reasons:
                step["reason"] = reasons[a]
            steps.append(step)

    return {
        "band": {k: band[k] for k in ("id", "label", "multiplier", "tilt_losses")},
        "rating": rating, "time_control": time_control, "minutes": minutes, "tilt": tilt,
        "facts": {"focus": f.get("focus", []), "counts": f.get("counts", {}), "games": f.get("games", 0)},
        "steps": steps, "cue": band["cue"], "play_url": play_url(platform, time_control),
        "adaptive": cfg()["adaptive"], "honesty": cfg()["copy"]["honesty"],
        "timer": cfg().get("timer", {"start_factor": 1.0, "per_item": 0.0, "min_factor": 1.0}),
        "est_s": sum(s.get("est_s", 0) * (s.get("count", 1) / max(1, drill_cfg(s["activity"]).get("items", 1))
                                          if s["kind"] != "state" else 1) for s in steps),
    }


def plan_summary(session: dict) -> dict:
    """Compact plan for the coach tool."""
    return {"band": session["band"]["label"], "rating": session["rating"]["rating"],
            "time_control": session["time_control"], "minutes": session["minutes"],
            "steps": [{"activity": s["activity"], "title": s["title"], "items": s.get("count"),
                       **({"why": s["reason"]} if s.get("reason") else {})} for s in session["steps"]],
            "tilt": {k: session["tilt"].get(k) for k in ("streak", "triggered", "threshold")},
            "focus": [x["label"] for x in session["facts"]["focus"]], "cue": session["cue"]}


__all__ = ["compose", "plan_summary", "drill_step", "ALL_ACTIVITIES", "level_value"]
