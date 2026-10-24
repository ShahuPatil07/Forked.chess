"""
Drill progress — the numbers that make practice stick.

POST /api/drills/attempt   {username, cluster_id, correct, time_s, puzzle_id, date}
GET  /api/drills/stats/{username}?today=YYYY-MM-DD

Stored in data/output/{user}_drill_stats.json (the SM-2 schedule itself stays
in ml/srs). `date` is the player's LOCAL calendar date, sent by the browser, so
day streaks follow the player's day rather than UTC.

Stats: puzzles solved, accuracy, current / best solve streak, day streak (and
best), today's count, the last 14 days, and per blindspot family how many of
your real-game mistakes you have now drilled ("coverage").
"""
from __future__ import annotations

import datetime as dt
import re
import time
from collections import Counter
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.auth import assert_owner
from backend.storage import locked_update, read_json, safe_name
from ml.config import DATA_DIR

router = APIRouter(prefix="/api/drills")
OUTPUT_DIR = DATA_DIR / "output"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _path(username: str):
    return OUTPUT_DIR / f"{safe_name(username)}_drill_stats.json"


def _empty() -> dict:
    return {"total": 0, "solved": 0, "streak": 0, "best_streak": 0, "days": {}, "families": {}, "recent": []}


class AttemptIn(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    cluster_id: str = Field(default="unclassified", max_length=60)
    correct: bool
    time_s: float = Field(default=0, ge=0, le=36000)
    puzzle_id: Optional[str] = Field(default=None, max_length=40)
    date: Optional[str] = None


@router.post("/attempt")
def attempt(body: AttemptIn, request: Request):
    assert_owner(request, body.username)
    day = body.date if body.date and DATE_RE.match(body.date) else dt.date.today().isoformat()

    def apply(s: dict):
        s.setdefault("days", {}); s.setdefault("families", {}); s.setdefault("recent", [])
        s["total"] = s.get("total", 0) + 1
        if body.correct:
            s["solved"] = s.get("solved", 0) + 1
            s["streak"] = s.get("streak", 0) + 1
            s["best_streak"] = max(s.get("best_streak", 0), s["streak"])
        else:
            s["streak"] = 0
        d = s["days"].setdefault(day, {"n": 0, "w": 0})
        d["n"] += 1
        d["w"] += int(body.correct)
        f = s["families"].setdefault(body.cluster_id, {"n": 0, "w": 0})
        f["n"] += 1
        f["w"] += int(body.correct)
        s["recent"] = (s["recent"] + [{"t": time.time(), "c": body.cluster_id, "ok": body.correct,
                                        "s": round(body.time_s, 1), "p": body.puzzle_id}])[-500:]
    s = locked_update(_path(body.username), _empty(), apply)
    return {"streak": s["streak"], "best_streak": s["best_streak"], "total": s["total"], "solved": s["solved"]}


def _day_streak(days: dict, today: dt.date) -> tuple[int, int]:
    have = {dt.date.fromisoformat(d) for d, v in days.items() if v.get("n")}
    # current: counts back from today, or from yesterday if nothing yet today
    cur, start = 0, today if today in have else today - dt.timedelta(days=1)
    while start in have:
        cur += 1
        start -= dt.timedelta(days=1)
    best, run, prev = 0, 0, None
    for d in sorted(have):
        run = run + 1 if prev and (d - prev).days == 1 else 1
        best = max(best, run)
        prev = d
    return cur, best


@router.get("/stats/{username}")
def stats(username: str, request: Request, today: Optional[str] = None):
    assert_owner(request, username)
    s = read_json(_path(username), None) or _empty()
    try:
        t = dt.date.fromisoformat(today) if today and DATE_RE.match(today) else dt.date.today()
    except ValueError:
        raise HTTPException(400, "Bad date")
    cur_days, best_days = _day_streak(s.get("days", {}), t)
    last = [{"date": (t - dt.timedelta(days=i)).isoformat(),
             **s.get("days", {}).get((t - dt.timedelta(days=i)).isoformat(), {"n": 0, "w": 0})} for i in range(13, -1, -1)]

    # coverage: your real-game incidents per family vs the puzzles you've drilled for it
    mistakes = read_json(OUTPUT_DIR / f"{username}_mistakes.json", []) or []
    incidents = Counter(str(m.get("cluster_id") or "unclassified") for m in mistakes
                        if m.get("side", "user") == "user" and not m.get("cascade")
                        and m.get("judgement") in ("mistake", "blunder"))
    clusters = read_json(OUTPUT_DIR / f"{username}_clusters.json", []) or []
    labels = {str(c.get("cluster_id")): c.get("label") for c in clusters}
    fams = s.get("families", {})
    families = []
    for cid in list(dict.fromkeys([*labels, *fams])):
        f = fams.get(cid, {"n": 0, "w": 0})
        inc = incidents.get(cid, 0)
        families.append({"cluster_id": cid, "label": labels.get(cid, cid.replace("_", " ").title()),
                         "drilled": f["n"], "solved": f["w"], "incidents": inc,
                         "coverage": round(min(1.0, f["w"] / inc), 3) if inc else None})
    total, solved = s.get("total", 0), s.get("solved", 0)
    return {
        "total": total, "solved": solved, "accuracy": round(solved / total, 3) if total else None,
        "streak": s.get("streak", 0), "best_streak": s.get("best_streak", 0),
        "day_streak": cur_days, "best_day_streak": best_days,
        "today": s.get("days", {}).get(t.isoformat(), {"n": 0, "w": 0}),
        "last14": last, "families": families,
        "mistakes_total": sum(incidents.values()),
        "mistakes_drilled_share": round(min(1.0, solved / sum(incidents.values())), 3) if incidents else None,
    }
