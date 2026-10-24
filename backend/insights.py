"""
Dashboard analytics — "how you lose", measured on every analysed game.

GET /api/insights/{username}

Everything here is derived from data Stage 1 already produced, so it costs no
engine time:
  * data/annotation_cache.db  — the Stockfish eval of EVERY position in every
    analysed game (side-to-move POV), so we know the whole game arc;
  * {user}_exposure.json      — per game: plies, result, ratings;
  * {user}_mistakes.json      — the user's mistakes (win-probability based);
  * {user}_peer_mistakes.json — the opponents' mistakes in the SAME games: a
    rating-matched baseline for every chart ("players you faced");
  * {user}_profile.json       — Stage-2 family metrics (peer-relative).

Sections:
  overview       record, score, performance rating, accuracy, mistakes/game (you vs peers)
  progress       mistake probability per move vs % of the game completed (20 bins), you vs peers
  eval_arc       average evaluation (your POV) vs % of the game, overall and split by result
  conversion     winning positions converted / thrown, losing positions saved (you vs peers)
  situations     mistake rate when ahead / equal / behind (per move in that situation)
  radar          skill index per axis, peers = 50 (families + spotting, converting, defending)
  clock          when you blunder on the clock + how fast you play the moves that lose
  pieces         which piece makes your mistakes
  trend          game-by-game accuracy and blunders, with a rolling mean
  colors         white vs black
  severity       how much each mistake costs (expected-score buckets)

Cached in {user}_insights.json, invalidated when the mistakes / exposure files change.
"""
from __future__ import annotations

import math
import statistics
from collections import Counter, defaultdict
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from backend.auth import assert_owner
from backend.storage import read_json, write_json
from ml.config import DATA_DIR

router = APIRouter(prefix="/api/insights")
OUTPUT_DIR = DATA_DIR / "output"
VERSION = 4
BINS = 20
MATE_CP = 30_000
_K = 0.00368208

FAMILY_AXES = [
    ("loose_pieces", "Piece safety"), ("alignment", "Pins & skewers"),
    ("defender_disruption", "Defender tactics"), ("king_safety", "King safety"),
    ("positional", "Positional play"),
]


def _es(cp: Optional[float]) -> float:
    if cp is None:
        return 0.5
    if abs(cp) >= MATE_CP - 1000:
        return 1.0 if cp > 0 else 0.0
    cp = max(-2000.0, min(2000.0, float(cp)))
    return 1.0 / (1.0 + math.exp(-_K * cp))


def _rec_cp(rec: dict) -> Optional[float]:
    if rec is None:
        return None
    if rec.get("mate") is not None:
        return MATE_CP if rec["mate"] > 0 else -MATE_CP
    return rec.get("cp")


def _move_accuracy(wp_before: float, wp_after: float) -> float:
    # Same calibrated per-move curve as Game Review (fitted to Chess.com accuracies).
    from backend.game_review import move_accuracy
    return move_accuracy(max(0.0, wp_before - wp_after))


def _game_accuracy(accs: list[float]) -> Optional[float]:
    from backend.game_review import _aggregate
    return _aggregate(accs, [1.0] * len(accs)) if accs else None


def _bin(progress: float) -> int:
    return max(0, min(BINS - 1, int(progress * BINS)))


def _index(you: float, peer: float, lower_is_better: bool) -> Optional[int]:
    """Skill index where the peer level is 50. Ratio-based and symmetric:
    half the peer mistake rate → ~67, double → ~33."""
    if you is None or peer is None:
        return None
    if lower_is_better:
        if you + peer <= 0:
            return 50
        return int(round(100 * peer / (you + peer)))
    if you + peer <= 0:
        return 50
    return int(round(100 * you / (you + peer)))


def _perf_rating(score: float, avg_opp: float) -> int:
    p = max(0.01, min(0.99, score))
    return int(round(avg_opp - 400 * math.log10((1 - p) / p)))


