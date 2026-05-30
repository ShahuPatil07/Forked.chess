"""
Build the endgame database.

Reads `data/endgame_positions.json` (curated practice positions) and writes
them to the SQLite database at `data/endgame.db` along with the supporting
cache tables that the endgames router needs:

    endgame_positions          — curated practice positions
    endgame_syzygy_cache       — Lichess Syzygy tablebase results (permanent)
    endgame_knowledge_chunks   — for parity with the spec; populated separately
    endgame_suggestions_cache  — quick-prompt chip cache (per category × rating)

Usage:
    python scripts/build_endgame_positions.py                # load + write
    python scripts/build_endgame_positions.py --verify       # also verify
                                                             # every FEN via
                                                             # Syzygy (slow,
                                                             # ~1 req/sec)
    python scripts/build_endgame_positions.py --recreate     # drop existing
                                                             # endgame_positions
                                                             # rows before insert

Output: data/endgame.db (created if absent).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import sqlite3
import sys
import time
import uuid
from pathlib import Path

import chess
import requests

ROOT          = Path(__file__).parent.parent
DATA_DIR      = ROOT / "data"
DB_PATH       = DATA_DIR / "endgame.db"
POSITIONS_JSON = DATA_DIR / "endgame_positions.json"

SYZYGY_URL    = "https://tablebase.lichess.ovh/standard"
SYZYGY_DELAY  = 1.05   # be polite — Lichess asks for ≤1 req/sec
SYZYGY_MAX_P  = 7      # tablebase only supports up to 7 pieces

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s  %(message)s")
log = logging.getLogger("build_endgame_positions")


# ── DB setup ──────────────────────────────────────────────────────────────────

def init_db(con: sqlite3.Connection) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS endgame_positions (
            id          TEXT PRIMARY KEY,
            category    TEXT NOT NULL,
            difficulty  TEXT NOT NULL,
            fen         TEXT NOT NULL UNIQUE,
            objective   TEXT NOT NULL,
            dtm         INTEGER,
            description TEXT,
            active      INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL
        )
    """)
    con.execute("CREATE INDEX IF NOT EXISTS idx_eg_cat_diff ON endgame_positions(category, difficulty, active)")

    con.execute("""
        CREATE TABLE IF NOT EXISTS endgame_syzygy_cache (
            fen        TEXT PRIMARY KEY,
            category   TEXT,         -- win | loss | draw | cursed-win | blessed-loss | unknown
            dtm        INTEGER,
            dtz        INTEGER,
            best_move  TEXT,
            fetched_at TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS endgame_knowledge_chunks (
            id           TEXT PRIMARY KEY,
            source       TEXT,
            url          TEXT,
            title        TEXT,
            category     TEXT,
            content      TEXT NOT NULL,
            created_at   TEXT NOT NULL
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS endgame_suggestions_cache (
            key         TEXT PRIMARY KEY,   -- "{category}|{rating_band}"
            chips       TEXT NOT NULL,      -- JSON list[str]
            expires_at  TEXT NOT NULL
        )
    """)

    con.commit()


# ── Position loading ──────────────────────────────────────────────────────────

def load_positions(path: Path) -> list[dict]:
    if not path.exists():
        log.error("Positions JSON not found at %s", path)
        sys.exit(1)
    with open(path, encoding="utf-8") as fh:
        items = json.load(fh)

    # Validate every FEN is legal — catch problems before they hit the DB
    bad = []
    for i, p in enumerate(items):
        try:
            board = chess.Board(p["fen"])
            if not board.is_valid():
                bad.append((i, p["fen"], f"status={board.status()}"))
        except Exception as exc:
            bad.append((i, p.get("fen", "<missing>"), str(exc)[:80]))

    if bad:
        log.error("%d invalid FENs — aborting", len(bad))
        for i, fen, err in bad:
            log.error("  [%d] %s\n         %s", i, err, fen)
        sys.exit(1)

    log.info("Loaded %d curated positions (all FENs validated)", len(items))
    return items


# ── Syzygy verification ──────────────────────────────────────────────────────

def syzygy_lookup(fen: str, session: requests.Session) -> dict | None:
    """Single Syzygy query. Returns parsed dict or None on failure."""
    try:
        resp = session.get(SYZYGY_URL, params={"fen": fen}, timeout=10)
        if resp.status_code != 200:
            log.warning("Syzygy %d for %s", resp.status_code, fen[:40])
            return None
        return resp.json()
    except Exception as exc:
        log.warning("Syzygy error for %s: %s", fen[:40], exc)
        return None


def cache_syzygy_result(con: sqlite3.Connection, fen: str, data: dict) -> None:
    moves = data.get("moves") or []
    best  = moves[0].get("uci") if moves else None
    con.execute(
        "INSERT OR REPLACE INTO endgame_syzygy_cache "
        "(fen, category, dtm, dtz, best_move, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
        (
            fen,
            data.get("category"),
            data.get("dtm"),
            data.get("dtz"),
            best,
            dt.datetime.utcnow().isoformat(),
        ),
    )


