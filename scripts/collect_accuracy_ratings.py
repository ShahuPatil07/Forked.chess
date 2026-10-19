#!/usr/bin/env python
"""
Collect (player rating, Chess.com stored accuracy) pairs from the public
Published-Data API, spread across the rating range, for calibrating the Game
Review "game rating" estimate (accuracy -> rating at which that accuracy is typical).

Only documented PubAPI endpoints are used (player archives list + monthly
archives), serially, with a delay and the project User-Agent. Starting from a
few seed accounts it walks to opponents at the low and high ends of what it has
seen, so the sample covers beginners to masters. No engine work is needed: each
archived game already carries both players' ratings and (when the game was
reviewed) both accuracies.

    python scripts/collect_accuracy_ratings.py --max-requests 120
Writes data/bench/accuracy_rating_pairs.json
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests

from ml.config import DATA_DIR, REQUEST_HEADERS

API = "https://api.chess.com/pub/player"
OUT = DATA_DIR / "bench" / "accuracy_rating_pairs.json"
GAMES_OUT = DATA_DIR / "bench" / "accuracy_games.json"   # PGNs of accuracy-bearing games (--save-pgn)
SEEDS = ["ShahuPatil27", "semilore17", "MinnowMate", "sambartiquel", "Pilkification", "jukkasunset"]
BANDS = list(range(400, 3001, 200))


def _get(url: str):
    r = requests.get(url, headers=REQUEST_HEADERS, timeout=30)
    if r.status_code == 429:
        time.sleep(30)
        r = requests.get(url, headers=REQUEST_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-requests", type=int, default=120)
    ap.add_argument("--months", type=int, default=2, help="recent monthly archives per player")
    ap.add_argument("--time-class", default="rapid")
    ap.add_argument("--save-pgn", action="store_true", help="also keep PGNs (for accuracy calibration)")
    args = ap.parse_args()
    rng = random.Random(3)

    pairs: dict[str, dict] = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    saved: dict[str, dict] = json.loads(GAMES_OUT.read_text(encoding="utf-8")) if GAMES_OUT.exists() else {}
    done: set[str] = set()
    queue = list(SEEDS)
    band_count = {b: 0 for b in BANDS}
    requests_made = 0
    try:
        top = _get("https://api.chess.com/pub/leaderboards").get("live_rapid", [])[:15]
        queue += [p["username"] for p in top]
        requests_made += 1
    except Exception:
        pass

    while queue and requests_made < args.max_requests:
        user = queue.pop(0)
        if user.lower() in done:
            continue
        done.add(user.lower())
        try:
            archives = _get(f"{API}/{user.lower()}/games/archives").get("archives", [])
            requests_made += 1
        except Exception:
            continue
        seen_opps: list[tuple[int, str]] = []
        for url in reversed(archives[-args.months:]):
            if requests_made >= args.max_requests:
                break
            time.sleep(0.6)
            try:
                games = _get(url).get("games", [])
                requests_made += 1
            except Exception:
                continue
            for g in games:
                if g.get("rules") != "chess" or g.get("time_class") != args.time_class or not g.get("rated", True):
                    continue
                for side in ("white", "black"):
                    p = g.get(side, {})
                    if p.get("username"):
                        seen_opps.append((p.get("rating") or 0, p["username"]))
                acc = g.get("accuracies")
                if acc and args.save_pgn and g.get("pgn") and g.get("uuid") not in saved:
                    saved[g["uuid"]] = {"pgn": g["pgn"], "accuracies": acc, "url": g.get("url"),
                                        "white_rating": g["white"].get("rating"), "black_rating": g["black"].get("rating")}
                if not acc or g.get("uuid") in pairs:
                    continue
                w, b = g["white"].get("rating"), g["black"].get("rating")
                pairs[g["uuid"]] = {"white_rating": w, "black_rating": b,
                                    "white_acc": acc.get("white"), "black_acc": acc.get("black"),
                                    "plies": g.get("pgn", "").count(".")}
                for r in (w, b):
                    if r:
                        band = max(b0 for b0 in BANDS if b0 <= max(400, min(3000, r)))
                        band_count[band] += 1
        # walk toward under-sampled rating bands: queue the opponents nearest to them
        if seen_opps:
            sparse = sorted(BANDS, key=lambda b: band_count[b])[:3]
            for band in sparse:
                cands = sorted(seen_opps, key=lambda ro: abs(ro[0] - (band + 100)))[:3]
                queue.extend(u for _, u in cands if u.lower() not in done)
            rng.shuffle(queue)
        print(f"{requests_made:>3} requests | {user:<18} | pairs {len(pairs):>5} | sparse bands {sorted(BANDS, key=lambda b: band_count[b])[:3]}", flush=True)
        OUT.write_text(json.dumps(pairs), encoding="utf-8")
        if args.save_pgn:
            GAMES_OUT.write_text(json.dumps(saved), encoding="utf-8")

    OUT.write_text(json.dumps(pairs), encoding="utf-8")
    if args.save_pgn:
        GAMES_OUT.write_text(json.dumps(saved), encoding="utf-8")
        print("saved PGNs:", len(saved))
    print("band counts:", {b: c for b, c in band_count.items() if c})


if __name__ == "__main__":
    main()
