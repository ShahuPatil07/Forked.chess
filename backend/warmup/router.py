"""Warm-Up API (prefix /api/warmup).

  GET  /profile             band (+ rating source), tilt, own-game facts, routine, consent, history, baselines
  POST /moment              "I'm about to play": creates the experiment unit; arm = warmup | control
                            (random only for users who opted in; everyone else always warms up)
  POST /moment/{id}/play    the player went to play (anchor for outcome linking)
  POST /session             compose a warm-up (pre-generated items, 3 difficulty levels per drill)
  POST /items               more items for one drill at one level
  POST /events              batch-log drill items
  POST /session/{id}/finish summary vs the player's own baseline; marks the moment as played
  GET|PUT /routine          the player's saved routine
  POST /consent             opt in / out of the randomized comparison
  POST /link                link finished moments to the next game(s) (background)
  GET  /stats               the player's drill trends + linked games (coach tool too)
  GET  /lab                 internal dashboard: warm-up vs control blunder rates by band / time control / drill

No paid API calls anywhere: drills are generated on the board (python-chess) or come from the
offline Stockfish bank; outcomes use local Stockfish.
"""
from __future__ import annotations

import json
import random
import re
import secrets
import statistics
import time
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import composer, games as G, outcomes, signals, store
from .config import TIME_CONTROLS, band_by_id, cfg, drill_cfg
from .drills import GENERATORS
from .drills.two_candidates import available as candidates_available

router = APIRouter(prefix="/api/warmup", tags=["warmup"])
TC = Literal["bullet", "blitz", "rapid", "classical"]
Platform = Literal["chesscom", "lichess"]


def _user(username: str) -> str:
    u = (username or "").strip() or "Guest"
    if not re.fullmatch(r"[A-Za-z0-9_\-]{1,40}", u):
        raise HTTPException(400, "invalid username")
    return u


def _consented(username: str) -> bool:
    row = store.one("SELECT granted FROM consents WHERE username = ?", (username,))
    return bool(row and row["granted"])


def _routine(username: str) -> list[str] | None:
    row = store.one("SELECT steps FROM routines WHERE username = ?", (username,))
    return json.loads(row["steps"]) if row else None


def _median(xs: list[float]) -> float | None:
    return round(statistics.median(xs), 1) if xs else None


def baselines(username: str, exclude_session: str | None = None) -> dict[str, dict]:
    rows = store.query("SELECT drill_id, correct, score, response_ms FROM events WHERE username = ? "
                       "AND (? IS NULL OR session_id != ?) ORDER BY ts DESC LIMIT 3000",
                       (username, exclude_session, exclude_session))
    out: dict[str, dict] = {}
    for d in {r["drill_id"] for r in rows}:
        rs = [r for r in rows if r["drill_id"] == d]
        out[d] = {"items": len(rs), "accuracy": round(sum(r["correct"] or 0 for r in rs) / len(rs), 3),
                  "median_ms": _median([r["response_ms"] for r in rs if r["response_ms"]])}
    return out


def history(username: str, limit: int = 8) -> list[dict]:
    moments = store.query("SELECT * FROM moments WHERE username = ? ORDER BY created_at DESC LIMIT ?", (username, limit))
    for m in moments:
        m["outcomes"] = store.query("SELECT game_id, url, result, accuracy, blunders, moves, blunders_per40, time_class "
                                    "FROM outcomes WHERE moment_id = ?", (m["id"],))
        s = store.one("SELECT summary FROM sessions WHERE id = ?", (m["session_id"],)) if m.get("session_id") else None
        m["summary"] = json.loads(s["summary"]) if s and s.get("summary") else None
    return moments


# ── profile ─────────────────────────────────────────────────────────────────

@router.get("/profile")
def profile(username: str = "", platform: Platform = "chesscom", time_control: TC = "blitz",
            elo: int | None = None, rating: int | None = None):
    u = _user(username)
    band, rinfo, recent = G.band_info(u, platform, time_control, elo, rating)
    tilt = G.tilt(recent, band) if recent else {"streak": 0, "triggered": False, "threshold": band["tilt_losses"],
                                                "break_until": None, "last_result": None}
    if u != "Guest" and recent:
        outcomes.link_async(u, platform)
    f = signals.facts(u)
    return {
        "username": u, "band": {k: band[k] for k in ("id", "label", "multiplier", "tilt_losses", "emphasis", "thinking")},
        "rating": rinfo, "ratings": {tc: G.rating_for(recent, tc) for tc in TIME_CONTROLS},
        "tilt": tilt, "facts": f, "routine": _routine(u), "consent": _consented(u),
        "history": history(u), "baselines": baselines(u), "bank_ready": candidates_available(),
        "activities": {a: {"title": drill_cfg(a)["title"], "kind": drill_cfg(a)["kind"], "est_s": drill_cfg(a)["est_s"]}
                       for a in composer.ALL_ACTIVITIES},
        "honesty": cfg()["copy"]["honesty"], "tilt_copy": cfg()["copy"]["tilt"],
    }


