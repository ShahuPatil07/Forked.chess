"""
Build the Puzzle Themes index (data/puzzles/themes.db) from the full public
Lichess puzzle database.

One streaming pass over lichess_db_puzzle.csv.zst (~5.9M puzzles):
  - counts every theme / opening tag (the "Lichess has N puzzles" numbers),
  - keeps a stratified sample per (theme, rating band) so every theme -
    including rare ones like underPromotion or balestraMate - has puzzles at
    every level, preferring well-voted puzzles (popularity, plays, stable
    rating) and topping up from a relaxed pool only where a band is thin,
  - tags each kept puzzle with the Forked sub-themes from ml/puzzles/subthemes.py
    (knight/pawn/queen/royal forks, queen/exchange sacrifices, opposition,
    pawn breakthroughs, material endgames),
  - keeps a uniform "mix" sample and per-opening (family + variation) samples.

The result is plain SQLite (like the other caches) queried by
backend/puzzle_themes.py. Re-run any time; it rebuilds into a temp file and
swaps it in.

    python scripts/build_theme_index.py                 # uses data/raw/lichess_db_puzzle.csv.zst
    python scripts/build_theme_index.py --download      # fetch a fresh copy first
    python scripts/build_theme_index.py --per-band 150  # smaller index
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import random
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from ml.puzzles.subthemes import detect  # noqa: E402

SRC = ROOT / "data" / "raw" / "lichess_db_puzzle.csv.zst"
OUT = ROOT / "data" / "puzzles" / "themes.db"
URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"

BAND_EDGES = [700, 900, 1100, 1300, 1500, 1700, 1900, 2100, 2300, 2500, 2700]
DETECT_TRIGGERS = {"fork", "sacrifice", "pawnEndgame", "endgame"}
HIDDEN = {"checkFirst"}
MIN_VARIATION = 300          # a variation needs this many Lichess puzzles to be listed


def band(rating: int) -> int:
    for i, edge in enumerate(BAND_EDGES):
        if rating < edge:
            return i
    return len(BAND_EDGES)


class Reservoir:
    """Fixed-size uniform sample (Algorithm R)."""
    __slots__ = ("k", "seen", "items")

    def __init__(self, k: int):
        self.k, self.seen, self.items = k, 0, []

    def add(self, item, rng: random.Random) -> None:
        self.seen += 1
        if len(self.items) < self.k:
            self.items.append(item)
        else:
            j = rng.randrange(self.seen)
            if j < self.k:
                self.items[j] = item


def download(dest: Path) -> None:
    import requests
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    print(f"Downloading {URL} ...")
    with requests.get(URL, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done = 0
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
                done += len(chunk)
                if total:
                    print(f"\r  {done / total:6.1%}", end="", flush=True)
    print()
    tmp.replace(dest)


def stream_rows(src: Path):
    import zstandard as zstd
    with open(src, "rb") as fh:
        reader = io.TextIOWrapper(zstd.ZstdDecompressor().stream_reader(fh), encoding="utf-8")
        yield from csv.DictReader(reader)


def solver_color(fen: str) -> str:
    # The FEN is BEFORE the opponent's trigger move, so the solver is the other side.
    return "b" if fen.split()[1] == "w" else "w"


def build(src: Path, out: Path, per_band: int, mix_per_band: int, open_per_band: int,
          var_per_band: int, limit: int | None, seed: int) -> None:
    rng = random.Random(seed)
    lichess_count: Counter[str] = Counter()
    sub_count: Counter[str] = Counter()
    open_count: Counter[str] = Counter()
    strict: dict[tuple[str, int], Reservoir] = defaultdict(lambda: Reservoir(per_band))
    relaxed: dict[tuple[str, int], Reservoir] = defaultdict(lambda: Reservoir(per_band))
    mix: dict[int, Reservoir] = defaultdict(lambda: Reservoir(mix_per_band))
    fam_res: dict[tuple[str, int], Reservoir] = defaultdict(lambda: Reservoir(open_per_band))
    var_res: dict[tuple[str, int], Reservoir] = defaultdict(lambda: Reservoir(var_per_band))
    variation_family: dict[str, str] = {}

    t0 = time.time()
    n = 0
    for row in stream_rows(src):
        n += 1
        if limit and n > limit:
            break
        if n % 250_000 == 0:
            print(f"  {n:,} puzzles  {time.time() - t0:5.0f}s", flush=True)
        try:
            rating = int(row["Rating"])
            rd = int(row["RatingDeviation"])
            pop = int(row["Popularity"])
            plays = int(row["NbPlays"])
        except (KeyError, ValueError):
            continue
        themes = set(row["Themes"].split()) - HIDDEN
        for t in themes:
            lichess_count[t] += 1
        tags = row.get("OpeningTags", "").split()
        for t in tags:
            open_count[t] += 1
        if len(tags) >= 2:
            variation_family.setdefault(tags[1], tags[0])

        good = pop >= 50 and plays >= 100 and rd <= 100
        ok = pop >= 0 and plays >= 20 and rd <= 150
        if not ok:
            continue
        subs: set[str] | None = None
        if good and themes & DETECT_TRIGGERS:
            subs = detect(row["FEN"], row["Moves"], themes)
            for t in subs:
                sub_count[t] += 1
        item = (row["PuzzleId"], row["FEN"], row["Moves"], rating, rd, pop, plays,
                " ".join(sorted(themes)), row["GameUrl"], " ".join(tags[:2]),
                None if subs is None else " ".join(sorted(subs)))
        b = band(rating)
        pool = strict if good else relaxed
        for t in themes | (subs or set()):
            pool[(t, b)].add(item, rng)
        if good:
            mix[b].add(item, rng)
            if tags:
                fam_res[(tags[0], b)].add(item, rng)
                if len(tags) >= 2:
                    var_res[(tags[1], b)].add(item, rng)

    print(f"Read {n:,} puzzles in {time.time() - t0:.0f}s; selecting ...", flush=True)

    # theme -> puzzle ids, strict first then relaxed top-up per band
    chosen: dict[str, tuple] = {}
    theme_ids: dict[str, set[str]] = defaultdict(set)
    keys = {k for k in strict} | {k for k in relaxed}
    for (theme, b) in keys:
        picked = list(strict[(theme, b)].items) if (theme, b) in strict else []
        if len(picked) < per_band and (theme, b) in relaxed:
            picked += relaxed[(theme, b)].items[: per_band - len(picked)]
        for it in picked:
            chosen[it[0]] = it
            theme_ids[theme].add(it[0])
    for b, res in mix.items():
        for it in res.items:
            chosen[it[0]] = it
            theme_ids["mix"].add(it[0])
    for (tag, b), res in list(fam_res.items()) + list(var_res.items()):
        if tag in variation_family and open_count[tag] < MIN_VARIATION:
            continue                      # only well-populated variations get their own entry
        for it in res.items:
            chosen[it[0]] = it
            theme_ids[tag].add(it[0])

    # Detect sub-themes on kept puzzles that skipped detection (relaxed pool).
    print(f"Kept {len(chosen):,} puzzles; tagging sub-themes ...", flush=True)
    final: dict[str, tuple] = {}
    for pid, it in chosen.items():
        subs = it[10]
        if subs is None:
            subs = " ".join(sorted(detect(it[1], it[2], set(it[7].split()))))
        all_themes = " ".join(sorted(set(it[7].split()) | set(subs.split())))
        final[pid] = it[:7] + (all_themes, it[8], it[9], solver_color(it[1]), len(it[2].split()) - 1)

    # Tag every kept puzzle with ALL its themes and listed openings (not just the
    # sample it was drawn for), so "fork AND endgame" style combos and the local
    # counts are exact. "mix" stays the uniform sample.
    listed = {tag for tag in theme_ids if tag in open_count}
    mix_ids = theme_ids["mix"]
    theme_ids = defaultdict(set)
    for pid, p in final.items():
        tags = set(p[7].split()) | {t for t in p[9].split() if t in listed}
        if pid in mix_ids:
            tags.add("mix")
        for t in tags:
            theme_ids[t].add(pid)

    tmp = out.with_suffix(".tmp")
    if tmp.exists():
        tmp.unlink()
    out.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript("""
        CREATE TABLE puzzles (
            id TEXT PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL, rating INTEGER NOT NULL,
            rd INTEGER, popularity INTEGER, plays INTEGER, themes TEXT NOT NULL, game_url TEXT,
            opening TEXT, color TEXT NOT NULL, nply INTEGER NOT NULL);
        CREATE TABLE puzzle_theme (
            theme TEXT NOT NULL, rating INTEGER NOT NULL, color TEXT NOT NULL, id TEXT NOT NULL,
            PRIMARY KEY (theme, rating, id)) WITHOUT ROWID;   -- one b-tree serves theme + rating-band lookups
        CREATE TABLE theme_count (theme TEXT PRIMARY KEY, lichess INTEGER, local INTEGER, example_id TEXT);
        CREATE TABLE opening (key TEXT PRIMARY KEY, family TEXT NOT NULL, lichess INTEGER, local INTEGER);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    """)
    con.executemany("INSERT INTO puzzles VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", final.values())
    rows = []
    for theme, ids in theme_ids.items():
        for pid in ids:
            p = final[pid]
            rows.append((theme, p[3], p[10], pid))
    con.executemany("INSERT OR IGNORE INTO puzzle_theme VALUES (?,?,?,?)", rows)

    def example(ids: set[str]) -> str | None:
        """A well-loved mid-rated puzzle to draw on the theme card."""
        cands = [final[i] for i in ids if 1100 <= final[i][3] <= 1900] or [final[i] for i in ids]
        if not cands:
            return None
        return max(cands, key=lambda p: (p[5], min(p[6], 20000)))[0]

    counts = {**lichess_count, **sub_count}
    for theme, ids in theme_ids.items():
        if theme in open_count:
            continue
        # sub-themes are only detected on well-voted puzzles, so never report fewer than we hold
        lich = max(counts.get(theme, 0), len(ids))
        if theme == "mix":
            lich = n if not limit else min(n, limit)
        con.execute("INSERT INTO theme_count VALUES (?,?,?,?)", (theme, lich, len(ids), example(ids)))
    for tag, ids in theme_ids.items():
        if tag not in open_count:
            continue
        fam = variation_family.get(tag, tag)
        con.execute("INSERT INTO opening VALUES (?,?,?,?)", (tag, fam, open_count[tag], len(ids)))
    meta = {
        "built_at": time.strftime("%Y-%m-%d %H:%M"), "source": str(src.name),
        "source_puzzles": n if not limit else min(n, limit), "kept": len(final),
        "per_band": per_band, "band_edges": BAND_EDGES,
    }
    con.executemany("INSERT INTO meta VALUES (?,?)", [(k, json.dumps(v)) for k, v in meta.items()])
    con.commit()
    con.execute("VACUUM")
    con.close()
    tmp.replace(out)
    print(f"Wrote {out} - {len(final):,} puzzles, {len(theme_ids)} themes/openings "
          f"in {time.time() - t0:.0f}s")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=SRC)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--download", action="store_true", help="fetch a fresh lichess_db_puzzle.csv.zst first")
    ap.add_argument("--per-band", type=int, default=220, help="puzzles per (theme, rating band)")
    ap.add_argument("--mix-per-band", type=int, default=2000)
    ap.add_argument("--open-per-band", type=int, default=50)
    ap.add_argument("--var-per-band", type=int, default=10)
    ap.add_argument("--limit", type=int, default=None, help="only read the first N rows (testing)")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    if args.download or not args.src.exists():
        download(args.src)
    build(args.src, args.out, args.per_band, args.mix_per_band, args.open_per_band,
          args.var_per_band, args.limit, args.seed)


if __name__ == "__main__":
    main()
