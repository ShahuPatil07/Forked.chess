#!/usr/bin/env python
"""
Build a hand-labelling ("gold") set from one benchmark account's real mistakes.

Samples ~150 of the user's positions from the frozen benchmark games:
  - v2 mistakes, stratified by mechanism (allowed / missed / both / quiet), and
  - positions ONLY the legacy pipeline calls a mistake (to test the noise claim
    with human judgement).
Which pipeline flagged an item is kept out of the page (no labelling bias) and
written only to data/gold/<user>_items.json for scripts/eval_stage12.py --gold.

    python scripts/build_gold_set.py ShahuPatil27 --out <page.html>
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chess

from ml.config import DATA_DIR
from ml.ingestion.annotator import annotate_game
from ml.ingestion.mistake_extractor import extract_game_events
from ml.eval.legacy import legacy_extract

QUOTA = {"allowed": 45, "missed": 25, "both": 10, "quiet": 30}
LEGACY_ONLY = 40


def _unix(ts):
    if not ts:
        return None
    return int(ts // 1000) if ts > 1e10 else int(ts)


def _san_line(fen: str, line: list[str], plies: int = 6) -> list[str]:
    b, out = chess.Board(fen), []
    for uci in line[:plies]:
        try:
            mv = chess.Move.from_uci(uci)
            if mv not in b.legal_moves:
                break
            out.append(b.san(mv)); b.push(mv)
        except ValueError:
            break
    return out


def _fmt_eval(cp: int) -> str:
    if abs(cp) >= 29_000:
        return "mate" if cp > 0 else "mated"
    return f"{cp / 100:+.1f}"


def _item(ev, game: dict, source: str) -> dict:
    b = chess.Board(ev.fen)
    return {
        "id": f"{ev.game_id}:{ev.ply}",
        "fen": ev.fen, "fen_after": ev.fen_after,
        "color": "white" if b.turn == chess.WHITE else "black",
        "move_number": ev.move_number,
        "played_uci": ev.move_played_uci, "played_san": ev.move_played_san,
        "best_uci": ev.best_move_uci, "best_line": _san_line(ev.fen, ev.best_line),
        "reply_uci": ev.reply_line[0] if ev.reply_line else "",
        "reply_line": _san_line(ev.fen_after, ev.reply_line),
        "eval_before": _fmt_eval(ev.eval_before_cp), "eval_after": _fmt_eval(ev.eval_after_cp),
        "win_before": round(ev.es_before * 100), "win_after": round(ev.es_after * 100),
        "url": game.get("url", ""), "opponent": game.get("black_username" if b.turn == chess.WHITE else "white_username", ""),
        "_source": source, "_game_id": ev.game_id, "_ply": ev.ply,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("user")
    ap.add_argument("--out", required=True, help="where to write the labelling page HTML")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--reuse", action="store_true",
                    help="re-render the page from the existing items file (keeps item ids stable)")
    args = ap.parse_args()
    rng = random.Random(args.seed)
    gold_dir = DATA_DIR / "gold"

    if args.reuse:
        items = json.loads((gold_dir / f"{args.user}_items.json").read_text(encoding="utf-8"))
        _render(items, args.user, args.out)
        print(f"re-rendered {len(items)} existing items -> {args.out}")
        return

    games = json.loads((DATA_DIR / "bench" / f"{args.user}_games.json").read_text(encoding="utf-8"))
    by_id = {g["game_id"]: g for g in games}
    v2_events, legacy_events = [], []
    for g in games:
        try:
            anns = annotate_game(g["pgn"], None, game_id=g["game_id"], increment_s=g.get("increment_s") or 0)
        except Exception:
            continue                                   # not cached yet
        ts = _unix(g.get("played_at"))
        v2_events += extract_game_events(anns, g, g["user_color"], played_at_unix=ts,
                                         initial_s=g.get("initial_s")).mistakes
        legacy_events += legacy_extract(anns, g, g["user_color"], ts)

    v2_keys = {(e.game_id, e.ply) for e in v2_events}
    legacy_keys = {(e.game_id, e.ply) for e in legacy_events}
    items = []
    for direction, n in QUOTA.items():
        pool = [e for e in v2_events if e.direction == direction]
        for e in rng.sample(pool, min(n, len(pool))):
            items.append(_item(e, by_id[e.game_id], "both" if (e.game_id, e.ply) in legacy_keys else "v2"))
    legacy_only = [e for e in legacy_events if (e.game_id, e.ply) not in v2_keys]
    for e in rng.sample(legacy_only, min(LEGACY_ONLY, len(legacy_only))):
        items.append(_item(e, by_id[e.game_id], "legacy"))
    rng.shuffle(items)

    gold_dir.mkdir(parents=True, exist_ok=True)
    (gold_dir / f"{args.user}_items.json").write_text(json.dumps(items, indent=1), encoding="utf-8")
    _render(items, args.user, args.out)
    print(f"{len(items)} items ({sum(it['_source'] != 'legacy' for it in items)} v2, "
          f"{sum(it['_source'] == 'legacy' for it in items)} legacy-only) -> {args.out}")


def _render(items: list[dict], user: str, out: str) -> None:
    """Write the labelling page with the items embedded (pipeline sources stripped)."""
    public = [{k: v for k, v in it.items() if not k.startswith("_")} for it in items]
    template = (ROOT / "scripts" / "gold_label_page.html").read_text(encoding="utf-8")
    page = template.replace("/*__ITEMS__*/[]", json.dumps(public, separators=(",", ":"))) \
                   .replace("__USER__", user)
    Path(out).write_text(page, encoding="utf-8")


if __name__ == "__main__":
    main()