# ── moments (experiment unit) ───────────────────────────────────────────────

class MomentIn(BaseModel):
    username: str = ""
    platform: Platform = "chesscom"
    time_control: TC = "blitz"
    elo: int | None = None
    rating: int | None = None


@router.post("/moment")
def moment(body: MomentIn):
    u = _user(body.username)
    band, rinfo, _ = G.band_info(u, body.platform, body.time_control, body.elo, body.rating)
    in_exp = u != "Guest" and _consented(u)
    arm = "warmup"
    if in_exp:
        arm = "warmup" if secrets.SystemRandom().random() < cfg()["experiment"]["warmup_probability"] else "control"
    mid = store.new_id()
    store.write("INSERT INTO moments (id, username, platform, created_at, time_control, band, rating, arm, in_experiment) "
                "VALUES (?,?,?,?,?,?,?,?,?)", (mid, u, body.platform, store.now(), body.time_control, band["id"],
                                               rinfo["rating"], arm, int(in_exp)))
    return {"moment_id": mid, "arm": arm, "in_experiment": in_exp,
            "play_url": composer.play_url(body.platform, body.time_control)}


@router.post("/moment/{moment_id}/play")
def moment_play(moment_id: str):
    store.write("UPDATE moments SET play_at = COALESCE(play_at, ?) WHERE id = ?", (store.now(), moment_id))
    return {"ok": True}


# ── sessions ────────────────────────────────────────────────────────────────

class SessionIn(MomentIn):
    minutes: Literal[3, 5, 10] = 5
    use_routine: bool = False
    moment_id: str | None = None
    seen: list[str] = Field(default_factory=list)
    activities: list[str] | None = None        # explicit list (drill library "Try" / custom run)


@router.post("/session")
def session(body: SessionIn):
    u = _user(body.username)
    routine = body.activities or (_routine(u) if body.use_routine else None)
    plan = composer.compose(username=u, platform=body.platform, time_control=body.time_control, minutes=body.minutes,
                            fallback_rating=body.elo, manual_rating=body.rating, routine=routine,
                            seed=secrets.randbits(32), seen=set(body.seen[-400:]))
    sid = store.new_id()
    slim = [{"activity": s["activity"], "level": s.get("level"), "count": s.get("count")} for s in plan["steps"]]
    store.write("INSERT INTO sessions (id, username, moment_id, started_at, band, rating, rating_source, time_control, "
                "minutes, plan) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (sid, u, body.moment_id, store.now(), plan["band"]["id"], plan["rating"]["rating"],
                 plan["rating"]["source"], body.time_control, body.minutes, store.dumps(slim)))
    if body.moment_id:
        store.write("UPDATE moments SET session_id = ? WHERE id = ?", (sid, body.moment_id))
    return {"id": sid, **plan}


class ItemsIn(BaseModel):
    username: str = ""
    drill: str
    level: int = 3
    n: int = 6
    time_control: TC = "blitz"
    band: str = "1200-1600"
    rating: int | None = None
    seen: list[str] = Field(default_factory=list)


@router.post("/items")
def items(body: ItemsIn):
    if body.drill not in GENERATORS:
        raise HTTPException(404, "unknown drill")
    band = band_by_id(body.band)
    rng = random.Random(secrets.randbits(32))
    ctx = {"username": _user(body.username), "rating": body.rating or band["min"] + 200, "band": band,
           "seen": set(body.seen[-400:])}
    step = composer.drill_step(body.drill, band, body.time_control, max(1, min(20, body.n)), ctx, rng, body.level)
    return {"items": (step or {}).get("pools", {}).get(str(max(1, min(5, body.level))), [])}


class EventIn(BaseModel):
    drill_id: str
    item_id: str = ""
    correct: bool
    score: float | None = None
    response_ms: int | None = None
    difficulty: int | None = None
    extra: dict = Field(default_factory=dict)


