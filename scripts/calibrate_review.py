#!/usr/bin/env python
"""
Calibrate Game Review against real data and write backend/review_calibration.json.

  1. Expected points (move classification). Chess.com converts an engine eval
     into expected points with a human, rating-aware model; its 0.02/0.05/0.10/
     0.20 bands are defined on that scale. Stockfish's own WDL model is fitted
     on ENGINE games and is far steeper. We fit a logistic E = 1/(1+exp(-k cp))
     to real game RESULTS from the benchmark games (cached evals), optionally
     with k depending on the mover's rating.
  2. Accuracy. Chess.com's PubAPI stores the accuracy of reviewed games. We
     compute review-consistent evals for those games and fit per-move and
     aggregation formulas, reporting held-out error against the stored values.
  3. Game rating. From (rating, stored accuracy) pairs across the rating range
     (scripts/collect_accuracy_ratings.py) we fit the typical accuracy at each
     rating; the game rating is the rating at which an accuracy is typical
     (rating-independent, like Chess.com's announced new Game Rating).

    python scripts/calibrate_review.py [--workers 6]
"""
from __future__ import annotations

import argparse
import io
import json
import math
import random
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chess
import chess.engine
import chess.pgn
import numpy as np
from scipy.optimize import minimize

from ml.config import DATA_DIR
from ml.ingestion import annotation_cache

BENCH = DATA_DIR / "bench"
OUT = ROOT / "backend" / "review_calibration.json"
REPORT = ROOT / "reports" / "game_review_eval"
EVAL_CACHE = BENCH / "review_evals.json"
STANDARD = dict(nodes=80000, depth=18, time=3)
PER_BAND = 25


# ───────────────────────────── shared helpers ───────────────────────────────

def lichess_win(cp: float | None, mate: int | None) -> float:
    if mate is not None:
        return 100.0 if mate > 0 else 0.0
    return 100 / (1 + math.exp(-0.00368208 * max(-10000, min(10000, cp or 0))))


def bench_games() -> list[dict]:
    games = []
    for p in sorted(BENCH.glob("*_games.json")):
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, list):            # frozen per-account lists only (not accuracy_games.json)
            games += data
    return games


def _boards(pgn: str) -> list[chess.Board]:
    game = chess.pgn.read_game(io.StringIO(pgn))
    b = game.board(); out = [b.copy()]
    for mv in game.mainline_moves():
        b.push(mv); out.append(b.copy())
    return out


# ─────────────────────── 1. expected points from results ───────────────────

def fit_expected_points() -> dict:
    xs, ys, rs = [], [], []
    for g in bench_games():
        recs = (annotation_cache.get(g["game_id"]) or {}).get("recs")
        res = g.get("result")
        if not recs or res is None:
            continue
        white_score = res if g["user_color"] == "white" else 1 - res
        for ply, r in enumerate(recs):
            if ply < 8 or r.get("mate") is not None or abs(r["cp"]) > 1200:
                continue
            white_to_move = ply % 2 == 0
            mover_score = white_score if white_to_move else 1 - white_score
            elo = g.get("white_elo") if white_to_move else g.get("black_elo")
            if elo:
                xs.append(r["cp"]); ys.append(mover_score); rs.append(elo)
    x, y, r = np.array(xs, float), np.array(ys, float), np.array(rs, float)

    def nll(params, rating_aware):
        k = params[0] + (params[1] * (r - 1600) / 400 if rating_aware else 0)
        p = 1 / (1 + np.exp(-np.clip(k, 1e-4, 0.05) * x))
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))

    flat = minimize(lambda p: nll(p, False), [0.004, 0.0], method="Nelder-Mead")
    aware = minimize(lambda p: nll(p, True), [0.004, 0.0], method="Nelder-Mead")
    lichess = nll([0.00368208, 0.0], False)
    return {"positions": int(len(x)), "rating_range": [int(r.min()), int(r.max())],
            "k_flat": round(float(flat.x[0]), 6), "nll_flat": round(float(flat.fun), 5),
            "k0": round(float(aware.x[0]), 6), "k_per_400": round(float(aware.x[1]), 6),
            "nll_rating_aware": round(float(aware.fun), 5), "nll_lichess": round(float(lichess), 5)}


# ───────────────────── 2. accuracy vs Chess.com stored values ──────────────

