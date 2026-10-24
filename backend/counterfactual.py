"""
Counterfactual rating — "what fixing each blindspot is worth".

Model (v2, honest and bounded):
  * Games: the analysed (rapid) games themselves. Their result and opponent
    rating come from {user}_exposure.json, written by Stage 1 — no re-fetching,
    and no mixing in blitz / bullet results.
  * Current rating: the player's live rating from the platform (rapid by
    default — backend/ratings.py); falls back to the rating in the most recent
    analysed game.
  * Turning point: in every game you didn't win, the decisive mistake is your
    single largest expected-score loss (Stage-1 win-probability model) made
    from a position that wasn't already lost (expected score ≥ 0.35).
  * Fixing a family: if that turning point belongs to the family (its Stage-2
    cluster_id), the game is re-scored at the expected score you had BEFORE the
    mistake — not flipped to a win. A +0.4 position you blundered is worth
    ~0.6 points, a dead-equal one ~0.5.
  * Rating: performance rating over those games (avg opponent rating and score
    rate), before vs after; the difference is added to the current rating and
    capped at +400.

Cached in {user}_counterfactual.json, keyed on the mistakes/exposure files and
the current rating.
"""
from __future__ import annotations

import asyncio
import logging
import math
from typing import Optional

from fastapi import APIRouter, HTTPException

from backend.storage import read_json, write_json
from ml.config import DATA_DIR

log = logging.getLogger("forked.counterfactual")
router = APIRouter(prefix="/api/profile")

OUTPUT_DIR = DATA_DIR / "output"
MODEL = "turning-point-v2"
NOT_LOST_ES = 0.35
MIN_TURNING_LOSS = 0.10
MAX_GAIN = 400


def _perf_rating(score_rate: float, avg_opp: float) -> float:
    p = max(0.01, min(0.99, score_rate))
    return avg_opp - 400.0 * math.log10((1.0 - p) / p)


def current_rating(username: str, exposure: list[dict]) -> tuple[Optional[int], str]:
    live = read_json(OUTPUT_DIR / f"{username}_ratings.json", None) or {}
    if live.get("primary_rating"):
        return int(live["primary_rating"]), f"{live.get('platform', '')} {live.get('primary', 'rapid')}".strip()
    recent = sorted((g for g in exposure if g.get("user_elo")), key=lambda g: g.get("played_at_unix") or 0)
    if recent:
        return int(recent[-1]["user_elo"]), "latest analysed game"
    s = read_json(OUTPUT_DIR / f"{username}_settings.json", {}) or {}
    return (int(s["elo"]) if s.get("elo") else None), "settings"