class EventsIn(BaseModel):
    session_id: str | None = None
    username: str = ""
    band: str = ""
    time_control: str = ""
    events: list[EventIn]


@router.post("/events")
def events(body: EventsIn):
    u = _user(body.username)
    ts = store.now()
    store.write_many("INSERT INTO events (session_id, username, drill_id, item_id, band, time_control, correct, score, "
                     "response_ms, difficulty, ts, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     [(body.session_id, u, e.drill_id, e.item_id, body.band, body.time_control, int(e.correct),
                       e.score, e.response_ms, e.difficulty, ts, store.dumps(e.extra)) for e in body.events[:500]])
    return {"logged": len(body.events[:500])}


@router.post("/session/{session_id}/finish")
def finish(session_id: str, username: str = ""):
    u = _user(username)
    rows = store.query("SELECT drill_id, correct, score, response_ms FROM events WHERE session_id = ?", (session_id,))
    base = baselines(u, exclude_session=session_id)
    drills = {}
    for d in dict.fromkeys(r["drill_id"] for r in rows):
        rs = [r for r in rows if r["drill_id"] == d]
        acc = round(sum(r["correct"] for r in rs) / len(rs), 3)
        med = _median([r["response_ms"] for r in rs if r["response_ms"]])
        b = base.get(d)
        drills[d] = {"items": len(rs), "accuracy": acc, "median_ms": med,
                     "baseline": b if b and b["items"] >= 10 else None}
    total = len(rows)
    summary = {"items": total, "accuracy": round(sum(r["correct"] for r in rows) / total, 3) if total else None,
               "drills": drills}
    store.write("UPDATE sessions SET ended_at = ?, summary = ? WHERE id = ?", (store.now(), store.dumps(summary), session_id))
    row = store.one("SELECT moment_id FROM sessions WHERE id = ?", (session_id,))
    if row and row.get("moment_id"):
        store.write("UPDATE moments SET play_at = COALESCE(play_at, ?) WHERE id = ?", (store.now(), row["moment_id"]))
    return summary


# ── routine / consent ───────────────────────────────────────────────────────

class RoutineIn(BaseModel):
    username: str = ""
    steps: list[str]


@router.get("/routine")
def get_routine(username: str = ""):
    return {"steps": _routine(_user(username))}


@router.put("/routine")
def put_routine(body: RoutineIn):
    u = _user(body.username)
    steps = [s for s in body.steps if s in composer.ALL_ACTIVITIES][:12]
    if not steps:
        raise HTTPException(400, "a routine needs at least one activity")
    store.write("INSERT INTO routines VALUES (?,?,?) ON CONFLICT(username) DO UPDATE SET steps = excluded.steps, "
                "updated_at = excluded.updated_at", (u, store.dumps(steps), store.now()))
    return {"steps": steps}


class ConsentIn(BaseModel):
    username: str
    granted: bool


@router.post("/consent")
def consent(body: ConsentIn):
    u = _user(body.username)
    store.write("INSERT INTO consents VALUES (?,?,?) ON CONFLICT(username) DO UPDATE SET granted = excluded.granted, "
                "updated_at = excluded.updated_at", (u, int(body.granted), store.now()))
    return {"granted": body.granted}


@router.post("/link")
def link(username: str = "", platform: Platform = "chesscom"):
    return {"started": outcomes.link_async(_user(username), platform)}


# ── stats (user + coach) ────────────────────────────────────────────────────