def _eval_game(engine, item):
    gid, pgn = item
    out = []
    for b in _boards(pgn):
        if b.is_game_over():
            out.append({"cp": 0 if not b.is_checkmate() else None, "mate": 0 if b.is_checkmate() else None})
            continue
        info = engine.analyse(b, chess.engine.Limit(**STANDARD))
        sc = info["score"].pov(b.turn)
        out.append({"cp": sc.score(), "mate": sc.mate()})
    return gid, out


def review_evals(targets: dict, games: dict, workers: int) -> dict:
    cache = json.loads(EVAL_CACHE.read_text(encoding="utf-8")) if EVAL_CACHE.exists() else {}
    todo = [(gid, games[gid]["pgn"]) for gid in targets if gid in games and gid not in cache]
    if todo:
        from ml.ingestion.engine_pool import EnginePool
        print(f"  computing review-budget evals for {len(todo)} games...", flush=True)
        with EnginePool(workers=workers) as pool:
            for gid, ev in pool.map(_eval_game, todo):
                cache[gid] = ev
        EVAL_CACHE.write_text(json.dumps(cache), encoding="utf-8")
    return cache


def move_losses(pgn: str, evals: list[dict], book: set) -> list[dict]:
    """Per move: mover, win% loss (Lichess curve), whether book / forced / decided."""
    boards = _boards(pgn)
    game = chess.pgn.read_game(io.StringIO(pgn))
    moves = list(game.mainline_moves())
    rows, in_book = [], True
    for i, mv in enumerate(moves):
        b = boards[i]
        e0, e1 = evals[i], evals[i + 1]
        w_before = lichess_win(e0["cp"], e0["mate"])
        if e1["mate"] == 0:                       # mover delivered mate
            w_after = 100.0
        elif e1["mate"] is None and e1["cp"] == 0 and boards[i + 1].is_game_over():
            w_after = 50.0
        else:
            w_after = 100 - lichess_win(e1["cp"], e1["mate"])
        in_book = in_book and (b.epd(), mv.uci()) in book
        rows.append({"white": b.turn == chess.WHITE, "loss": max(0.0, w_before - w_after),
                     "w_white": w_after if b.turn == chess.WHITE else 100 - w_after,
                     "book": in_book, "forced": b.legal_moves.count() == 1})
    return rows


def per_move(loss, A, k, B):
    return np.clip(A * np.exp(-k * loss) + B, 0, 100)


def game_accuracy(d: dict, params: dict, model: str):
    """Vectorised game accuracy for one target (precomputed loss / weights / masks)."""
    keep = np.ones(len(d["loss"]), bool)
    if params.get("skip_book"):
        keep &= ~d["book"]
    if params.get("skip_forced"):
        keep &= ~d["forced"]
    if not keep.any():
        return None
    acc = per_move(d["loss"][keep], params["A"], params["k"], params["B"])
    if model == "lichess":
        w = d["w"][keep]
        weighted = float((acc * w).sum() / w.sum())
        harmonic = float(len(acc) / np.sum(1 / np.maximum(acc, 0.01)))
        return float(np.clip((weighted + harmonic) / 2 + params.get("b", 0), 0, 100))
    f, p = params["f"], params["p"]
    a = np.maximum(acc, f)
    pm = float(np.exp(np.mean(np.log(a)))) if abs(p) < 1e-3 else float(np.mean(a ** p) ** (1 / p))
    return float(np.clip(pm + params["b"], 0, 100))


