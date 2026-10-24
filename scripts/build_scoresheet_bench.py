"""
Freeze a handwritten-scoresheet benchmark from the public HCS dataset
(Handwritten Chess Scoresheet dataset, Eicher & Majid 2021: 158 real games,
~215 photographed pages with per-cell human transcriptions).

    python scripts/build_scoresheet_bench.py            # expects data/raw/hcs/pages (see --help)

Writes data/bench/scoresheets/ (gitignored, like the other frozen benches):
  images/<id>.jpg        the page, re-encoded JPEG (max edge 2000 px)
  manifest.json          per page: split (dev/test), literal label rows, reference game,
                         length of the legal prefix of the literal labels, paired page id

About the reference: HCS labels copy what the player WROTE, including the
player's own notation errors (missing disambiguation, wrong squares, "de",
"NxN", skipped moves). Only ~5% of pages replay as a legal game verbatim. The
reference game is therefore the legal game decoded from the human labels with
backend/scoresheet_decoder.py, and the evaluation reports two numbers:
  - accuracy on the verbatim-legal prefix (exact ground truth, decoder-free)
  - accuracy against the full decoded reference
For games where both players' sheets exist, the two references are compared to
measure how reliable the decoded reference itself is.
"""
from __future__ import annotations

import argparse
import collections
import json
import random
import re
import sys
from pathlib import Path

import chess

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.scoresheet_decoder import cells_from_rows, decode  # noqa: E402
from backend.scoresheet_prior import move_logprobs  # noqa: E402

SRC = ROOT / "data" / "raw" / "hcs" / "pages"
OUT = ROOT / "data" / "bench" / "scoresheets"


def load_labels(src: Path) -> dict[tuple[str, str], list[dict]]:
    pages: dict[tuple[str, str], dict[int, dict]] = collections.defaultdict(dict)
    for line in (src / "training_tags.txt").read_text(encoding="utf-8").splitlines():
        f, _, san = line.strip().partition(" ")
        m = re.match(r"(\d+)_(\d+)_(\d+)_(white|black)\.png", f)
        if not m:
            continue
        g, p, mv, c = m.groups()
        row = pages[(g, p)].setdefault(int(mv), {"number": int(mv), "white": "", "black": ""})
        row[c] = san.strip()
    return {k: [v[n] for n in sorted(v)] for k, v in pages.items()}


def legal_prefix(rows: list[dict]) -> list[str]:
    b, out = chess.Board(), []
    for r in rows:
        for c in ("white", "black"):
            s = r[c]
            if not s:
                continue
            try:
                m = b.parse_san(s)
            except ValueError:
                return out
            out.append(b.san(m))
            b.push(m)
    return out


def reference(rows: list[dict]) -> list[str]:
    """The legal game decoded from one page's human labels (runs in a worker process)."""
    return [x["san"] for x in decode(cells_from_rows(rows), prior=move_logprobs)["plies"]]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=SRC)
    ap.add_argument("--test", type=int, default=100)
    ap.add_argument("--dev", type=int, default=20)
    ap.add_argument("--min-cells", type=int, default=24, help="written cells a page needs (~12 moves)")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--seed", type=int, default=11)
    args = ap.parse_args()

    from PIL import Image
    labels = load_labels(args.src)
    entries = []
    for (g, p), rows in sorted(labels.items()):
        cells = sum(bool(r["white"]) + bool(r["black"]) for r in rows)
        if not (args.src / f"{g}_{p}.png").exists() or cells < args.min_cells:
            continue
        entries.append({"id": f"{g}_{p}", "game": g, "page": p, "rows": rows,
                        "legal_prefix": len(legal_prefix(rows)), "cells": cells})
    by_id = {e["id"]: e for e in entries}
    for e in entries:
        other = f"{e['game']}_{'1' if e['page'] == '0' else '0'}"
        e["pair"] = other if other in by_id else None

    # Split by GAME so a game's two sheets never straddle dev and test.
    games = sorted({e["game"] for e in entries})
    random.Random(args.seed).shuffle(games)
    dev_games, test_games, n_dev, n_test = set(), set(), 0, 0
    for g in games:
        pages = [e for e in entries if e["game"] == g]
        if n_dev < args.dev:
            dev_games.add(g); n_dev += len(pages)
        elif n_test < args.test:
            test_games.add(g); n_test += len(pages)
    chosen = [e for e in entries if e["game"] in dev_games | test_games]
    for e in chosen:
        e["split"] = "dev" if e["game"] in dev_games else "test"
    # reference games, decoded in parallel (CPU-bound beam search + Maia prior)
    import concurrent.futures as cf
    with cf.ProcessPoolExecutor(args.workers) as ex:
        for e, ref in zip(chosen, ex.map(reference, [e["rows"] for e in chosen])):
            e["reference"] = ref

    (OUT / "images").mkdir(parents=True, exist_ok=True)
    for e in chosen:
        im = Image.open(args.src / f"{e['id']}.png").convert("RGB")
        if max(im.size) > 2000:
            s = 2000 / max(im.size)
            im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
        im.save(OUT / "images" / f"{e['id']}.jpg", "JPEG", quality=90)

    # Reference reliability: both players' sheets of one game should decode to the same game.
    agree = total = 0
    for e in chosen:
        if e["pair"] and e["page"] == "0" and e["pair"] in by_id:
            a, b = e["reference"], by_id[e["pair"]]["reference"]
            n = min(len(a), len(b))
            total += n
            agree += sum(x == y for x, y in zip(a[:n], b[:n]))
    meta = {"source": "HCS dataset (Eicher & Majid 2021), https://sites.google.com/view/chess-scoresheet-dataset",
            "pages": len(chosen), "dev": sum(e["split"] == "dev" for e in chosen),
            "test": sum(e["split"] == "test" for e in chosen),
            "reference_pair_agreement": round(agree / total, 4) if total else None,
            "reference_pair_plies": total}
    (OUT / "manifest.json").write_text(json.dumps({"meta": meta, "pages": chosen}, indent=1), encoding="utf-8")
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
