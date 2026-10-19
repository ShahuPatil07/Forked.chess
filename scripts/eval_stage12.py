#!/usr/bin/env python
"""
Stage-1 / Stage-2 evaluation harness: legacy (pre-v2) vs v2, on identical data.

  E1  classifier on 40K held-out Lichess puzzles (v1 test split, never trained on)
  E2  END-TO-END Stage 1 on held-out REAL-GAME blunders (the games the puzzles
      came from): does the pipeline name the tactic the blunder allowed / missed?
      Ablations separate the framing fix, the retrain and the verifier.
  E3  noise & hygiene on the benchmark accounts' games (same engine annotations)
  E4  profile reliability: split-half stability of the family ranking
  E5  predictive validity: does the profile built on older games predict where
      the next games' points are lost? (labels fixed -> isolates Stage-2 scoring)
  E6  gold set: accuracy vs your own hand labels (data/gold/<user>_gold.json)

    python scripts/eval_stage12.py --e1 --e2 --bench --gold     # or --all
Writes reports/stage12_eval/*.json and summary.md.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chess
import chess.engine
import numpy as np

from ml.config import DATA_DIR
from ml.classifier import label_map_v2 as v2
from ml.clustering.families import family_of, UNCLASSIFIED, FAMILIES

OUT = ROOT / "reports" / "stage12_eval"
PROC = DATA_DIR / "processed"
BENCH = DATA_DIR / "bench"
TACTICAL = list(FAMILIES.keys())


def _save(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(obj, indent=2, default=str), encoding="utf-8")


def _load(name: str):
    p = OUT / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def _predictors():
    from ml.classifier.transformer.predict import Predictor, V1_CKPT, V1_REF, V2_CKPT, V2_REF
    p1 = Predictor(V1_CKPT, V1_REF)
    p2 = Predictor(V2_CKPT, V2_REF) if V2_CKPT.exists() else None
    return p1, p2


def _truth(classes: list[str]) -> tuple[set, set]:
    threats = v2.threats_of(classes)
    return threats, {family_of(t) for t in threats}


# ═════════════════════════════════════════════════════════════════════════════
# E1 — classifier on held-out puzzles
# ═════════════════════════════════════════════════════════════════════════════

def run_e1() -> dict:
    from ml.classifier.label_map import ML_LICHESS_CLASSES, ML_CLASS_TO_THREAT
    from ml.classifier.transformer.train_mt import to_batch
    import torch
    d = dict(np.load(PROC / "mt_oldtest.npz"))
    y = d["labels"].astype(bool)
    truth_threats = [v2.threats_of([v2.MOTIF_CLASSES[j] for j in np.flatnonzero(r)]) for r in y]
    keep = np.array([bool(t) for t in truth_threats])
    p1, p2 = _predictors()
    res = {"n": int(keep.sum())}

    def run(pred, name):
        threats, raw_acc = [], []
        with torch.no_grad():
            for s in range(0, len(y), 512):
                idx = np.arange(s, min(s + 512, len(y)))
                logits = pred.model.head(pred.model.encode(to_batch(d, idx)))
                if pred.multilabel:
                    probs = torch.sigmoid(logits / pred.temperature).numpy()
                    core = probs.copy()
                    for m in list(v2.MODIFIERS) + ["none"]:
                        core[:, v2.CLASS_INDEX[m]] = -1
                    top = core.argmax(1)
                    threats += [v2.CLASS_TO_THREAT[v2.MOTIF_CLASSES[i]] or "other" for i in top]
                else:
                    top = logits.argmax(1).numpy()
                    threats += [ML_CLASS_TO_THREAT[ML_LICHESS_CLASSES[i]] for i in top]
                    raw_acc += list(top == d["v1_label"][idx])
        motif = [t in tt for t, tt, k in zip(threats, truth_threats, keep) if k]
        fam = [family_of(t) in {family_of(x) for x in tt} for t, tt, k in zip(threats, truth_threats, keep) if k]
        per_fam = defaultdict(list)
        for t, tt, k in zip(threats, truth_threats, keep):
            if k:
                for f in {family_of(x) for x in tt}:
                    per_fam[f].append(family_of(t) == f)
        out = {"motif_hit1": round(float(np.mean(motif)), 4), "family_hit1": round(float(np.mean(fam)), 4),
               "family_recall": {f: round(float(np.mean(v)), 3) for f, v in sorted(per_fam.items())}}
        if raw_acc:
            out["v1_definition_accuracy"] = round(float(np.mean(raw_acc)), 4)
        res[name] = out

    run(p1, "v1")
    if p2 is not None:
        run(p2, "v2")
    _save("e1_classifier.json", res)
    return res


# ═════════════════════════════════════════════════════════════════════════════
# E2 — end-to-end Stage 1 on held-out real-game blunders
# ═════════════════════════════════════════════════════════════════════════════

def _rec(board, info):
    from ml.ingestion.annotator import _record
    return _record(board, info, 16)


def _e2_engine(engine, row):
    try:
        raw = chess.Board(row["raw_fen"])
        after = raw.copy(); after.push(chess.Move.from_uci(row["moves"][0]))
        out = {"before": _rec(raw, engine.analyse(raw, chess.engine.Limit(depth=16)))}
        infos = engine.analyse(after, chess.engine.Limit(depth=16), multipv=2)
        infos = infos if isinstance(infos, list) else [infos]
        out["after"] = _rec(after, infos[0])
        if len(infos) > 1 and infos[1].get("pv"):
            m2 = infos[1]["pv"][0]
            b2 = after.copy(); b2.push(m2)
            sc = infos[1]["score"].pov(after.turn)
            cp2 = (30_000 if (sc.mate() or 0) > 0 else -30_000) if sc.is_mate() else (sc.score() or 0)
            out["second"] = {"move": m2.uci(), "cp": cp2,
                             "after": _rec(b2, engine.analyse(b2, chess.engine.Limit(depth=14)))
                             if not b2.is_game_over() else {"cp": 0, "mate": None, "pv": [], "d": 99}}
        return out
    except Exception as exc:
        return {"error": str(exc)}


def _mk_event(board_before, played, best_line, reply_line, cp_before, cp_after, mate_before,
              mate_after_opp, prev_board=None, prev_move=""):
    from ml.ingestion.mechanism import tag_mechanism
    from ml.ingestion.mistake_extractor import MistakeEvent
    from ml.ingestion.winprob import expected_score
    es_b, es_a = expected_score(cp_before), expected_score(cp_after)
    mech = tag_mechanism(board_before, best_line, played, reply_line, mate_before, mate_after_opp,
                         prev_board=prev_board, es_before=es_b, es_after=es_a)
    after = board_before.copy(); after.push(chess.Move.from_uci(played))
    return MistakeEvent(
        game_id="e2", user_id="", fen=board_before.fen(), move_played_uci=played, move_played_san="",
        best_move_uci=best_line[0] if best_line else "", eval_before_cp=cp_before, eval_after_cp=cp_after,
        eval_drop_cp=max(0, cp_before - cp_after), threat_type="other", game_phase="middlegame",
        time_remaining_ms=None, move_number=20, fen_after=after.fen(), best_line=best_line,
        reply_line=reply_line, refutation_uci=reply_line[0] if reply_line else "",
        es_before=es_b, es_after=es_a, es_loss=max(0.0, es_b - es_a),
        direction=mech.direction, swing_missed_cp=mech.swing_missed_cp,
        swing_allowed_cp=mech.swing_allowed_cp, mate_missed=mech.mate_missed, mate_allowed=mech.mate_allowed,
        prev_fen=prev_board.fen() if prev_board is not None else "", prev_move_uci=prev_move,
    )


def run_e2(n: int = 1500, workers: int = 5) -> dict:
    from ml.classifier.verifier import verify
    from ml.ingestion.classify_events import classify_events
    from ml.ingestion.engine_pool import EnginePool
    rows = [json.loads(l) for l in open(PROC / "e2_realgame.jsonl", encoding="utf-8")][:n]
    cache_p = PROC / "e2_engine.json"
    cache = json.loads(cache_p.read_text(encoding="utf-8")) if cache_p.exists() else {}
    todo = [r for r in rows if r["puzzle_id"] not in cache]
    if todo:
        print(f"E2: analysing {len(todo)} real-game positions with Stockfish...", flush=True)
        with EnginePool(workers=workers) as pool:
            for r, res in zip(todo, pool.map(_e2_engine, todo)):
                cache[r["puzzle_id"]] = res
        cache_p.write_text(json.dumps(cache), encoding="utf-8")

    p1, p2 = _predictors()
    allowed, missed = [], []
    for r in rows:
        eng = cache.get(r["puzzle_id"], {})
        if "after" not in eng:
            continue
        t_threats, t_fams = _truth(r["classes"])
        if not t_threats:
            continue
        raw = chess.Board(r["raw_fen"])
        puzzle = raw.copy(); puzzle.push(chess.Move.from_uci(r["moves"][0]))
        b, a = eng["before"], eng["after"]
        ev = _mk_event(raw, r["moves"][0], b["pv"], a["pv"], b["cp"], -a["cp"],
                       b["mate"] if (b["mate"] or 0) > 0 else None, a["mate"] if (a["mate"] or 0) > 0 else None)
        if ev.es_loss >= 0.10:
            allowed.append((r, ev, t_threats, t_fams, (raw.fen(), b["pv"][0] if b["pv"] else "")))
        s = eng.get("second")
        if s and a["pv"]:
            ev2 = _mk_event(puzzle, s["move"], a["pv"], s["after"]["pv"], a["cp"], s["cp"],
                            a["mate"] if (a["mate"] or 0) > 0 else None,
                            s["after"]["mate"] if (s["after"]["mate"] or 0) > 0 else None, prev_board=raw,
                            prev_move=r["moves"][0])
            if ev2.es_loss >= 0.10:
                missed.append((r, ev2, t_threats, t_fams, (puzzle.fen(), a["pv"][0])))

    def legacy_preds(items):
        out = p1.predict_many([x[4][0] for x in items], [x[4][1] for x in items])
        preds, j = [], 0
        for k in range(len(items)):
            if not out["keep"][k]:
                preds.append("other"); continue
            preds.append("other" if bool(out["is_positional"][j]) else out["threat_type"][j]); j += 1
        return preds

    def new_preds(items, pred, use_ver):
        import copy
        evs = [copy.deepcopy(x[1]) for x in items]
        classify_events(evs, [], pred, use_verifier=use_ver)
        return [e.threat_type for e in evs], evs

    def score(items, preds):
        fam = [family_of(p) in x[3] for p, x in zip(preds, items)]
        mot = [p in x[2] for p, x in zip(preds, items)]
        unc = [family_of(p) == UNCLASSIFIED for p in preds]
        return {"n": len(items), "family_hit1": round(float(np.mean(fam)), 4) if fam else None,
                "motif_hit1": round(float(np.mean(mot)), 4) if mot else None,
                "unclassified_rate": round(float(np.mean(unc)), 4) if unc else None}

    report: dict = {}
    for name, items, expect in (("allowed", allowed, ("allowed", "both")), ("missed", missed, ("missed", "both"))):
        sec = {"direction_detected": round(float(np.mean([x[1].direction in expect for x in items])), 4)
               if items else None,
               "direction_dist": dict(Counter(x[1].direction for x in items).most_common())}
        sec["legacy_v1_before_best"] = score(items, legacy_preds(items))
        sec["v2stage1_v1model"] = score(items, new_preds(items, p1, False)[0])
        sec["v2stage1_v1model_verifier"] = score(items, new_preds(items, p1, True)[0])
        if p2 is not None:
            sec["v2stage1_v2model"] = score(items, new_preds(items, p2, False)[0])
            preds, evs = new_preds(items, p2, True)
            sec["v2stage1_v2model_verifier (production)"] = score(items, preds)
        report[name] = sec

    # Verifier precision with ENGINE lines (production condition), allowed framing.
    tp, fp = Counter(), Counter()
    for r, ev, t_threats, t_fams, _ in allowed:
        truth = set(r["classes"]) | ({"mate"} if "backRankMate" in r["classes"] else set())
        found = verify(chess.Board(ev.fen_after), ev.reply_line, last_move=ev.move_played_uci,
                       prev_board=chess.Board(ev.fen))
        for c in found:
            (tp if c in truth else fp)[c] += 1
    prec = {c: round(tp[c] / (tp[c] + fp[c]), 3) for c in set(tp) | set(fp) if tp[c] + fp[c] >= 25}
    report["verifier_precision_engine_lines"] = {c: {"precision": prec.get(c), "fired": tp[c] + fp[c]}
                                                 for c in sorted(set(tp) | set(fp))}
    _save("verifier_precision.json", prec)
    _save("e2_realgame.json", report)
    return report


# ═════════════════════════════════════════════════════════════════════════════
# E3 / E4 / E5 — benchmark accounts
# ═════════════════════════════════════════════════════════════════════════════

def _unix(ts):
    if not ts:
        return None
    return int(ts // 1000) if ts > 1e10 else int(ts)


def _legacy_events(user: str, games: list[dict], p1, maia) -> list:
    from ml.ingestion.annotator import annotate_game
    from ml.eval.legacy import legacy_extract, legacy_classify, legacy_maia_filter
    evs = []
    for g in games:
        try:
            anns = annotate_game(g["pgn"], None, game_id=g["game_id"], increment_s=g.get("increment_s") or 0)
        except Exception:
            continue
        evs += legacy_extract(anns, g, g["user_color"], _unix(g.get("played_at")))
    legacy_classify(evs, p1)
    return legacy_maia_filter(evs, maia)


def _rank(x):
    order = np.argsort(x, kind="mergesort")
    r = np.empty(len(x)); r[order] = np.arange(len(x))
    for v in set(x):                               # average ties
        m = np.array(x) == v
        r[m] = r[m].mean()
    return r


def _spearman(a, b) -> float:
    a, b = np.asarray(a, float), np.asarray(b, float)
    if a.std() == 0 or b.std() == 0:
        return float("nan")
    ra, rb = _rank(list(a)), _rank(list(b))
    return float(np.corrcoef(ra, rb)[0, 1])


def _vec(rows: list[dict], key: str = "score") -> list[float]:
    by = {r["family"]: r.get(key, 0.0) or 0.0 for r in rows}
    return [by.get(f, 0.0) for f in TACTICAL]


def _profile_new(mistakes, peers, opps, exposure, games):
    from ml.clustering.profile import build_profile
    gs = set(games)
    sel = lambda xs: [x for x in xs if x["game_id"] in gs]
    return build_profile(sel(mistakes), "u", sel(peers), sel(opps), [x for x in exposure if x["game_id"] in gs])["families"]


def _profile_legacy(events, games):
    from ml.eval.legacy_profile import build_profile as legacy_build
    gs = set(games)
    return legacy_build([e for e in events if e.game_id in gs], "u")["families"]


def _as_events(dicts):
    from ml.ingestion.mistake_extractor import MistakeEvent
    fields = MistakeEvent.__dataclass_fields__
    return [MistakeEvent(**{k: v for k, v in d.items() if k in fields}) for d in dicts]


def _cost_by_family(mistakes, exposure_moves: float, games: set) -> dict:
    """Held-out target: expected score lost per 100 moves, per family (incidents, top family)."""
    cost = defaultdict(float)
    for m in mistakes:
        if m["game_id"] in games and not m.get("cascade"):
            fp = m.get("family_probs") or {family_of(m["threat_type"]): 1.0}
            cost[max(fp, key=fp.get)] += m.get("es_loss", 0.0)
    return {f: cost[f] * 100.0 / max(exposure_moves, 1) for f in TACTICAL}


def _ndcg2(pred_scores, true_scores) -> float:
    order = np.argsort(-np.asarray(pred_scores))[:2]
    ideal = np.sort(np.asarray(true_scores))[::-1][:2]
    dcg = sum(true_scores[i] / math.log2(k + 2) for k, i in enumerate(order))
    idcg = sum(v / math.log2(k + 2) for k, v in enumerate(ideal))
    return float(dcg / idcg) if idcg > 0 else float("nan")


def run_bench(splits: int = 30) -> dict:
    from scripts.run_stage12_bench import BENCH_USERS
    try:
        from ml.ingestion.maia_annotator import MaiaAnnotator
        maia = MaiaAnnotator()
    except Exception:
        maia = None
    p1, _ = _predictors()
    rng = random.Random(0)
    report = {"users": {}, "e4": {}, "e5": {}}
    e4 = defaultdict(lambda: defaultdict(list))
    e5 = defaultdict(lambda: defaultdict(list))

    for user, _plat, _n in BENCH_USERS:
        gp = BENCH / f"{user}_games.json"
        mp = BENCH / f"{user}_mistakes.json"
        if not gp.exists() or not mp.exists():
            print(f"  skip {user}: run scripts/run_stage12_bench.py first")
            continue
        games = json.loads(gp.read_text(encoding="utf-8"))
        rd = lambda s: json.loads((BENCH / f"{user}_{s}.json").read_text(encoding="utf-8"))
        new_m, peers, opps, exposure = rd("mistakes"), rd("peer_mistakes"), rd("opportunities"), rd("exposure")
        legacy = _legacy_events(user, games, p1, maia)
        new_ev = _as_events(new_m)
        gids = [x["game_id"] for x in sorted(exposure, key=lambda x: x.get("played_at_unix") or 0)]

        # ── E3: noise & hygiene ──────────────────────────────────────────────
        leg_es = [e.es_loss for e in legacy]
        overlap = len({(e.game_id, e.ply) for e in legacy} & {(m["game_id"], m["ply"]) for m in new_m})
        report["users"][user] = {
            "games": len(gids),
            "legacy": {
                "mistakes": len(legacy),
                "below_lichess_inaccuracy (<5% ES)": round(float(np.mean([x < 0.05 for x in leg_es])), 3) if leg_es else None,
                "below_lichess_mistake (<10% ES)": round(float(np.mean([x < 0.10 for x in leg_es])), 3) if leg_es else None,
                "labelled_opening": round(float(np.mean([e.game_phase == "opening" for e in legacy])), 3) if legacy else None,
                "unclassified": round(float(np.mean([e.cluster_id == UNCLASSIFIED for e in legacy])), 3) if legacy else None,
                "families": dict(Counter(e.cluster_id for e in legacy).most_common()),
            },
            "v2": {
                "mistakes": len(new_m),
                "incidents": sum(1 for m in new_m if not m.get("cascade")),
                "cascades_merged": sum(1 for m in new_m if m.get("cascade")),
                "labelled_opening": round(float(np.mean([m["game_phase"] == "opening" for m in new_m])), 3) if new_m else None,
                "unclassified": round(float(np.mean([m["cluster_id"] == UNCLASSIFIED for m in new_m])), 3) if new_m else None,
                "direction": dict(Counter(m["direction"] for m in new_m).most_common()),
                "families": dict(Counter(m["cluster_id"] for m in new_m).most_common()),
                "peer_mistakes": len(peers), "opportunities": len(opps),
            },
            "overlap_events": overlap,
        }

        # ── E4: split-half stability ─────────────────────────────────────────
        for _ in range(splits):
            g = gids[:]; rng.shuffle(g)
            A, B = g[: len(g) // 2], g[len(g) // 2:]
            for variant, fn in (
                ("legacy_labels+legacy_scoring", lambda G: _profile_legacy(legacy, G)),
                ("v2_labels+legacy_scoring", lambda G: _profile_legacy(new_ev, G)),
                ("v2_labels+v2_scoring", lambda G: _profile_new(new_m, peers, opps, exposure, G)),
            ):
                va, vb = _vec(fn(A)), _vec(fn(B))
                rho = _spearman(va, vb)
                if not math.isnan(rho):
                    e4[variant]["spearman"].append(rho)
                e4[variant]["top1_agree"].append(float(np.argmax(va) == np.argmax(vb)))

        # ── E5: predictive validity (labels fixed to v2) ─────────────────────
        moves_of = {x["game_id"]: x for x in exposure}
        for cut in (0.5, 0.6, 0.7, 0.8):
            tr = gids[: int(len(gids) * cut)]
            te = gids[int(len(gids) * cut): int(len(gids) * (cut + 0.2))]
            if len(te) < 10:
                continue
            te_set = set(te)
            u_moves = sum(moves_of[g]["user_moves"] for g in te)
            o_moves = sum(moves_of[g]["opp_moves"] for g in te)
            cost = _cost_by_family(new_m, u_moves, te_set)
            pcost = _cost_by_family(peers, o_moves, te_set)
            target_cost = [cost[f] for f in TACTICAL]
            target_excess = [cost[f] - pcost[f] for f in TACTICAL]
            for variant, rows in (("legacy_scoring", _profile_legacy(new_ev, tr)),
                                  ("v2_scoring", _profile_new(new_m, peers, opps, exposure, tr))):
                s = _vec(rows)
                for tname, tgt in (("future_cost", target_cost), ("future_excess_vs_peers", target_excess)):
                    rho = _spearman(s, tgt)
                    if not math.isnan(rho):
                        e5[f"{variant}"][f"spearman_{tname}"].append(rho)
                    e5[variant][f"top1_in_true_top2_{tname}"].append(
                        float(int(np.argmax(s)) in set(np.argsort(-np.asarray(tgt))[:2])))
                e5[variant]["ndcg2_future_cost"].append(_ndcg2(s, target_cost))
        print(f"  bench {user}: legacy {len(legacy)} / v2 {len(new_m)} mistakes", flush=True)

    agg = lambda d: {v: {k: round(float(np.nanmean(x)), 3) for k, x in m.items()} | {"n": len(next(iter(m.values())))}
                     for v, m in d.items()}
    report["e4"] = agg(e4)
    report["e5"] = agg(e5)
    _save("bench.json", report)
    return report


# ═════════════════════════════════════════════════════════════════════════════
# E6 — gold set
# ═════════════════════════════════════════════════════════════════════════════

_HUMAN_DIR = {"walked_into": "allowed", "ignored_threat": "allowed", "missed": "missed",
              "both": "both", "quiet": "quiet"}


def run_gold() -> dict:
    """data/gold/<user>_items.json (from build_gold_set.py) + <user>_labels.json
    ({item id: {direction, family, note}}, exported from the labelling page)."""
    gold_dir = DATA_DIR / "gold"
    report = {}
    p1 = None
    for lp in sorted(gold_dir.glob("*_labels.json")) if gold_dir.exists() else []:
        user = lp.name[: -len("_labels.json")]
        items = json.loads((gold_dir / f"{user}_items.json").read_text(encoding="utf-8"))
        labels = json.loads(lp.read_text(encoding="utf-8"))
        items = [it for it in items if labels.get(it["id"], {}).get("direction")]
        if not items:
            continue
        if p1 is None:
            p1, _ = _predictors()
        v2_rows = {(m["game_id"], m["ply"]): m for m in
                   json.loads((BENCH / f"{user}_mistakes.json").read_text(encoding="utf-8"))}
        leg_items = [it for it in items if it["_source"] in ("legacy", "both")]
        out = p1.predict_many([it["fen"] for it in leg_items], [it["best_uci"] for it in leg_items])
        legacy_pred, j = {}, 0
        for k, it in enumerate(leg_items):
            if out["keep"][k]:
                t = "other" if bool(out["is_positional"][j]) else out["threat_type"][j]; j += 1
                legacy_pred[it["id"]] = family_of(t)
        for it in items:
            lab = labels[it["id"]]
            it["human_dir"] = _HUMAN_DIR.get(lab["direction"])
            it["human_family"] = lab.get("family") if lab.get("family") not in (None, "unsure") else None
            it["not_mistake"] = lab["direction"] == "not_a_mistake"
            it["legacy_family"] = legacy_pred.get(it["id"])
            v = v2_rows.get((it["_game_id"], it["_ply"]))
            it["v2_family"] = v["cluster_id"] if v else None
            it["v2_dir"] = v["direction"] if v else None
            it["v2_attached"] = [f["family"] for f in (v.get("description") or {}).get("families", [])] if v else None

        def acc(rows, key):
            rows = [r for r in rows if r[key] is not None]
            return (round(float(np.mean([r[key] == r["human_family"] for r in rows])), 3), len(rows)) if rows else (None, 0)

        fam_rows = [it for it in items if it["human_family"] and it["human_dir"] in ("allowed", "missed", "both")]
        common = [it for it in fam_rows if it["_source"] == "both"]
        res = {"labelled": len(items)}
        for name, rows in (("all_flagged", fam_rows), ("flagged_by_both", common)):
            for pipe in ("legacy_family", "v2_family"):
                a, n = acc(rows, pipe)
                res[f"{pipe}_accuracy_{name}"] = a
                res[f"{pipe}_n_{name}"] = n
        att = [it for it in fam_rows if it["v2_attached"] is not None]
        res["v2_human_family_among_attached"] = round(float(np.mean([it["human_family"] in it["v2_attached"] for it in att])), 3) if att else None
        res["v2_mean_families_attached"] = round(float(np.mean([len(it["v2_attached"]) for it in att])), 2) if att else None
        res["v2_flags_legacy_only_items_now"] = round(float(np.mean([it["v2_family"] is not None for it in items if it["_source"] == "legacy"])), 3)
        dirs = [it for it in items if it["v2_dir"] and it["human_dir"]]
        res["v2_direction_accuracy"] = round(float(np.mean([it["v2_dir"] == it["human_dir"] for it in dirs])), 3) if dirs else None
        res["v2_direction_n"] = len(dirs)
        for src in ("legacy", "both", "v2"):
            sub = [it for it in items if it["_source"] == src]
            if sub:
                res[f"not_a_mistake_share[{src}-flagged]"] = round(float(np.mean([it["not_mistake"] for it in sub])), 3)
        report[user] = res
    _save("e6_gold.json", report)
    return report


# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════

def _pct(x) -> str:
    return "—" if x is None else f"{x * 100:.1f}%"


def write_summary() -> str:
    L = ["# Stage 1 / Stage 2 evaluation — legacy vs v2", ""]
    e1 = _load("e1_classifier.json")
    if e1:
        L += ["## E1 — classifier on held-out Lichess puzzles", "",
              f"{e1['n']:,} puzzles from the v1 test split (neither model trained on them). "
              "Hit = the predicted motif / family is one of the puzzle's Lichess themes.", "",
              "| | v1 (83.1% model) | v2 |", "|---|---|---|"]
        for k, name in (("motif_hit1", "Motif hit@1"), ("family_hit1", "Family hit@1")):
            L.append(f"| {name} | {_pct(e1['v1'][k])} | {_pct(e1.get('v2', {}).get(k))} |")
        if "v1_definition_accuracy" in e1["v1"]:
            L.append(f"| v1's own single-label accuracy | {_pct(e1['v1']['v1_definition_accuracy'])} | n/a |")
        L.append("")
    e2 = _load("e2_realgame.json")
    if e2:
        L += ["## E2 — end-to-end Stage 1 on held-out real-game blunders", "",
              "Real game positions behind held-out puzzles. *Allowed*: the player's blunder allowed the "
              "puzzle tactic. *Missed*: the player then failed to find it (second-best move). "
              "Score = the pipeline's family is one of the tactic's families.", ""]
        rows = [k for k in e2["allowed"] if isinstance(e2["allowed"][k], dict) and "family_hit1" in e2["allowed"][k]]
        L += ["| Pipeline | Allowed: family right | Allowed: unclassified | Missed: family right |", "|---|---|---|---|"]
        for k in rows:
            a, m = e2["allowed"][k], e2["missed"].get(k, {})
            L.append(f"| {k} | {_pct(a['family_hit1'])} | {_pct(a['unclassified_rate'])} | {_pct(m.get('family_hit1'))} |")
        L += ["", f"Direction detected correctly: allowed {_pct(e2['allowed']['direction_detected'])}, "
                  f"missed {_pct(e2['missed']['direction_detected'])} (n = {e2['allowed'][rows[0]]['n']} / "
                  f"{e2['missed'][rows[0]]['n']}).", ""]
    b = _load("bench.json")
    if b:
        L += ["## E3 — noise & hygiene on benchmark accounts (identical engine annotations)", "",
              "| Account | Legacy mistakes | …of which <10% win-chance loss | Legacy 'opening' | v2 mistakes | v2 incidents | v2 'opening' | Legacy unclassified | v2 unclassified |",
              "|---|---|---|---|---|---|---|---|---|"]
        for u, r in b["users"].items():
            lg, nv = r["legacy"], r["v2"]
            L.append(f"| {u} | {lg['mistakes']} | {_pct(lg['below_lichess_mistake (<10% ES)'])} | {_pct(lg['labelled_opening'])} | "
                     f"{nv['mistakes']} | {nv['incidents']} | {_pct(nv['labelled_opening'])} | {_pct(lg['unclassified'])} | {_pct(nv['unclassified'])} |")
        L += ["", "## E4 — split-half stability of the family ranking", "",
              "Games split randomly in half 30× per account; Spearman correlation of the 5 family scores between halves.", "",
              "| Variant | Spearman | Same #1 family |", "|---|---|---|"]
        for v, m in b["e4"].items():
            L.append(f"| {v} | {m.get('spearman', float('nan')):.3f} | {_pct(m.get('top1_agree'))} |")
        L += ["", "## E5 — predictive validity (labels fixed to v2, so this isolates Stage-2 scoring)", "",
              "Profile from older games vs the next 20% of games, 4 cut points per account.", "",
              "| Scoring | Spearman vs future points lost | NDCG@2 | #1 family in future top-2 | Spearman vs future excess over peers |",
              "|---|---|---|---|---|"]
        for v, m in b["e5"].items():
            L.append(f"| {v} | {m.get('spearman_future_cost', float('nan')):.3f} | {m.get('ndcg2_future_cost', float('nan')):.3f} | "
                     f"{_pct(m.get('top1_in_true_top2_future_cost'))} | {m.get('spearman_future_excess_vs_peers', float('nan')):.3f} |")
        L.append("")
    g = _load("e6_gold.json")
    if g:
        L += ["## E6 — gold set (your labels)", ""]
        for k, r in g.items():
            L.append(f"- **{k}**: " + ", ".join(f"{a} = {v}" for a, v in r.items()))
        L.append("")
    text = "\n".join(L)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "summary.md").write_text(text, encoding="utf-8")
    return text


# ═════════════════════════════════════════════════════════════════════════════

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--e1", action="store_true")
    ap.add_argument("--e2", action="store_true")
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--gold", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--e2-n", type=int, default=1500)
    ap.add_argument("--workers", type=int, default=5)
    args = ap.parse_args()
    t0 = time.time()
    if args.e1 or args.all:
        print("E1", json.dumps(run_e1(), indent=1), flush=True)
    if args.e2 or args.all:
        print("E2", json.dumps(run_e2(args.e2_n, args.workers), indent=1), flush=True)
    if args.bench or args.all:
        r = run_bench()
        print("E3", json.dumps(r["users"], indent=1)); print("E4", json.dumps(r["e4"], indent=1))
        print("E5", json.dumps(r["e5"], indent=1), flush=True)
    if args.gold or args.all:
        print("E6", json.dumps(run_gold(), indent=1))
    print(write_summary())
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