def compute(username: str) -> dict:
    from ml.ingestion import annotation_cache

    mistakes = read_json(OUTPUT_DIR / f"{username}_mistakes.json", None)
    if mistakes is None:
        raise HTTPException(404, "No analysed games yet. Import your games first.")
    peer_mistakes = read_json(OUTPUT_DIR / f"{username}_peer_mistakes.json", []) or []
    exposure = read_json(OUTPUT_DIR / f"{username}_exposure.json", []) or []
    meta = read_json(OUTPUT_DIR / f"{username}_game_meta.json", {}) or {}
    profile = read_json(OUTPUT_DIR / f"{username}_profile.json", {}) or {}

    user_events = [m for m in mistakes if m.get("side", "user") == "user" and not m.get("cascade")]
    peer_events = [m for m in peer_mistakes if not m.get("cascade")]
    ev_by_game: dict[str, list] = defaultdict(list)
    for m in user_events:
        ev_by_game[m["game_id"]].append(m)
    peer_by_game: dict[str, list] = defaultdict(list)
    for m in peer_events:
        peer_by_game[m["game_id"]].append(m)

    # ── per-game pass over the engine arc ────────────────────────────────────
    prog = [{"you_moves": 0, "peer_moves": 0, "you": Counter(), "peer": Counter()} for _ in range(BINS)]
    arc: list[list[float]] = [[] for _ in range(BINS)]
    arc_wp: list[list[float]] = [[] for _ in range(BINS)]
    arc_by_result = {r: [[] for _ in range(BINS)] for r in ("win", "draw", "loss")}
    situ = {s: {"you_moves": 0, "peer_moves": 0, "you_err": 0, "peer_err": 0} for s in ("ahead", "equal", "behind")}
    conv = {"you": Counter(), "peer": Counter()}
    thrown: list[dict] = []
    stage_acc = {"you": [[], [], []], "peer": [[], [], []]}
    games_out: list[dict] = []
    peer_game_accs: list[float] = []
    colors = {c: {"games": 0, "points": 0.0, "acc": [], "blunders": 0} for c in ("white", "black")}

    for g in exposure:
        gid = g.get("game_id")
        plies = int(g.get("plies") or 0)
        if not gid or plies < 2:
            continue
        m = meta.get(gid, {})
        color = m.get("user_color")
        if color not in ("white", "black"):
            evs = ev_by_game.get(gid) or []
            color = ("white" if " w " in evs[0]["fen"] else "black") if evs else None
        if color is None:
            continue
        user_white = color == "white"
        cached = annotation_cache.get(gid) or {}
        recs = cached.get("recs") or []
        result = g.get("result")
        outcome = None if result is None else "win" if result == 1.0 else "loss" if result == 0.0 else "draw"

        # moves per bin (you / peers)
        for p in range(plies):
            mover_white = p % 2 == 0
            b = _bin((p + 0.5) / plies)
            if mover_white == user_white:
                prog[b]["you_moves"] += 1
            else:
                prog[b]["peer_moves"] += 1

        accs = {"you": [], "peer": []}
        peak_es, low_es, peak_ply = 0.0, 1.0, None
        es_series: list[float] = []
        for p, rec in enumerate(recs[:plies + 1]):
            cp = _rec_cp(rec)
            if cp is None:
                es_series.append(es_series[-1] if es_series else 0.5)
                continue
            stm_white = p % 2 == 0
            user_cp = cp if stm_white == user_white else -cp
            es_u = _es(user_cp)
            es_series.append(es_u)
            prog_x = min(1.0, p / plies)
            b = _bin(prog_x)
            arc[b].append(max(-8.0, min(8.0, user_cp / 100.0)))
            arc_wp[b].append(es_u)
            if outcome:
                arc_by_result[outcome][b].append(es_u)
            if p >= plies * 0.15 or p >= 16:          # ignore the opening shuffle for peaks
                if es_u > peak_es:
                    peak_es, peak_ply = es_u, p
                low_es = min(low_es, es_u)
            # per-move accuracy + situation exposure (move p is made from position p)
            if p + 1 < len(recs) and p < plies:
                nxt = _rec_cp(recs[p + 1])
                if nxt is not None:
                    mover_is_user = stm_white == user_white
                    wb = 100 * _es(cp)
                    wa = 100 * _es(-nxt)
                    who = "you" if mover_is_user else "peer"
                    acc = _move_accuracy(wb, wa)
                    accs[who].append(acc)
                    stage_acc[who][min(2, int(3 * p / plies))].append(acc)
                    es_m = _es(cp)
                    s = "ahead" if es_m >= 0.65 else "behind" if es_m <= 0.35 else "equal"
                    situ[s][f"{who}_moves"] += 1

        # conversion: did you hold the winning positions you reached?
        if es_series and outcome:
            if peak_es >= 0.85:
                conv["you"]["winning"] += 1
                conv["you"][f"winning_{outcome}"] += 1
                if outcome != "win":
                    thrown.append({"game_id": gid, "url": m.get("url"), "opponent": m.get("opponent"),
                                   "peak": round(peak_es, 3), "peak_move": (peak_ply or 0) // 2 + 1,
                                   "outcome": outcome, "played_at": g.get("played_at_unix")})
            if low_es <= 0.15:
                conv["you"]["losing"] += 1
                conv["you"][f"losing_{outcome}"] += 1
            # the same games from the opponent's side
            opp_outcome = {"win": "loss", "loss": "win", "draw": "draw"}[outcome]
            if 1 - low_es >= 0.85:
                conv["peer"]["winning"] += 1
                conv["peer"][f"winning_{opp_outcome}"] += 1
            if 1 - peak_es <= 0.15:
                conv["peer"]["losing"] += 1
                conv["peer"][f"losing_{opp_outcome}"] += 1

        # mistakes into the bins
        n_blunders = 0
        for e in ev_by_game.get(gid, []):
            ply = e.get("ply")
            if not isinstance(ply, int):
                continue
            j = e.get("judgement") or "mistake"
            prog[_bin((ply + 0.5) / plies)]["you"][j] += 1
            if j in ("mistake", "blunder"):
                situ[e.get("eval_bucket") or "equal"]["you_err"] += 1
            n_blunders += j == "blunder"
        for e in peer_by_game.get(gid, []):
            ply = e.get("ply")
            if not isinstance(ply, int):
                continue
            j = e.get("judgement") or "mistake"
            prog[_bin((ply + 0.5) / plies)]["peer"][j] += 1
            if j in ("mistake", "blunder"):
                situ[e.get("eval_bucket") or "equal"]["peer_err"] += 1

        acc_you = _game_accuracy(accs["you"])
        acc_peer = _game_accuracy(accs["peer"])
        if acc_peer is not None:
            peer_game_accs.append(acc_peer)
        games_out.append({"game_id": gid, "played_at": g.get("played_at_unix"), "accuracy": acc_you,
                          "rating": g.get("user_elo"),
                          "blunders": n_blunders, "outcome": outcome, "color": color,
                          "mistakes": sum(1 for e in ev_by_game.get(gid, []) if e.get("judgement") == "mistake")})
        c = colors[color]
        c["games"] += 1
        c["points"] += result or 0.0
        if acc_you is not None:
            c["acc"].append(acc_you)
        c["blunders"] += n_blunders

    n_games = len(games_out)
    if not n_games:
        raise HTTPException(404, "Not enough analysed games for insights yet.")

    # ── assemble ─────────────────────────────────────────────────────────────
    def per_move(cnt: Counter, moves: int, keys=("mistake", "blunder")) -> float:
        return round(sum(cnt[k] for k in keys) / moves, 4) if moves else 0.0

    progress = []
    for i, p in enumerate(prog):
        progress.append({
            "x": round((i + 0.5) * 100 / BINS, 1), "label": f"{i * 100 // BINS}–{(i + 1) * 100 // BINS}%",
            "you_moves": p["you_moves"], "peer_moves": p["peer_moves"],
            "you_inaccuracies": p["you"]["inaccuracy"], "you_mistakes": p["you"]["mistake"], "you_blunders": p["you"]["blunder"],
            "you_p": per_move(p["you"], p["you_moves"]), "peer_p": per_move(p["peer"], p["peer_moves"]),
            "you_p_blunder": per_move(p["you"], p["you_moves"], ("blunder",)),
            "peer_p_blunder": per_move(p["peer"], p["peer_moves"], ("blunder",)),
        })

    def q(xs: list[float], f: float) -> Optional[float]:
        if not xs:
            return None
        xs = sorted(xs)
        k = (len(xs) - 1) * f
        lo, hi = math.floor(k), math.ceil(k)
        return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 3)

    eval_arc = []
    for i in range(BINS):
        eval_arc.append({
            "x": round((i + 0.5) * 100 / BINS, 1),
            "avg": round(statistics.fmean(arc[i]), 3) if arc[i] else None,
            "p25": q(arc[i], .25), "p75": q(arc[i], .75),
            "wp": round(100 * statistics.fmean(arc_wp[i]), 1) if arc_wp[i] else None,
            **{f"wp_{r}": round(100 * statistics.fmean(v[i]), 1) if v[i] else None for r, v in arc_by_result.items()},
        })

    # overview
    results = [g for g in exposure if g.get("result") is not None]
    wins = sum(1 for g in results if g["result"] == 1.0)
    losses = sum(1 for g in results if g["result"] == 0.0)
    draws = len(results) - wins - losses
    score = (wins + 0.5 * draws) / len(results) if results else None
    opp = [g.get("opp_elo") for g in exposure if g.get("opp_elo")]
    avg_opp = statistics.fmean(opp) if opp else None
    you_moves = sum(p["you_moves"] for p in prog)
    peer_moves = sum(p["peer_moves"] for p in prog)
    you_counts = Counter(e.get("judgement") for e in user_events)
    peer_counts = Counter(e.get("judgement") for e in peer_events)
    accs_all = [g["accuracy"] for g in games_out if g["accuracy"] is not None]
    ratings = [g.get("user_elo") for g in sorted(exposure, key=lambda g: g.get("played_at_unix") or 0) if g.get("user_elo")]
    overview = {
        "games": n_games, "wins": wins, "draws": draws, "losses": losses,
        "score": round(score, 3) if score is not None else None,
        "avg_opp_elo": round(avg_opp) if avg_opp else None,
        "performance": _perf_rating(score, avg_opp) if score is not None and avg_opp else None,
        "rating_start": ratings[0] if ratings else None, "rating_end": ratings[-1] if ratings else None,
        "accuracy": round(statistics.fmean(accs_all), 1) if accs_all else None,
        "peer_accuracy": None,
        "avg_plies": round(statistics.fmean([g["plies"] for g in exposure if g.get("plies")])),
        "you": {k: you_counts.get(k, 0) for k in ("inaccuracy", "mistake", "blunder")},
        "peer": {k: peer_counts.get(k, 0) for k in ("inaccuracy", "mistake", "blunder")},
        "you_per_game": {k: round(you_counts.get(k, 0) / n_games, 2) for k in ("inaccuracy", "mistake", "blunder")},
        "peer_per_game": {k: round(peer_counts.get(k, 0) / n_games, 2) for k in ("inaccuracy", "mistake", "blunder")},
        "you_moves": you_moves, "peer_moves": peer_moves,
    }
    if peer_game_accs:
        overview["peer_accuracy"] = round(statistics.fmean(peer_game_accs), 1)

    stages = [{"stage": name, "you": _game_accuracy(stage_acc["you"][i]), "peer": _game_accuracy(stage_acc["peer"][i])}
              for i, name in enumerate(("Early (first third)", "Middle third", "Late (final third)"))]

    def rate(c: Counter, key: str, base: str) -> Optional[float]:
        return round(c[key] / c[base], 3) if c[base] else None

    conversion = {
        "you": {"winning_games": conv["you"]["winning"], "converted": conv["you"]["winning_win"],
                "drawn": conv["you"]["winning_draw"], "lost": conv["you"]["winning_loss"],
                "conversion_rate": rate(conv["you"], "winning_win", "winning"),
                "losing_games": conv["you"]["losing"], "saved": conv["you"]["losing_draw"] + conv["you"]["losing_win"],
                "comebacks": conv["you"]["losing_win"],
                "save_rate": round((conv["you"]["losing_draw"] + conv["you"]["losing_win"]) / conv["you"]["losing"], 3) if conv["you"]["losing"] else None},
        "peer": {"winning_games": conv["peer"]["winning"], "conversion_rate": rate(conv["peer"], "winning_win", "winning"),
                 "losing_games": conv["peer"]["losing"],
                 "save_rate": round((conv["peer"]["losing_draw"] + conv["peer"]["losing_win"]) / conv["peer"]["losing"], 3) if conv["peer"]["losing"] else None},
        "thrown": sorted(thrown, key=lambda t: -t["peak"])[:6],
    }

    situations = []
    for s in ("ahead", "equal", "behind"):
        d = situ[s]
        situations.append({"situation": s, "you_moves": d["you_moves"], "peer_moves": d["peer_moves"],
                           "you_rate": round(d["you_err"] / d["you_moves"], 4) if d["you_moves"] else None,
                           "peer_rate": round(d["peer_err"] / d["peer_moves"], 4) if d["peer_moves"] else None})

    # radar
    fams = {f.get("family"): f for f in profile.get("families", [])}
    radar = []
    for key, label in FAMILY_AXES:
        f = fams.get(key) or {}
        you, peer = f.get("rate_per_100"), f.get("peer_rate_per_100")
        radar.append({"axis": label, "key": key, "you": _index(you, peer, True) if you is not None and peer is not None else None,
                      "detail": {"you_per_100": you, "peer_per_100": peer, "status": f.get("status")}})
    hits_u = [f["hit_rate"]["user"] for f in fams.values() if (f.get("hit_rate") or {}).get("user") is not None]
    hits_p = [f["hit_rate"]["peer"] for f in fams.values() if (f.get("hit_rate") or {}).get("peer") is not None]
    if hits_u and hits_p:
        radar.append({"axis": "Spotting tactics", "key": "spotting",
                      "you": _index(statistics.fmean(hits_u), statistics.fmean(hits_p), False),
                      "detail": {"you": round(statistics.fmean(hits_u), 3), "peer": round(statistics.fmean(hits_p), 3)}})
    cy, cpeer = conversion["you"]["conversion_rate"], conversion["peer"]["conversion_rate"]
    if cy is not None and cpeer is not None:
        radar.append({"axis": "Converting wins", "key": "converting", "you": _index(cy, cpeer, False),
                      "detail": {"you": cy, "peer": cpeer}})
    sy, speer = conversion["you"]["save_rate"], conversion["peer"]["save_rate"]
    if sy is not None and speer is not None:
        radar.append({"axis": "Defending", "key": "defending", "you": _index(sy, speer, False),
                      "detail": {"you": sy, "peer": speer}})

    # clock + speed
    clocks = [e.get("time_remaining_ms") for e in user_events if e.get("judgement") in ("mistake", "blunder")
              and e.get("time_remaining_ms") is not None]
    think = [e.get("think_time_ms") for e in user_events if e.get("judgement") == "blunder" and e.get("think_time_ms") is not None]
    clock = {
        "has_data": bool(clocks),
        "buckets": [{"label": lbl, "count": sum(1 for c in clocks if lo <= c < hi)}
                    for lbl, lo, hi in (("< 30s", 0, 30_000), ("30s–1m", 30_000, 60_000), ("1–2m", 60_000, 120_000),
                                        ("2–5m", 120_000, 300_000), ("> 5m", 300_000, 10 ** 12))],
        "think_buckets": [{"label": lbl, "count": sum(1 for t in think if lo <= t < hi)}
                          for lbl, lo, hi in (("< 5s", 0, 5_000), ("5–15s", 5_000, 15_000), ("15–45s", 15_000, 45_000),
                                              ("> 45s", 45_000, 10 ** 12))],
        "fast_blunder_share": round(sum(1 for t in think if t < 5_000) / len(think), 3) if think else None,
        "median_blunder_think_s": round(statistics.median(think) / 1000, 1) if think else None,
        "time_trouble_share": round(sum(1 for e in user_events if e.get("time_trouble")) / len(user_events), 3) if user_events else None,
    }

    # pieces
    piece_names = {"N": "Knight", "B": "Bishop", "R": "Rook", "Q": "Queen", "K": "King", "O": "King"}
    pc = Counter()
    for e in user_events:
        if e.get("judgement") not in ("mistake", "blunder"):
            continue
        san = e.get("move_played_san") or ""
        pc[piece_names.get(san[:1], "Pawn")] += 1
    total_pc = sum(pc.values()) or 1
    pieces = [{"piece": k, "count": v, "share": round(v / total_pc, 3)} for k, v in pc.most_common()]

    # trend
    games_out.sort(key=lambda g: g["played_at"] or 0)
    trend, window = [], 10
    for i, g in enumerate(games_out):
        recent = [x for x in games_out[max(0, i - window + 1): i + 1]]
        acc_vals = [x["accuracy"] for x in recent if x["accuracy"] is not None]
        trend.append({"i": i + 1, "played_at": g["played_at"], "accuracy": g["accuracy"], "blunders": g["blunders"],
                      "rating": g.get("rating"),
                      "outcome": g["outcome"],
                      "acc_avg": round(statistics.fmean(acc_vals), 1) if acc_vals else None,
                      "blunders_avg": round(statistics.fmean(x["blunders"] for x in recent), 2)})

    colors_out = [{"color": c, "games": v["games"],
                   "score": round(v["points"] / v["games"], 3) if v["games"] else None,
                   "accuracy": round(statistics.fmean(v["acc"]), 1) if v["acc"] else None,
                   "blunders_per_game": round(v["blunders"] / v["games"], 2) if v["games"] else None}
                  for c, v in colors.items()]

    sev = [e.get("es_loss") or 0 for e in user_events]
    severity = [{"label": lbl, "count": sum(1 for s in sev if lo <= s < hi)}
                for lbl, lo, hi in (("5–10%", .05, .10), ("10–15%", .10, .15), ("15–25%", .15, .25),
                                    ("25–40%", .25, .40), ("40%+", .40, 2.0))]

    # headline findings, phrased for the player
    findings = _findings(progress, situations, conversion, clock, pieces, stages, overview)

    return {"version": VERSION, "username": username, "overview": overview, "progress": progress,
            "eval_arc": eval_arc, "conversion": conversion, "situations": situations, "radar": radar,
            "clock": clock, "pieces": pieces, "trend": trend, "colors": colors_out, "severity": severity,
            "stages": stages, "findings": findings}