def fit_accuracy(targets: dict, games: dict, evals: dict, book: set) -> dict:
    data = []
    for gid, t in targets.items():
        if gid not in evals or gid not in games:
            continue
        rows = move_losses(games[gid]["pgn"], evals[gid], book)
        traj = [r["w_white"] for r in rows]
        window = max(2, min(8, len(rows) // 10))
        vol = [max(0.5, min(12, statistics.pstdev(traj[max(0, i - window + 1):i + 1]) if i else 0.5)) for i in range(len(rows))]
        for side in ("white", "black"):
            if t["accuracies"].get(side) is not None:
                idx = [i for i, r in enumerate(rows) if r["white"] == (side == "white")]
                data.append({"gid": gid, "rows": rows, "white": side == "white", "y": float(t["accuracies"][side]),
                             "rating": t.get(f"{side}_rating"),
                             "loss": np.array([rows[i]["loss"] for i in idx]), "w": np.array([vol[i] for i in idx]),
                             "book": np.array([rows[i]["book"] for i in idx], bool),
                             "forced": np.array([rows[i]["forced"] for i in idx], bool)})
    gids = sorted({d["gid"] for d in data})
    random.Random(7).shuffle(gids)
    test_ids = set(gids[: max(1, len(gids) * 3 // 10)])
    train = [d for d in data if d["gid"] not in test_ids]
    test = [d for d in data if d["gid"] in test_ids]

    def metrics(ds, params, model):
        pred = np.array([game_accuracy(d, params, model) or 0 for d in ds], float)
        y = np.array([d["y"] for d in ds])
        err = pred - y
        return {"n": len(ds), "mae": round(float(np.mean(np.abs(err))), 2), "bias": round(float(np.mean(err)), 2),
                "within_3": round(float(np.mean(np.abs(err) <= 3)), 3), "within_5": round(float(np.mean(np.abs(err) <= 5)), 3),
                "corr": round(float(np.corrcoef(pred, y)[0, 1]), 3)}

    results = {}
    current = {"A": 103.1668, "k": 0.04354, "B": -3.1669, "b": 0.0}
    results["current_production (Lichess formula)"] = {"params": current, "model": "lichess",
                                                         "train": metrics(train, current, "lichess"),
                                                         "test": metrics(test, current, "lichess")}
    best = None
    for model in ("lichess", "power"):
        for skip_book in (False, True):
            for skip_forced in (False, True):
                def loss_fn(v):
                    if model == "lichess":
                        params = {"A": v[0], "k": abs(v[1]), "B": v[2], "b": v[3]}
                    else:
                        params = {"A": v[0], "k": abs(v[1]), "B": v[2], "f": max(0.5, v[3]), "p": v[4], "b": v[5]}
                    params.update(skip_book=skip_book, skip_forced=skip_forced)
                    pred = np.array([game_accuracy(d, params, model) or 0 for d in train])
                    return float(np.mean(np.abs(pred - np.array([d["y"] for d in train]))))
                x0 = [103.17, 0.0435, -3.17, 0.0] if model == "lichess" else [103.17, 0.0435, -3.17, 5.0, 0.5, 0.0]
                res = minimize(loss_fn, x0, method="Nelder-Mead", options={"maxiter": 3000, "xatol": 1e-4, "fatol": 1e-3})
                v = res.x
                params = ({"A": v[0], "k": abs(v[1]), "B": v[2], "b": v[3]} if model == "lichess" else
                          {"A": v[0], "k": abs(v[1]), "B": v[2], "f": max(0.5, v[3]), "p": v[4], "b": v[5]})
                params.update(skip_book=skip_book, skip_forced=skip_forced)
                params = {k2: (round(float(x), 6) if isinstance(x, (float, np.floating)) else x) for k2, x in params.items()}
                tr = metrics(train, params, model)
                name = f"fitted_{model}{'_nobook' if skip_book else ''}{'_noforced' if skip_forced else ''}"
                results[name] = {"params": params, "model": model, "train": tr, "test": metrics(test, params, model)}
                if best is None or tr["mae"] < results[best]["train"]["mae"]:
                    best = name
    by_band = {}
    for name in (best, "current_production (Lichess formula)"):
        v = results[name]
        bands: dict[str, list] = {}
        for d in test:
            if d.get("rating"):
                lo = int(d["rating"] // 400 * 400)
                bands.setdefault(f"{lo}-{lo + 399}", []).append(d)
        by_band[name] = {b: metrics(ds, v["params"], v["model"]) for b, ds in sorted(bands.items()) if len(ds) >= 8}
    return {"variants": results, "chosen": best, "train_games": len({d['gid'] for d in train}),
            "test_games": len(test_ids), "test_by_rating_band": by_band}


# ─────────────────────────── 3. game rating curve ───────────────────────────

def fit_rating_curve() -> dict:
    p = BENCH / "accuracy_rating_pairs.json"
    if not p.exists():
        return {}
    pairs = json.loads(p.read_text(encoding="utf-8"))
    pts = [(v[f"{s}_rating"], v[f"{s}_acc"]) for v in pairs.values() for s in ("white", "black")
           if v.get(f"{s}_rating") and v.get(f"{s}_acc") is not None]
    r = np.array([a for a, _ in pts], float); acc = np.array([b for _, b in pts], float)
    bins = np.arange(400, 3001, 100)
    table = []
    for lo in bins:
        m = (r >= lo) & (r < lo + 100)
        if m.sum() >= 15:
            table.append({"rating": int(lo + 50), "median_acc": round(float(np.median(acc[m])), 2),
                          "p25": round(float(np.percentile(acc[m], 25)), 2), "p75": round(float(np.percentile(acc[m], 75)), 2),
                          "n": int(m.sum())})
    # monotone smoothing of the medians (pool-adjacent-violators)
    med = [t["median_acc"] for t in table]
    blocks = [[v, 1] for v in med]
    i = 0
    while i < len(blocks) - 1:
        if blocks[i][0] > blocks[i + 1][0]:
            v = (blocks[i][0] * blocks[i][1] + blocks[i + 1][0] * blocks[i + 1][1]) / (blocks[i][1] + blocks[i + 1][1])
            blocks[i] = [v, blocks[i][1] + blocks[i + 1][1]]; del blocks[i + 1]; i = max(0, i - 1)
        else:
            i += 1
    smooth = [v for v, n in blocks for _ in range(n)]
    for t, s in zip(table, smooth):
        t["typical_acc"] = round(float(s), 2)
    return {"pairs": len(pts), "table": table}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()
    REPORT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()

    print("1. expected points vs real results...", flush=True)
    ep = fit_expected_points(); print("  ", ep, flush=True)

    print("2. accuracy vs Chess.com stored accuracies...", flush=True)
    targets = json.loads((BENCH / "chesscom_accuracies.json").read_text(encoding="utf-8"))
    games = {g["game_id"]: g for g in bench_games()}
    # Games across the rating range (scripts/collect_accuracy_ratings.py --save-pgn),
    # stratified: up to PER_BAND games per 200-point band of the average rating.
    extra_p = BENCH / "accuracy_games.json"
    if extra_p.exists():
        per_band: dict[int, int] = {}
        extra = json.loads(extra_p.read_text(encoding="utf-8"))
        for gid in sorted(extra, key=lambda k: random.Random(k).random()):
            g = extra[gid]
            if gid in targets or not g.get("white_rating") or not g.get("black_rating"):
                continue
            band = int((g["white_rating"] + g["black_rating"]) / 2 // 200 * 200)
            if per_band.get(band, 0) >= PER_BAND:
                continue
            per_band[band] = per_band.get(band, 0) + 1
            targets[gid] = {"accuracies": g["accuracies"], "white_rating": g["white_rating"], "black_rating": g["black_rating"]}
            games[gid] = {"game_id": gid, "pgn": g["pgn"]}
        print("   rating-spread games added per band:", dict(sorted(per_band.items())), flush=True)
    evals = review_evals(targets, games, args.workers)
    from backend.game_review import opening_book
    book, _ = opening_book()
    acc = fit_accuracy(targets, games, evals, book)
    for name, v in acc["variants"].items():
        print(f"   {name:<40} train MAE {v['train']['mae']:>5}  test MAE {v['test']['mae']:>5}  test within3 {v['test']['within_3']}  corr {v['test']['corr']}")
    print("   chosen:", acc["chosen"], flush=True)
    for name, bands in acc["test_by_rating_band"].items():
        print("   by band —", name)
        for b, m in bands.items():
            print(f"      {b:<10} n {m['n']:>3}  MAE {m['mae']:>5}  within3 {m['within_3']}  bias {m['bias']}")

    print("3. game rating curve...", flush=True)
    rc = fit_rating_curve(); print("   pairs", rc.get("pairs"), "bins", len(rc.get("table", [])), flush=True)

    chosen = acc["variants"][acc["chosen"]]
    calib = {
        "version": "forked-review-v2",
        "expected_points": {"k0": ep["k0"], "k_per_400": ep["k_per_400"], "k_flat": ep["k_flat"],
                            "fit_rating_range": ep["rating_range"], "positions": ep["positions"]},
        "accuracy": {"model": chosen["model"], **chosen["params"],
                     "fit": {"train": chosen["train"], "test": chosen["test"], "target": "Chess.com stored accuracy (PubAPI)"}},
        "rating_curve": rc.get("table", []),
    }
    OUT.write_text(json.dumps(calib, indent=2), encoding="utf-8")
    (REPORT / "calibration.json").write_text(json.dumps({"expected_points": ep, "accuracy": acc, "rating_curve": rc}, indent=2),
                                             encoding="utf-8")
    print(f"wrote {OUT} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
