"""
Stage-2 profile builder (v2): a PEER-RELATIVE, uncertainty-aware blindspot
profile over the 5 skill families.

A blindspot is something you get wrong MORE than players at your level, often
enough to cost points, and consistently enough that it isn't noise. So per family:

  incidents   cascades collapsed (one root cause counted once), soft-assigned
              by the classifier's family probabilities, weighted by Maia2
              "personalness" (how avoidable the mistake was at your rating)
  rate        incidents per 100 moves played, recency-weighted by GAME
              (half-life 50 games — robust to play frequency, unlike days)
  peer rate   the same measurement on your opponents in the same games: a
              rating-matched, same-time-control baseline at zero extra engine cost
  posterior   Gamma-Poisson shrinkage of your rate toward the peer rate
              (prior worth 2,000 moves), so 3 mistakes can't top the profile
  status      confirmed / emerging / typical / strength / insufficient_data from
              P(your rate > peer rate)
  impact      expected points lost per 10 games (rate x moves/game x severity)
  excess      the part of that above peer level — what fixing it would recover
  score       0.75 * excess + 0.25 * impact   (ranking key, points per 10 games)

plus the allowed-vs-missed split, tactical hit rate (found / available) vs
peers, and context (ahead/equal/behind, time trouble, phase).

Each tactical family is also emitted as a `BlindspotCluster` (the Stage-2 output
contract; `cluster_id` = family key) with the metrics in `.profile`.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Iterable, Optional

import numpy as np

from ml.clustering.blindspot import BlindspotCluster, _event_summary
from ml.clustering.families import FAMILY_ORDER, UNCLASSIFIED, family_of, family_info

HALF_LIFE_GAMES = 50.0
PRIOR_MOVES = 2000.0           # strength of the shrinkage toward the peer rate
PEER_SMOOTH_MOVES = 1000.0     # smoothing of the (noisy) peer rate itself
HIT_PRIOR = 4.0                # pseudo-opportunities toward the peer hit rate
_SEVERITY_CAP = 1000.0
_RNG_SEED = 7


def _g(obj: Any, key: str, default=None):
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _tags(e) -> list:
    return (_g(e, "description") or {}).get("tags", [])


def _family_probs(e) -> dict[str, float]:
    fp = _g(e, "family_probs") or {}
    if fp:
        return fp
    return {family_of(_g(e, "threat_type") or "other"): 1.0}


def game_weights(exposure: list[dict]) -> dict[str, float]:
    """Recency weight per game: newest = 1, halves every HALF_LIFE_GAMES games."""
    order = sorted(exposure, key=lambda x: -(x.get("played_at_unix") or 0))
    return {x["game_id"]: 0.5 ** (r / HALF_LIFE_GAMES) for r, x in enumerate(order)}


def _incidents(events: Iterable) -> list[dict]:
    """Collapse cascades: one row per incident, carrying the root event's
    labels and the worst expected-score loss of the incident."""
    by: dict[str, list] = defaultdict(list)
    for e in events:
        by[_g(e, "incident_id") or _g(e, "event_id") or str(id(e))].append(e)
    out = []
    for evs in by.values():
        root = next((e for e in evs if not _g(e, "cascade")), evs[0])
        out.append({
            "root": root,
            "game_id": _g(root, "game_id"),
            "es": max(float(_g(e, "es_loss", 0.0) or 0.0) for e in evs),
            "cp": min(_SEVERITY_CAP, max(max(0, _g(e, "eval_drop_cp", 0) or 0) for e in evs)),
            "pw": float(_g(root, "personal_weight", 1.0) or 1.0),
            "fp": _family_probs(root),
            "n_events": len(evs),
        })
    return out


def _rates(incs: list[dict], weights: dict[str, float], exposure_moves: float) -> dict:
    counts: dict[str, float] = defaultdict(float)
    es_w: dict[str, float] = defaultdict(float)
    for inc in incs:
        w = weights.get(inc["game_id"], min(weights.values(), default=0.5)) * inc["pw"]
        for fam, p in inc["fp"].items():
            counts[fam] += w * p
            es_w[fam] += w * p * inc["es"]
    sev = {f: es_w[f] / counts[f] for f in counts if counts[f] > 0}
    per100 = max(exposure_moves / 100.0, 1e-9)
    return {"counts": dict(counts), "sev": sev, "per100": per100,
            "rate": {f: c / per100 for f, c in counts.items()}}


def _posterior(count: float, per100: float, peer_rate: float, rng) -> dict:
    a0 = (PRIOR_MOVES / 100.0) * peer_rate
    b0 = PRIOR_MOVES / 100.0
    a, b = a0 + count, b0 + per100
    samples = rng.gamma(shape=max(a, 1e-6), scale=1.0 / b, size=4000)
    return {"mean": a / b, "lo": float(np.quantile(samples, 0.1)), "hi": float(np.quantile(samples, 0.9)),
            "p_worse": float((samples > peer_rate).mean())}


def _status(n_inc: float, p_worse: float) -> str:
    if n_inc < 3:
        return "insufficient_data"
    if p_worse >= 0.9 and n_inc >= 5:
        return "confirmed"
    if p_worse >= 0.7:
        return "emerging"
    if p_worse <= 0.15:
        return "strength"
    return "typical"


def _hit_rates(opps: list, weights: dict[str, float], side: str) -> tuple[dict, dict, dict]:
    """Recency-weighted found / available tactics per family, plus the mean
    expected score a MISSED one cost."""
    found: dict[str, float] = defaultdict(float)
    total: dict[str, float] = defaultdict(float)
    miss_es: dict[str, list] = defaultdict(list)
    for o in opps:
        if _g(o, "side") != side:
            continue
        w = weights.get(_g(o, "game_id"), 0.5)
        for fam, p in _family_probs(o).items():
            total[fam] += w * p
            if _g(o, "found"):
                found[fam] += w * p
            elif p >= 0.5:
                miss_es[fam].append(float(_g(o, "es_loss", 0.0) or 0.0))
    return dict(found), dict(total), {f: float(np.mean(v)) for f, v in miss_es.items() if v}


HIT_MIN_OPPS = 12.0            # per side, before the hit-rate test can set a status
_SEVERITY_ORDER = ["insufficient_data", "unknown", "strength", "typical", "emerging", "confirmed"]


def _p_lower_hit(uf: float, ut: float, pf: float, pt: float, rng) -> float:
    """P(your hit rate < peers') under independent Beta(1,1) posteriors."""
    u = rng.beta(uf + 1, max(ut - uf, 0) + 1, 4000)
    p = rng.beta(pf + 1, max(pt - pf, 0) + 1, 4000)
    return float((u < p).mean())


def build_profile(
    mistakes: list,
    user_id: str,
    peer_mistakes: Optional[list] = None,
    opportunities: Optional[list] = None,
    exposure: Optional[list[dict]] = None,
) -> dict:
    """Return {families: ranked rows, clusters: BlindspotCluster per tactical
    family, summary}. Without peer/exposure data (e.g. legacy files) it still
    works: rates fall back to per-game counts and status to insufficient_data."""
    rng = np.random.default_rng(_RNG_SEED)
    peer_mistakes = peer_mistakes or []
    opportunities = opportunities or []
    if not exposure:
        gids = sorted({_g(m, "game_id") for m in mistakes})
        exposure = [{"game_id": g, "played_at_unix": 0, "user_moves": 35, "opp_moves": 35} for g in gids]
    weights = game_weights(exposure)
    user_moves = sum(weights.get(x["game_id"], 0) * x.get("user_moves", 0) for x in exposure)
    opp_moves = sum(weights.get(x["game_id"], 0) * x.get("opp_moves", 0) for x in exposure)
    moves_per_game = float(np.mean([x.get("user_moves", 0) for x in exposure])) if exposure else 35.0

    inc_user = _incidents(mistakes)
    inc_peer = _incidents(peer_mistakes)
    U = _rates(inc_user, weights, user_moves)
    P = _rates(inc_peer, weights, opp_moves) if inc_peer else None
    have_peers = P is not None and opp_moves > 0

    # Smoothed peer rate per family (falls back to a share of the user's total).
    total_peer_rate = (sum(P["counts"].values()) / P["per100"]) if have_peers else sum(U["rate"].values())
    all_counts = Counter()
    for src in (U["counts"], (P or {}).get("counts", {})):
        all_counts.update(src)
    share_total = sum(all_counts.values()) or 1.0

    def peer_rate(fam: str) -> float:
        prior = total_peer_rate * all_counts.get(fam, 0.0) / share_total
        if not have_peers:
            return max(prior, 1e-4)
        k = PEER_SMOOTH_MOVES / 100.0
        return max((P["counts"].get(fam, 0.0) + k * prior) / (P["per100"] + k), 1e-4)

    uf, ut, u_miss_es = _hit_rates(opportunities, weights, "user")
    pf, pt, p_miss_es = _hit_rates(opportunities, weights, "opponent")
    weighted_games = sum(weights.get(x["game_id"], 0) for x in exposure) or 1.0

    by_family_inc: dict[str, list[dict]] = defaultdict(list)
    for inc in inc_user:
        by_family_inc[max(inc["fp"], key=inc["fp"].get)].append(inc)

    rows, clusters = [], []
    n_inc_total = len(inc_user)
    for fam in FAMILY_ORDER:
        soft = U["counts"].get(fam, 0.0)
        incs = by_family_inc.get(fam, [])
        if soft < 0.05 and not incs and not (have_peers and P["counts"].get(fam, 0) > 0):
            continue
        info = family_info(fam)
        pr = peer_rate(fam)
        post = _posterior(soft, U["per100"], pr, rng)
        sev = U["sev"].get(fam, (P or {}).get("sev", {}).get(fam, 0.0) if have_peers else 0.0)
        impact = post["mean"] / 100.0 * moves_per_game * 10 * sev
        excess_rate = max(0.0, post["mean"] - pr) / 100.0 * moves_per_game * 10 * sev
        status = _status(soft, post["p_worse"]) if have_peers else "insufficient_data" if soft < 3 else "unknown"
        reasons = ["more mistakes than peers"] if status in ("confirmed", "emerging") else []

        # Second, independent test: do you FIND these tactics less often than
        # peers when they are on the board? (Mistake rates alone miss a player
        # who rarely gets the chance but misses it when it comes.)
        excess_hit, p_lower = 0.0, None
        if fam != UNCLASSIFIED and ut.get(fam, 0) >= HIT_MIN_OPPS and pt.get(fam, 0) >= HIT_MIN_OPPS:
            p_lower = _p_lower_hit(uf.get(fam, 0), ut[fam], pf.get(fam, 0), pt[fam], rng)
            hit_status = "confirmed" if p_lower >= 0.95 else "emerging" if p_lower >= 0.85 else None
            if hit_status:
                reasons.append("finds fewer of these tactics than peers")
                if _SEVERITY_ORDER.index(hit_status) > _SEVERITY_ORDER.index(status):
                    status = hit_status
            peer_hit = pf.get(fam, 0) / pt[fam]
            user_hit = (uf.get(fam, 0) + HIT_PRIOR * peer_hit) / (ut[fam] + HIT_PRIOR)
            per_game = ut[fam] / weighted_games
            miss_cost = u_miss_es.get(fam, p_miss_es.get(fam, 0.2))
            excess_hit = max(0.0, peer_hit - user_hit) * per_game * 10 * miss_cost
        excess = excess_rate + excess_hit
        score = 0.75 * excess + 0.25 * impact

        roots = [i["root"] for i in incs]
        dirs = Counter(_g(r, "direction") or "quiet" for r in roots)
        kinds = Counter(_g(r, "allowed_kind") for r in roots if _g(r, "allowed_kind"))
        threats = Counter(_g(r, "threat_type") for r in roots)
        phases = Counter(_g(r, "game_phase") for r in roots)
        buckets = Counter(_g(r, "eval_bucket") or "equal" for r in roots)
        clocks = [_g(r, "time_remaining_ms") for r in roots if _g(r, "time_remaining_ms") is not None]
        tp_share = (sum(1 for c in clocks if c < 30_000) / len(clocks)) if clocks else None
        tt_share = (sum(1 for r in roots if _g(r, "time_trouble")) / len(roots)) if roots else None
        hit = None
        if ut.get(fam, 0) > 0.5 or pt.get(fam, 0) > 0.5:
            peer_hit = (pf.get(fam, 0) / pt[fam]) if pt.get(fam, 0) > 0 else None
            base = peer_hit if peer_hit is not None else 0.5
            hit = {
                "user": round(uf.get(fam, 0) / ut[fam], 3) if ut.get(fam, 0) > 0 else None,
                "user_shrunk": round((uf.get(fam, 0) + HIT_PRIOR * base) / (ut.get(fam, 0) + HIT_PRIOR), 3),
                "peer": round(peer_hit, 3) if peer_hit is not None else None,
                "opportunities": round(ut.get(fam, 0), 1),
                "p_lower_than_peers": round(p_lower, 3) if p_lower is not None else None,
            }
        recency = float(np.mean([weights.get(i["game_id"], 0.5) for i in incs])) if incs else 0.0
        row = {
            "family": fam,
            "name": info["name"],
            "skill": info["skill"],
            "count": len(incs),
            "frequency": round(len(incs) / max(n_inc_total, 1), 4),
            "recency": round(recency, 3),
            "severity_cp": round(float(np.mean([i["cp"] for i in incs])), 1) if incs else 0.0,
            "score": round(score, 4),
            "threats": dict(threats.most_common()),
            "phases": dict(phases.most_common()),
            "time_pressure_share": round(tp_share, 3) if tp_share is not None else None,
            # ── v2 metrics ───────────────────────────────────────────────────
            "soft_count": round(soft, 2),
            "rate_per_100": round(post["mean"], 3),
            "raw_rate_per_100": round(U["rate"].get(fam, 0.0), 3),
            "rate_ci80": [round(post["lo"], 3), round(post["hi"], 3)],
            "peer_rate_per_100": round(pr, 3) if have_peers else None,
            "relative_rate": round(post["mean"] / pr, 3) if have_peers else None,
            "p_worse_than_peers": round(post["p_worse"], 3) if have_peers else None,
            "status": status,
            "status_reasons": reasons,
            "severity_es": round(sev, 4),
            "impact_pts_per_10": round(impact, 3),
            "excess_pts_per_10": round(excess, 3),
            "excess_from_missed_tactics": round(excess_hit, 3),
            "direction": {k: round(v / len(roots), 3) for k, v in dirs.most_common()} if roots else {},
            "allowed_kind": dict(kinds.most_common()),
            "hit_rate": hit,
            "context": {
                "eval_bucket": {k: round(v / len(roots), 3) for k, v in buckets.most_common()} if roots else {},
                "time_trouble_share": round(tt_share, 3) if tt_share is not None else None,
                "involves_king_share": round(sum("involves_king" in _tags(r) for r in roots) / len(roots), 3) if roots else None,
                "inaccuracy_share": round(sum((_g(r, "judgement") == "inaccuracy") for r in roots) / len(roots), 3) if roots else None,
            },
            "tags": dict(Counter(t for r in roots for t in _tags(r)
                                 if t not in ("opening", "middlegame", "endgame", "ahead", "equal", "behind")).most_common(8)),
            "also_attached": dict(Counter(f["family"] for r in roots for f in (_g(r, "description") or {}).get("families", [])
                                          if f["family"] != fam).most_common()),
        }
        if fam == UNCLASSIFIED:
            row["reasons"] = dict(Counter(_g(r, "unclassified_reason") or "positional" for r in roots).most_common())
        rows.append(row)

        if fam != UNCLASSIFIED and incs:
            worst = sorted(roots, key=lambda r: -(float(_g(r, "es_loss", 0) or 0)))[:5]
            ts = [_g(r, "played_at_unix") for r in roots if _g(r, "played_at_unix")]
            clusters.append(BlindspotCluster(
                cluster_id=fam, user_id=user_id, label=info["name"], size=len(incs),
                centroid=_family_indicator(fam),
                dominant_threat_type=next((t for t, _ in threats.most_common() if family_of(t) == fam), threats.most_common(1)[0][0]),
                dominant_game_phase=phases.most_common(1)[0][0],
                mastery=0.0, last_occurrence_unix=max(ts) if ts else None, next_review_unix=None,
                score=round(score, 4),
                representative_events=[_event_summary(r) for r in worst],
                profile={k: row[k] for k in (
                    "status", "status_reasons", "excess_from_missed_tactics", "rate_per_100", "rate_ci80", "peer_rate_per_100", "relative_rate",
                    "p_worse_than_peers", "impact_pts_per_10", "excess_pts_per_10", "severity_es",
                    "direction", "allowed_kind", "hit_rate", "context", "soft_count", "tags", "also_attached")},
            ))

    rows.sort(key=lambda r: r["score"], reverse=True)
    clusters.sort(key=lambda c: c.score, reverse=True)
    summary = {
        "scoring": "v2",
        "games": len(exposure),
        "user_moves": int(sum(x.get("user_moves", 0) for x in exposure)),
        "n_mistakes": len(mistakes),
        "n_incidents": n_inc_total,
        "cascades_merged": len(mistakes) - n_inc_total,
        "peer_incidents": len(inc_peer),
        "user_es_loss_per_100": round(sum(i["es"] for i in inc_user) * 100.0 /
                                      max(1, sum(x.get("user_moves", 0) for x in exposure)), 3),
        "peer_es_loss_per_100": round(sum(i["es"] for i in inc_peer) * 100.0 /
                                      max(1, sum(x.get("opp_moves", 0) for x in exposure)), 3) if inc_peer else None,
        "user_elo": _mean([x.get("user_elo") for x in exposure]),
        "opp_elo": _mean([x.get("opp_elo") for x in exposure]),
        "tactical_hit_rate": _overall_hit(opportunities, "user"),
        "peer_tactical_hit_rate": _overall_hit(opportunities, "opponent"),
    }
    return {"user_id": user_id, "n_mistakes": len(mistakes), "families": rows,
            "clusters": clusters, "summary": summary}


def _mean(xs) -> Optional[float]:
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(float(np.mean(xs)), 1) if xs else None


def _overall_hit(opps: list, side: str) -> Optional[float]:
    rows = [o for o in opps if _g(o, "side") == side]
    return round(sum(1 for o in rows if _g(o, "found")) / len(rows), 3) if rows else None


def _family_indicator(family_key: str) -> list[float]:
    """A stable per-family one-hot centroid in the 6-family space."""
    vec = [0.0] * len(FAMILY_ORDER)
    vec[FAMILY_ORDER.index(family_key)] = 1.0
    return vec