def _compute(username: str) -> dict:
    clusters = read_json(OUTPUT_DIR / f"{username}_clusters.json", None)
    if not clusters:
        raise HTTPException(404, "No blindspot profile found. Run analysis first.")
    mistakes = read_json(OUTPUT_DIR / f"{username}_mistakes.json", []) or []
    exposure = read_json(OUTPUT_DIR / f"{username}_exposure.json", []) or []
    rating, rating_source = current_rating(username, exposure)

    paths = [OUTPUT_DIR / f"{username}_{n}.json" for n in ("mistakes", "exposure", "clusters")]
    sig = "|".join(str(int(p.stat().st_mtime)) if p.exists() else "0" for p in paths) + f"|{rating}|{MODEL}"
    cache_path = OUTPUT_DIR / f"{username}_counterfactual.json"
    cached = read_json(cache_path, None)
    if cached and cached.get("_sig") == sig:
        return {k: v for k, v in cached.items() if k != "_sig"}

    scored = {g["game_id"]: g for g in exposure if g.get("game_id") and g.get("result") is not None}
    order = [str(c.get("cluster_id")) for c in clusters]
    labels = {str(c.get("cluster_id")): c.get("label") for c in clusters}
    base = {"username": username, "model": MODEL, "actual_rating": rating, "rating_source": rating_source,
            "n_games": len(scored)}

    if len(scored) < 10 or rating is None:
        result = {**base, "has_result_data": False, "total_gain": 0, "potential_rating": rating,
                  "games_recovered": 0, "points_recovered": 0, "per_cluster": [], "ladder": [], "examples": []}
        write_json(cache_path, {**result, "_sig": sig})
        return result

    # turning point per game
    by_game: dict[str, list[dict]] = {}
    for m in mistakes:
        if m.get("side", "user") != "user" or m.get("cascade"):
            continue
        by_game.setdefault(m["game_id"], []).append(m)
    turning: dict[str, dict] = {}
    for gid, g in scored.items():
        if g["result"] >= 1.0:
            continue
        cands = [m for m in by_game.get(gid, [])
                 if (m.get("es_before") or 0) >= NOT_LOST_ES and (m.get("es_loss") or 0) >= MIN_TURNING_LOSS]
        if not cands:
            continue
        d = max(cands, key=lambda m: m.get("es_loss") or 0)
        family = str(d.get("cluster_id") or "unclassified")
        recover = max(0.0, min(1.0, float(d.get("es_before") or 0)) - g["result"])
        if recover > 0:
            turning[gid] = {"family": family, "recover": recover, "event": d}

    n = len(scored)
    avg_opp = sum(float(g.get("opp_elo") or 1500) for g in scored.values()) / n
    actual_pts = sum(g["result"] for g in scored.values())
    r_actual = _perf_rating(actual_pts / n, avg_opp)

    def gain_for(families: Optional[set[str]]) -> tuple[int, int, float]:
        extra, games = 0.0, 0
        for t in turning.values():
            if families is None or t["family"] in families:
                extra += t["recover"]
                games += 1
        if not games:
            return 0, 0, 0.0
        g = _perf_rating(min(0.99, (actual_pts + extra) / n), avg_opp) - r_actual
        return int(round(max(0.0, min(MAX_GAIN, g)))), games, round(extra, 2)

    per_cluster = []
    for i, cid in enumerate(order):
        g, games, pts = gain_for({cid})
        per_cluster.append({"cluster_id": cid, "label": labels.get(cid), "cluster_rank": i + 1, "gain": g,
                            "games_recovered": games, "points_recovered": pts})
    # turning points outside every listed family (e.g. unclassified) still count in "fix all"
    total_gain, total_games, total_pts = gain_for(None)

    ranked = sorted(per_cluster, key=lambda c: -c["gain"])
    ladder, seen, running = [], set(), 0
    for c in ranked:
        seen.add(c["cluster_id"])
        g, _, _ = gain_for(seen)
        ladder.append({"cluster_id": c["cluster_id"], "label": c["label"], "cluster_rank": c["cluster_rank"],
                       "step_gain": g - running, "cumulative": g, "rating_after": rating + g})
        running = g
    if total_gain > running:
        # turning points the classifier left outside every family
        ladder.append({"cluster_id": "unclassified", "label": "Other mistakes (no clear motif)", "cluster_rank": None,
                       "step_gain": total_gain - running, "cumulative": total_gain, "rating_after": rating + total_gain})

    examples = []
    for gid, t in sorted(turning.items(), key=lambda kv: -kv[1]["recover"])[:5]:
        e = t["event"]
        examples.append({"game_id": gid, "family": t["family"], "move_number": e.get("move_number"),
                         "played": e.get("move_played_san"), "best_uci": e.get("best_move_uci"), "fen": e.get("fen"),
                         "es_before": e.get("es_before"), "es_after": e.get("es_after"),
                         "result": scored[gid]["result"], "recover": round(t["recover"], 2)})

    result = {**base, "has_result_data": True, "total_gain": total_gain, "potential_rating": rating + total_gain,
              "games_recovered": total_games, "points_recovered": total_pts,
              "score_rate": round(actual_pts / n, 3), "avg_opp_rating": round(avg_opp),
              "performance_rating": round(r_actual), "per_cluster": per_cluster, "ladder": ladder,
              "examples": examples}
    write_json(cache_path, {**result, "_sig": sig})
    return result


@router.get("/{username}/counterfactual")
async def counterfactual(username: str):
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _compute(username))