def verify_all(con: sqlite3.Connection, items: list[dict]) -> None:
    """
    Hit Syzygy once per position (cached forever after). Updates DTM on the
    positions table where Syzygy returns it.
    """
    session = requests.Session()
    session.headers["User-Agent"] = "Forked/0.1 (https://github.com/ShahuPatil07/Forked)"

    eligible = [p for p in items if chess.Board(p["fen"]).occupied.bit_count() <= SYZYGY_MAX_P]
    log.info("Verifying %d / %d positions via Syzygy (≤%d pieces)",
             len(eligible), len(items), SYZYGY_MAX_P)

    verified = 0
    mismatches: list[str] = []
    for i, p in enumerate(eligible, 1):
        fen = p["fen"]

        # Skip if already in cache
        existing = con.execute(
            "SELECT category FROM endgame_syzygy_cache WHERE fen=?", (fen,)
        ).fetchone()
        if existing is not None:
            verified += 1
            continue

        data = syzygy_lookup(fen, session)
        if data is None:
            continue

        cache_syzygy_result(con, fen, data)
        con.commit()
        verified += 1

        # Cross-check the curated objective against Syzygy
        objective = p.get("objective", "")
        sz_cat    = data.get("category")
        if objective == "win_white" and sz_cat not in ("win", "cursed-win"):
            mismatches.append(f"Expected white win, Syzygy says '{sz_cat}': {fen}")
        elif objective == "win_black" and sz_cat not in ("loss", "blessed-loss"):
            mismatches.append(f"Expected black win, Syzygy says '{sz_cat}': {fen}")
        elif objective == "draw" and sz_cat != "draw":
            mismatches.append(f"Expected draw, Syzygy says '{sz_cat}': {fen}")

        # Persist DTM back to positions table
        if data.get("dtm") is not None:
            con.execute("UPDATE endgame_positions SET dtm=? WHERE fen=?", (data["dtm"], fen))
            con.commit()

        if i % 10 == 0:
            log.info("  Verified %d/%d (rate-limited ~1/sec)", i, len(eligible))
        time.sleep(SYZYGY_DELAY)

    log.info("Syzygy verification complete: %d/%d cached", verified, len(eligible))
    if mismatches:
        log.warning("%d objective mismatches (check curation!):", len(mismatches))
        for m in mismatches[:10]:
            log.warning("  %s", m)


# ── Insert positions ─────────────────────────────────────────────────────────

def insert_positions(con: sqlite3.Connection, items: list[dict], recreate: bool) -> None:
    if recreate:
        con.execute("DELETE FROM endgame_positions")
        con.commit()
        log.info("Cleared endgame_positions for re-insert")

    now = dt.datetime.utcnow().isoformat()
    inserted = updated = 0
    for p in items:
        fen = p["fen"]
        existing = con.execute("SELECT id FROM endgame_positions WHERE fen=?", (fen,)).fetchone()
        if existing:
            # Refresh metadata (category/difficulty/description/objective may have changed)
            con.execute(
                "UPDATE endgame_positions SET category=?, difficulty=?, objective=?, description=?, active=1 "
                "WHERE fen=?",
                (p["category"], p["difficulty"], p["objective"], p.get("description", ""), fen),
            )
            updated += 1
        else:
            con.execute(
                "INSERT INTO endgame_positions "
                "(id, category, difficulty, fen, objective, description, active, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
                (
                    str(uuid.uuid4()),
                    p["category"], p["difficulty"], fen,
                    p["objective"], p.get("description", ""), now,
                ),
            )
            inserted += 1

    con.commit()
    log.info("Positions written: %d inserted, %d updated", inserted, updated)


# ── Coverage check ────────────────────────────────────────────────────────────

def print_coverage(con: sqlite3.Connection) -> None:
    rows = con.execute(
        "SELECT category, difficulty, COUNT(*) FROM endgame_positions WHERE active=1 "
        "GROUP BY category, difficulty ORDER BY category, difficulty"
    ).fetchall()
    log.info("Coverage by (category, difficulty):")
    for cat, diff, n in rows:
        log.info("  %-8s %-13s  %d", cat, diff, n)


# ── Entrypoint ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify",   action="store_true",
                        help="Verify every position via Syzygy (slow, ~1 req/sec).")
    parser.add_argument("--recreate", action="store_true",
                        help="Drop existing endgame_positions rows before insert.")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    con = sqlite3.connect(str(DB_PATH))
    init_db(con)

    items = load_positions(POSITIONS_JSON)
    insert_positions(con, items, recreate=args.recreate)

    if args.verify:
        verify_all(con, items)

    print_coverage(con)
    con.close()
    log.info("Done. Database at %s", DB_PATH)


if __name__ == "__main__":
    main()
