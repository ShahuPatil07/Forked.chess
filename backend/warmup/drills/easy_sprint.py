"""Easy Tactic Sprint -- short, easy puzzles from the Puzzle Themes index, rated well BELOW
the player (target ~85-90% solved). Attempts are logged by Warm-Up only: they never
touch the SM-2 drill queue or the Puzzle Themes ratings / review queue (config flags)."""
from __future__ import annotations

import random
import sqlite3

from ..config import band_for, level_value
from ..positions import THEMES_DB


def generate(rng: random.Random, level: int, n: int, ctx: dict) -> list[dict]:
    if not THEMES_DB.exists():
        return []
    band = ctx.get("band") or band_for(ctx.get("rating"))
    sprint = band["sprint"]
    target = int((ctx.get("rating") or 1200) + sprint["offset"] + level_value("easy_sprint", "offset_shift", level))
    target = max(450, target)
    seen = ctx.get("seen") or set()
    con = sqlite3.connect(f"file:{THEMES_DB.as_posix()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    out = []
    try:
        for window in (120, 250, 500, 900):
            if sprint.get("theme"):
                rows = con.execute(
                    "SELECT p.* FROM puzzle_theme t JOIN puzzles p ON p.id = t.id WHERE t.theme = ? "
                    "AND t.rating BETWEEN ? AND ? AND p.nply <= ? ORDER BY random() LIMIT ?",
                    (sprint["theme"], target - window, target + window, sprint["max_plies"], n * 3)).fetchall()
            else:
                rows = con.execute(
                    "SELECT * FROM puzzles WHERE rating BETWEEN ? AND ? AND nply <= ? AND popularity >= 60 "
                    "ORDER BY random() LIMIT ?",
                    (target - window, target + window, sprint["max_plies"], n * 3)).fetchall()
            for r in rows:
                if r["id"] in seen or any(o["id"] == r["id"] for o in out):
                    continue
                out.append({"id": r["id"], "level": level, "fen": r["fen"], "moves": r["moves"], "rating": r["rating"],
                            "color": r["color"], "themes": r["themes"].split()})
                if len(out) >= n:
                    return out
    finally:
        con.close()
    return out