def _findings(progress, situations, conversion, clock, pieces, stages, overview) -> list[dict]:
    out: list[dict] = []
    # where in the game the danger peaks, relative to peers
    rows = [p for p in progress if p["you_moves"] >= 30]
    if rows:
        worst = max(rows, key=lambda p: p["you_p"] - p["peer_p"])
        if worst["you_p"] > worst["peer_p"] * 1.15 and worst["you_p"] > 0:
            out.append({"tone": "danger", "title": f"Your danger zone: {worst['label']} of the game",
                        "body": f"{worst['you_p'] * 100:.1f}% of your moves there are mistakes or blunders, "
                                f"vs {worst['peer_p'] * 100:.1f}% for the players you faced."})
    ahead = next((s for s in situations if s["situation"] == "ahead"), None)
    if ahead and ahead["you_rate"] and ahead["peer_rate"] and ahead["you_rate"] > ahead["peer_rate"] * 1.1:
        out.append({"tone": "warn", "title": "You relax when you're winning",
                    "body": f"When ahead you err on {ahead['you_rate'] * 100:.1f}% of moves "
                            f"(peers {ahead['peer_rate'] * 100:.1f}%)."})
    cv = conversion["you"]
    if cv["winning_games"] and cv["conversion_rate"] is not None:
        lost = cv["drawn"] + cv["lost"]
        out.append({"tone": "warn" if (conversion["peer"]["conversion_rate"] or 0) > cv["conversion_rate"] else "good",
                    "title": f"{lost} winning position{'s' if lost != 1 else ''} slipped away",
                    "body": f"You reached a winning position (≥85% expected score) in {cv['winning_games']} games "
                            f"and converted {cv['conversion_rate'] * 100:.0f}% "
                            f"(peers {((conversion['peer']['conversion_rate'] or 0) * 100):.0f}%)."})
    if clock.get("fast_blunder_share") is not None and clock["fast_blunder_share"] >= 0.3:
        out.append({"tone": "warn", "title": f"{clock['fast_blunder_share'] * 100:.0f}% of your blunders took under 5 seconds",
                    "body": "Most of them weren't time trouble: they were moves played on autopilot. A 3-second blunder check catches these."})
    if pieces and pieces[0]["share"] >= 0.3 and pieces[0]["piece"] != "Pawn":
        out.append({"tone": "info", "title": f"Your {pieces[0]['piece'].lower()} makes {pieces[0]['share'] * 100:.0f}% of your mistakes",
                    "body": "Before moving it, ask what it was guarding and what it can be attacked by."})
    late = stages[2]
    if late["you"] is not None and late["peer"] is not None and late["you"] < late["peer"] - 1.5:
        out.append({"tone": "warn", "title": "Your accuracy drops late in the game",
                    "body": f"Final third: {late['you']}% vs {late['peer']}% for your opponents."})
    return out[:6]


@router.get("/{username}")
def insights(username: str, request: Request, refresh: bool = False):
    assert_owner(request, username)
    paths = [OUTPUT_DIR / f"{username}_{n}.json" for n in ("mistakes", "exposure", "peer_mistakes", "profile")]
    sig = "|".join(str(int(p.stat().st_mtime)) if p.exists() else "0" for p in paths) + f"|v{VERSION}"
    cache_path = OUTPUT_DIR / f"{username}_insights.json"
    cached = read_json(cache_path, None)
    if cached and not refresh and cached.get("_sig") == sig:
        return {k: v for k, v in cached.items() if k != "_sig"}
    data = compute(username)
    write_json(cache_path, {**data, "_sig": sig})
    return data