def user_stats(username: str, days: int = 30) -> dict:
    since = time.time() - days * 86400
    rows = store.query("SELECT drill_id, correct, response_ms, ts FROM events WHERE username = ? AND ts >= ?", (username, since))
    trends = {}
    for d in dict.fromkeys(r["drill_id"] for r in rows):
        rs = sorted((r for r in rows if r["drill_id"] == d), key=lambda r: r["ts"])
        half = max(1, len(rs) // 2)
        first, last = rs[:half], rs[half:] or rs[:half]
        acc = lambda xs: round(sum(x["correct"] for x in xs) / len(xs), 3)
        trends[d] = {"items": len(rs), "accuracy": acc(rs), "early_accuracy": acc(first), "recent_accuracy": acc(last),
                     "median_ms": _median([r["response_ms"] for r in rs if r["response_ms"]]),
                     "early_ms": _median([r["response_ms"] for r in first if r["response_ms"]]),
                     "recent_ms": _median([r["response_ms"] for r in last if r["response_ms"]])}
    outs = store.query("SELECT o.*, m.arm, m.in_experiment FROM outcomes o JOIN moments m ON m.id = o.moment_id "
                       "WHERE o.username = ? AND o.played_at >= ?", (username, since))
    by_arm = {}
    for arm in ("warmup", "control"):
        xs = [o for o in outs if o["arm"] == arm and o["blunders_per40"] is not None]
        by_arm[arm] = {"games": len(xs), "blunders_per40": round(statistics.mean(o["blunders_per40"] for o in xs), 2) if xs else None,
                       "accuracy": round(statistics.mean(o["accuracy"] for o in xs if o["accuracy"] is not None), 1)
                       if any(o["accuracy"] is not None for o in xs) else None}
    sessions = store.one("SELECT count(*) AS n FROM sessions WHERE username = ? AND started_at >= ?", (username, since))
    return {"days": days, "sessions": sessions["n"] if sessions else 0, "drills": trends, "games_after": by_arm,
            "enough_data": all(by_arm[a]["games"] >= cfg()["experiment"]["min_games_per_arm"] for a in by_arm)}


@router.get("/stats")
def stats(username: str = "", days: int = 30):
    return user_stats(_user(username), max(1, min(365, days)))


# ── internal dashboard ──────────────────────────────────────────────────────

def _agg(rows: list[dict]) -> dict:
    xs = [r for r in rows if r.get("blunders_per40") is not None]
    acc = [r["accuracy"] for r in xs if r.get("accuracy") is not None]
    return {"games": len(xs), "blunders_per40": round(statistics.mean(r["blunders_per40"] for r in xs), 3) if xs else None,
            "accuracy": round(statistics.mean(acc), 2) if acc else None}


@router.get("/lab")
def lab():
    rows = store.query("SELECT o.*, m.arm, m.in_experiment, m.band, m.time_control AS planned_tc, m.session_id "
                       "FROM outcomes o JOIN moments m ON m.id = o.moment_id")
    exp = [r for r in rows if r["in_experiment"]]
    groups: dict[str, dict] = {"overall": {arm: _agg([r for r in exp if r["arm"] == arm]) for arm in ("warmup", "control")}}
    groups["by_band"] = {b["id"]: {arm: _agg([r for r in exp if r["arm"] == arm and r["band"] == b["id"]])
                                   for arm in ("warmup", "control")} for b in cfg()["bands"]}
    groups["by_time_control"] = {tc: {arm: _agg([r for r in exp if r["arm"] == arm and r["time_class"] == tc])
                                      for arm in ("warmup", "control")} for tc in TIME_CONTROLS}
    plans = {s["id"]: json.loads(s["plan"] or "[]") for s in store.query("SELECT id, plan FROM sessions")}
    by_drill = {}
    for drill in composer.ALL_ACTIVITIES:
        with_d = [r for r in rows if r["arm"] == "warmup" and any(p["activity"] == drill for p in plans.get(r["session_id"], []))]
        if with_d:
            by_drill[drill] = _agg(with_d)
    groups["warmup_games_by_drill"] = by_drill
    groups["observational"] = {"warmup_not_in_experiment": _agg([r for r in rows if not r["in_experiment"]])}
    ev = store.query("SELECT drill_id, band, correct, response_ms FROM events")
    drills = {}
    for d in dict.fromkeys(e["drill_id"] for e in ev):
        es = [e for e in ev if e["drill_id"] == d]
        drills[d] = {"items": len(es), "accuracy": round(sum(e["correct"] for e in es) / len(es), 3),
                     "median_ms": _median([e["response_ms"] for e in es if e["response_ms"]]),
                     "by_band": {b: round(sum(e["correct"] for e in es if e["band"] == b) / max(1, sum(1 for e in es if e["band"] == b)), 3)
                                 for b in dict.fromkeys(e["band"] for e in es) if b}}
    counts = store.one("SELECT (SELECT count(*) FROM moments) AS moments, (SELECT count(*) FROM moments WHERE in_experiment = 1) "
                       "AS experiment_moments, (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM events) AS events, "
                       "(SELECT count(*) FROM outcomes) AS games")
    return {"counts": counts, "groups": groups, "drills": drills,
            "min_games_per_arm": cfg()["experiment"]["min_games_per_arm"]}
