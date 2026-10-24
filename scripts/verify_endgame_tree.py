"""
Verify every leaf of the endgame theory tree (frontend/src/data/endgameTree.ts)
against the Syzygy tablebase.

For each leaf with <= 7 pieces, the declared `result` (white_wins / black_wins /
draw) must match the tablebase verdict for the side to move. Leaves with more
pieces are checked for legality only and listed as "unverifiable".

    python scripts/verify_endgame_tree.py          # report
    python scripts/verify_endgame_tree.py --json   # machine-readable

Uses backend.endgames._fetch_syzygy_sync, which caches every answer in
data/endgame.db, so re-runs are free.
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import chess  # noqa: E402

TREE = ROOT / "frontend" / "src" / "data" / "endgameTree.ts"


LEAF_RE = re.compile(
    r"id:\s*'([^']+)',\s*title:\s*'((?:[^'\\]|\\.)*)',"     # id + title
    r"(?:(?!\bid:).)*?fen:\s*'([^']+)',"                     # its fen, never crossing into the next object
    r"(?:(?!\bid:).)*?result:\s*'([^']+)'", re.S)


def leaves() -> list[dict]:
    text = TREE.read_text(encoding="utf-8")
    return [{"id": m.group(1), "title": m.group(2), "fen": m.group(3), "result": m.group(4)}
            for m in LEAF_RE.finditer(text)]


def expected(category: str, turn: chess.Color) -> str | None:
    stm = "white" if turn == chess.WHITE else "black"
    other = "black" if stm == "white" else "white"
    if category in ("win", "cursed-win"):
        return f"{stm}_wins"
    if category in ("loss", "blessed-loss"):
        return f"{other}_wins"
    if category == "draw":
        return "draw"
    return None


def main() -> int:
    from backend.endgames import _fetch_syzygy_sync
    rows, bad = [], 0
    for leaf in leaves():
        board = chess.Board(leaf["fen"])
        row = {**leaf, "legal": board.is_valid(), "pieces": len(board.piece_map())}
        if not board.is_valid():
            row["status"] = "ILLEGAL"
            bad += 1
        elif row["pieces"] > 7:
            row["status"] = "unverifiable (>7 pieces)"
        else:
            try:
                sz = _fetch_syzygy_sync(leaf["fen"])
                truth = expected(sz.category or "", board.turn)
                row["tablebase"] = sz.category
                row["truth"] = truth
                if leaf["result"] == "depends":
                    row["status"] = f"depends (tablebase: {truth})"
                elif truth == leaf["result"]:
                    row["status"] = "ok"
                else:
                    row["status"] = "MISMATCH"
                    bad += 1
            except Exception as exc:
                row["status"] = f"error: {exc}"
            time.sleep(0.15)
        rows.append(row)
    if "--json" in sys.argv:
        print(json.dumps(rows, indent=2))
    else:
        for r in rows:
            flag = "!!" if r["status"] in ("MISMATCH", "ILLEGAL") else "  "
            print(f"{flag} {r['id']:<32} declared={r['result']:<11} {r['status']}"
                  + (f"  (tablebase says {r.get('truth')})" if r["status"] == "MISMATCH" else ""))
        print(f"\n{len(rows)} leaves, {bad} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
