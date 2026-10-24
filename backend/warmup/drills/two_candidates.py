"""Two Candidates (anti-Einstellung) -- a position with a tempting move and a better one.
Enter two candidate moves, then choose. Items come from the offline bank
(scripts/build_warmup_bank.py, Stockfish only: deep MultiPV for the best moves, a depth-3 search for
the move a quick look prefers -- the "tempting" one). Without the bank, this drill is skipped."""
from __future__ import annotations

import json
import random
import sqlite3

from ..config import BANK_DB, level_value


def available() -> bool:
    if not BANK_DB.exists():
        return False
    con = sqlite3.connect(f"file:{BANK_DB.as_posix()}?mode=ro", uri=True)
    try:
        return con.execute("SELECT count(*) FROM candidates").fetchone()[0] > 0
    except sqlite3.Error:
        return False
    finally:
        con.close()


def generate(rng: random.Random, level: int, n: int, ctx: dict) -> list[dict]:
    if not BANK_DB.exists():
        return []
    lo, hi = level_value("two_candidates", "rating", level)
    seen = ctx.get("seen") or set()
    con = sqlite3.connect(f"file:{BANK_DB.as_posix()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute("SELECT * FROM candidates WHERE rating BETWEEN ? AND ? ORDER BY random() LIMIT ?",
                           (lo, hi, n * 4)).fetchall()
        if len(rows) < n:
            rows += con.execute("SELECT * FROM candidates ORDER BY random() LIMIT ?", (n * 4,)).fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()
    out = []
    for r in rows:
        if r["id"] in seen or any(o["src"] == r["id"] for o in out):
            continue
        out.append({"id": f"tw-{rng.getrandbits(40):x}", "src": r["id"], "level": level, "fen": r["fen"],
                    "before": r["before"], "last": r["last"], "orientation": r["orientation"],
                    "best": json.loads(r["best"]), "best_san": r["best_san"], "tempting_san": r["tempting_san"],
                    "evals": json.loads(r["evals"]), "rating": r["rating"]})
        if len(out) >= n:
            break
    return out
