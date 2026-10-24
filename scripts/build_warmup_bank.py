"""
Mine the Warm-Up "Two Candidates" bank (data/puzzles/warmup_bank.db) -- free, offline,
Stockfish only (no API calls, no Maia).

The drill trains the anti-Einstellung habit: the first good move you see is not always the
best. "Tempting" is defined purely with the engine as the move a QUICK look prefers:
  - shallow = Stockfish's choice at depth 3 (what a fast glance finds);
  - deep    = Stockfish MultiPV at depth 14 from the same real-game position
              (Puzzle Themes index, after the opponent's move);
  - keep it when the shallow choice is not losing (>= -80 cp for the mover at depth 14)
    but the deep best beats it by >= 150 cp.
Stores the best move(s) (within 30 cp of best), the tempting move, and the deep evals of
the top moves, so the drill scores candidates without an engine at run time.

    python scripts/build_warmup_bank.py                # ~1000 positions
    python scripts/build_warmup_bank.py --target 300 --workers 4
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import random
import sqlite3
import sys
import time
from pathlib import Path

import chess
import chess.engine

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ml.config import STOCKFISH_PATH  # noqa: E402

THEMES_DB = ROOT / "data" / "puzzles" / "themes.db"
OUT = ROOT / "data" / "puzzles" / "warmup_bank.db"
MARGIN, TEMPT_FLOOR, BEST_TOL, DEPTH, QUICK_DEPTH = 150, -80, 30, 14, 3

_engine = None


def _cp(score: chess.engine.PovScore, pov: chess.Color) -> int:
    return score.pov(pov).score(mate_score=10000)


def mine(job: tuple[str, str, str, int]) -> dict | None:
    """One candidate position -> a bank row, or None."""
    global _engine
    pid, fen, moves, rating = job
    if sys.platform == "win32":
        import asyncio
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    if _engine is None:
        _engine = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH))
        _engine.configure({"Threads": 1, "Hash": 32})
    before = chess.Board(fen)
    trig = chess.Move.from_uci(moves.split()[0])
    if trig not in before.legal_moves:
        return None
    board = before.copy(stack=False)
    board.push(trig)
    if board.is_check() or board.is_game_over() or board.legal_moves.count() < 6:
        return None
    pov = board.turn
    quick = _engine.analyse(board, chess.engine.Limit(depth=QUICK_DEPTH))
    if not quick.get("pv"):
        return None
    tempting = quick["pv"][0].uci()
    infos = _engine.analyse(board, chess.engine.Limit(depth=DEPTH), multipv=5)
    evals = {}
    for info in infos:
        mv = info["pv"][0]
        evals[mv.uci()] = _cp(info["score"], pov)
    best_uci = max(evals, key=evals.get)
    if tempting == best_uci:
        return None
    if tempting not in evals:
        t_info = _engine.analyse(board, chess.engine.Limit(depth=DEPTH), root_moves=[chess.Move.from_uci(tempting)])
        evals[tempting] = _cp(t_info["score"], pov)
    best_eval, t_eval = evals[best_uci], evals[tempting]
    if t_eval < TEMPT_FLOOR or best_eval - t_eval < MARGIN or abs(best_eval) >= 9000 and abs(t_eval) >= 9000:
        return None
    best = [u for u, e in evals.items() if e >= best_eval - BEST_TOL]
    if tempting in best:
        return None
    san = {u: board.san(chess.Move.from_uci(u)) for u in evals}
    return {"id": pid, "before": before.fen(), "last": trig.uci(), "fen": board.fen(),
            "orientation": "white" if pov == chess.WHITE else "black", "rating": int(rating),
            "best": json.dumps(best), "best_san": san[best_uci], "tempting": tempting, "tempting_san": san[tempting],
            "evals": json.dumps({san[u]: e for u, e in sorted(evals.items(), key=lambda kv: -kv[1])})}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", type=int, default=1000)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--seed", type=int, default=5)
    args = ap.parse_args()
    con = sqlite3.connect(THEMES_DB)
    rows = con.execute("SELECT id, fen, moves, rating FROM puzzles WHERE nply >= 3 AND popularity >= 60 "
                       "AND rating BETWEEN 700 AND 2700").fetchall()
    con.close()
    random.Random(args.seed).shuffle(rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    out = sqlite3.connect(OUT)
    out.executescript("""CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY, before TEXT, last TEXT, fen TEXT NOT NULL, orientation TEXT, rating INTEGER,
        best TEXT, best_san TEXT, tempting TEXT, tempting_san TEXT, evals TEXT);
        CREATE INDEX IF NOT EXISTS ix_cand_rating ON candidates(rating);""")
    done = {r[0] for r in out.execute("SELECT id FROM candidates")}
    rows = [r for r in rows if r[0] not in done]            # resumable: never re-mine a banked puzzle
    t0, tried, kept = time.time(), 0, len(done)
    chunk = args.workers * 40
    ex = cf.ProcessPoolExecutor(args.workers)
    i = 0
    while kept < args.target and i < len(rows):
        batch = rows[i:i + chunk]
        i += chunk
        for r in ex.map(mine, batch, chunksize=8):
            tried += 1
            if r:
                cur = out.execute("INSERT OR IGNORE INTO candidates VALUES (:id,:before,:last,:fen,:orientation,:rating,"
                                  ":best,:best_san,:tempting,:tempting_san,:evals)", r)
                kept += cur.rowcount
        out.commit()
        print(f"  tried {tried}, kept {kept}  ({time.time() - t0:.0f}s)", flush=True)
    out.close()
    print(f"bank: {kept} two-candidate positions in {OUT}", flush=True)
    for proc in list(getattr(ex, '_processes', {}).values()):
        proc.terminate()                  # Stockfish children exit on stdin EOF
    ex.shutdown(wait=False, cancel_futures=True)
    os._exit(0)                       # workers hold Stockfish processes; don't wait on their atexit


if __name__ == "__main__":
    main()
