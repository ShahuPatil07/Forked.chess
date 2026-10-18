"""Paced, resumable evaluation of the Coach agent → markdown report.

    python scripts/eval_coach_agent.py                 # run everything not yet done, then report
    python scripts/eval_coach_agent.py --gap 75        # seconds between turns (free-tier pacing)
    python scripts/eval_coach_agent.py --only conv-italian,easy-mate1
    python scripts/eval_coach_agent.py --report-only   # rebuild the report from results.jsonl

Free LLM tiers have per-minute AND per-day token caps. Turns are spaced by --gap
seconds; a turn that falls back to the engine-only answer (quota exhausted) is
retried after a long back-off instead of being scored. Results are appended per
case to reports/coach_eval/results.jsonl, so the run can be stopped and resumed.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import statistics
import sys
import time
import traceback
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

import chess  # noqa: E402

OUT = ROOT / "reports" / "coach_eval"
RESULTS = OUT / "results.jsonl"
DEFAULT_WORDS = {"simple": 120, "balanced": 200, "detailed": 320}
JARGON = ["outpost", "prophylaxis", "zwischenzug", "minority attack", "initiative", "tempo", "fianchetto",
          "isolani", "zugzwang", "opposition", "blockade", "pawn break", "weak square", "compensation",
          "counterplay", "luft", "desperado", "x-ray", "overload", "deflection", "decoy", "bishop pair",
          "space advantage", "pawn structure", "liquidat", "transpos"]
SAN_TOKEN = re.compile(r"(?<![\w/])(O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?)[+#!?]*(?![\w])")


def load_cases():
    spec = importlib.util.spec_from_file_location("coach_eval_cases", ROOT / "scripts" / "coach_eval_cases.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.CASES


def done_ids() -> set[str]:
    if not RESULTS.exists():
        return set()
    out = set()
    for line in RESULTS.read_text(encoding="utf-8").splitlines():
        try:
            rec = json.loads(line)
            if rec.get("status") == "done":
                out.add(rec["id"])
        except Exception:
            continue
    return out


# ── Running ───────────────────────────────────────────────────────────────────

def run_turn(case: dict, turn: dict, history: list[dict], fen: str) -> dict:
    from backend.coach.agent import run_agent, llm
    before = dict(llm.TOTALS)
    t0 = time.time()
    text, tools, steps, lines, boards, repairs = "", [], [], [], [], 0
    provider, final_fen, notes, error = "", fen, "", None
    try:
        for ev in run_agent(message=turn["msg"], history=history, fen=fen, level=case.get("level", ""),
                            style=case.get("style", "balanced"), review=case.get("review")):
            t = ev["type"]
            if t == "token":
                text += ev["text"]
            elif t == "tool_done":
                if ev["name"] == "verify":
                    repairs += 1
                else:
                    tools.append(ev["name"])
                steps.append(f"{ev['name']}: {ev.get('summary', '')}")
            elif t == "lines":
                lines = ev["lines"]
            elif t == "board":
                boards.append({"fen": ev["fen"], "label": ev["label"], "san": ev["line"]["san"]})
            elif t == "done":
                provider, final_fen, notes = ev.get("provider", ""), ev.get("fen", fen), ev.get("notes", "")
            elif t == "error":
                error = ev.get("message")
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
        traceback.print_exc()
    return {"msg": turn["msg"], "answer": text, "tools": tools, "steps": steps, "lines": lines, "boards": boards,
            "repairs": repairs, "provider": provider, "fen": final_fen, "notes": notes, "error": error,
            "seconds": round(time.time() - t0, 1),
            "tokens": {k: llm.TOTALS[k] - before.get(k, 0) for k in llm.TOTALS}}


def recommended_move(text: str, board: chess.Board) -> chess.Move | None:
    bold = re.findall(r"\*\*([^*]+)\*\*", text)
    first_sentence = re.split(r"(?<=[.!?])\s", text.strip(), maxsplit=1)[0]
    for chunk in bold + [first_sentence, text[:400]]:
        for tok in SAN_TOKEN.findall(chunk):
            try:
                return board.parse_san(tok)
            except ValueError:
                continue
    return None


def best_move_check(text: str, fen: str) -> dict:
    from backend.coach.agent import engine as E
    board = chess.Board(fen)
    mv = recommended_move(text, board)
    if mv is None:
        return {"ok": False, "detail": "no recommended legal move found"}
    top = E.top_lines(fen, 3, depth=20, seconds=4.0)
    best = top[0]
    line = E.move_line(fen, mv.uci(), depth=20, seconds=3.0)
    b_pov, m_pov = best["eval"].pov(board.turn), line["eval"].pov(board.turn)
    if best["eval"].mate is not None or line["eval"].mate is not None:
        ok = (best["eval"].mate is not None and line["eval"].mate is not None
              and (best["eval"].mate > 0) == (line["eval"].mate > 0)) or mv.uci() == best["move_uci"]
        loss = None
    else:
        loss = max(0, b_pov - m_pov)
        ok = loss <= 30
    return {"ok": bool(ok), "recommended": board.san(mv), "engine_best": best["move_san"],
            "loss_cp": loss, "detail": f"{board.san(mv)} vs best {best['move_san']} ({best['eval'].short()})"}


def score_turn(case: dict, turn: dict, rec: dict, prev: dict | None) -> dict:
    from backend.coach.agent.verify import check_answer
    text = rec["answer"]
    words = len(text.split())
    checks: dict[str, dict] = {}
    flags = re.I | re.S
    if turn.get("expect_any"):
        hits = [p for p in turn["expect_any"] if re.search(p, text, flags)]
        checks["expect_any"] = {"ok": bool(hits), "detail": f"matched {hits}" if hits else f"none of {turn['expect_any']}"}
    if turn.get("expect_all"):
        miss = [p for p in turn["expect_all"] if not re.search(p, text, flags)]
        checks["expect_all"] = {"ok": not miss, "detail": f"missing {miss}" if miss else "all present"}
    if turn.get("forbid"):
        bad = [p for p in turn["forbid"] if re.search(p, text, flags)]
        checks["forbid"] = {"ok": not bad, "detail": f"forbidden {bad}" if bad else "clean"}
    if turn.get("expect_tools"):
        ok = any(t in rec["tools"] for t in turn["expect_tools"])
        checks["tools"] = {"ok": ok, "detail": f"used {rec['tools']}"}
    limit = turn.get("max_words") or DEFAULT_WORDS.get(case.get("style", "balanced"), 200)
    checks["length"] = {"ok": words <= limit * 1.15, "detail": f"{words} words (budget {limit})"}
    if turn.get("best_check"):
        try:
            checks["best_move"] = best_move_check(text, rec["fen"])
        except Exception as exc:
            checks["best_move"] = {"ok": False, "detail": f"check failed: {exc}"}
    # Residual grounding problems in the FINAL answer (after the agent's own repair round).
    fens = {rec["fen"]} | {f for line in rec["lines"] for f in line.get("fens", [])}
    sans = {s.rstrip("+#") for line in rec["lines"] for s in line.get("san", [])}
    issues = check_answer(text, fens, sans) if rec["tools"] else []
    checks["grounding"] = {"ok": not issues, "detail": "; ".join(issues)[:300] or "clean"}
    fu = turn.get("followup")
    if fu == "simpler" and prev:
        pw = len(prev["answer"].split())
        moves = len(SAN_TOKEN.findall(text))
        checks["simpler"] = {"ok": words <= pw and moves <= 6, "detail": f"{words} words vs previous {pw}; {moves} move tokens"}
    if fu == "deeper" and prev:
        checks["deeper"] = {"ok": len(SAN_TOKEN.findall(text)) >= 3 or words > len(prev["answer"].split()),
                            "detail": f"{words} words, {len(SAN_TOKEN.findall(text))} move tokens"}
    if fu == "memory":
        first = case["_answers"][0] if case.get("_answers") else ""
        board = chess.Board(case["fen"])
        mv = recommended_move(first, board)
        san = board.san(mv) if mv else None
        checks["memory"] = {"ok": bool(san and san.rstrip("+#") in text), "detail": f"first recommendation {san}"}
    if rec["error"] or rec["provider"] in ("", "fallback"):
        checks["answered"] = {"ok": False, "detail": rec["error"] or f"provider={rec['provider']}"}
    return {"words": words, "checks": checks, "passed": all(c["ok"] for c in checks.values())}


def run(args):
    from backend.coach.agent import llm
    import backend.main  # noqa: F401  (Stockfish singleton)
    OUT.mkdir(parents=True, exist_ok=True)
    cases = load_cases()
    if args.only:
        wanted = set(args.only.split(","))
        cases = [c for c in cases if c["id"] in wanted]
    skip = done_ids()
    todo = [c for c in cases if c["id"] not in skip]
    print(f"[{datetime.now():%H:%M:%S}] {len(todo)} cases to run ({sum(len(c['turns']) for c in todo)} turns); "
          f"chain={llm.chain()}", flush=True)
    for ci, case in enumerate(todo, 1):
        history: list[dict] = []
        turns_out = []
        case["_answers"] = []
        fen = case["fen"]
        for ti, turn in enumerate(case["turns"]):
            for attempt in range(args.retries + 1):
                rec = run_turn(case, turn, history, fen)
                if rec["provider"] not in ("fallback", "") and not rec["error"]:
                    break
                wait = args.backoff * (1 + min(attempt, 3))
                print(f"  quota/error on {case['id']}#{ti} ({rec['error'] or rec['provider']}); sleeping {wait // 60} min", flush=True)
                time.sleep(wait)
            prev = turns_out[-1]["record"] if turns_out else None
            score = score_turn(case, turn, rec, prev)
            turns_out.append({"turn": turn, "record": rec, "score": score})
            case["_answers"].append(rec["answer"])
            history += [{"role": "user", "content": turn["msg"]},
                        {"role": "assistant", "content": rec["answer"], "notes": rec["notes"], "fen": rec["fen"]}]
            fen = rec["fen"] or fen
            status = "PASS" if score["passed"] else "FAIL " + ",".join(k for k, v in score["checks"].items() if not v["ok"])
            print(f"[{datetime.now():%H:%M:%S}] ({ci}/{len(todo)}) {case['id']}#{ti} {status} · {rec['seconds']}s · "
                  f"{rec['provider']} · tools={rec['tools']}", flush=True)
            time.sleep(args.gap)
        with RESULTS.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"id": case["id"], "category": case["category"], "level": case.get("level"),
                                 "status": "done", "finished": datetime.now().isoformat(timespec="seconds"),
                                 "turns": turns_out}, ensure_ascii=False) + "\n")
    build_report()


# ── Report ────────────────────────────────────────────────────────────────────

def pct(a, b):
    return f"{100 * a / b:.0f}%" if b else "–"


def build_report():
    if not RESULTS.exists():
        print("no results yet")
        return
    recs = {}
    for line in RESULTS.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
            recs[r["id"]] = r     # last write wins (re-runs)
        except Exception:
            continue
    order = {c["id"]: i for i, c in enumerate(load_cases())}
    cases = sorted(recs.values(), key=lambda r: order.get(r["id"], 999))
    turns = [(c, t) for c in cases for t in c["turns"]]
    n = len(turns)
    check_tot, check_ok = Counter(), Counter()
    by_cat = defaultdict(list)
    providers = Counter()
    tokens = Counter()
    for c, t in turns:
        by_cat[c["category"]].append(t)
        providers[t["record"]["provider"]] += 1
        for k, v in t["record"]["tokens"].items():
            tokens[k] += v
        for k, v in t["score"]["checks"].items():
            check_tot[k] += 1
            check_ok[k] += int(v["ok"])
    passed = sum(t["score"]["passed"] for _, t in turns)
    secs = [t["record"]["seconds"] for _, t in turns]
    tool_counts = [len(t["record"]["tools"]) for _, t in turns]
    repairs = sum(t["record"]["repairs"] for _, t in turns)

    md = [f"# Forked Coach — automated evaluation report",
          "", f"_Generated {datetime.now():%Y-%m-%d %H:%M} from `{RESULTS.relative_to(ROOT)}` — {len(cases)} conversations, {n} turns._", "",
          "## Headline numbers", "",
          "| Metric | Value |", "|---|---|",
          f"| Turns passing every automated check | **{passed}/{n} ({pct(passed, n)})** |",
          f"| Engine best-move agreement (≤0.30 pawns) | {check_ok['best_move']}/{check_tot['best_move']} ({pct(check_ok['best_move'], check_tot['best_move'])}) |",
          f"| Final answers with zero grounding issues | {check_ok['grounding']}/{check_tot['grounding']} ({pct(check_ok['grounding'], check_tot['grounding'])}) |",
          f"| Expected content present (any / all) | {pct(check_ok['expect_any'], check_tot['expect_any'])} / {pct(check_ok['expect_all'], check_tot['expect_all'])} |",
          f"| Forbidden (false) claims avoided | {check_ok['forbid']}/{check_tot['forbid']} ({pct(check_ok['forbid'], check_tot['forbid'])}) |",
          f"| Correct tool chosen when one was required | {check_ok['tools']}/{check_tot['tools']} ({pct(check_ok['tools'], check_tot['tools'])}) |",
          f"| Within length budget | {pct(check_ok['length'], check_tot['length'])} |",
          f"| Follow-up checks (simpler / deeper / memory) | {check_ok['simpler']}/{check_tot['simpler']} · {check_ok['deeper']}/{check_tot['deeper']} · {check_ok['memory']}/{check_tot['memory']} |",
          f"| Verifier repair rounds triggered | {repairs} ({pct(repairs, n)} of turns) |",
          f"| Latency median / p90 | {statistics.median(secs):.1f}s / {sorted(secs)[int(0.9 * (n - 1))]:.1f}s |" if secs else "| Latency | – |",
          f"| Tool calls per turn (mean) | {statistics.mean(tool_counts):.2f} |" if tool_counts else "",
          f"| LLM calls / prompt tokens / completion tokens | {tokens['calls']} / {tokens['prompt_tokens']:,} / {tokens['completion_tokens']:,} |",
          f"| Answers by model | {', '.join(f'{k or 'none'}: {v}' for k, v in providers.most_common())} |",
          "", "## By category", "",
          "| Category | Turns | Pass | Best-move | Grounded | Expected content | Avg words | Avg s |", "|---|---|---|---|---|---|---|---|"]
    for cat, ts in by_cat.items():
        def rate(key):
            tot = sum(1 for t in ts if key in t["score"]["checks"])
            ok = sum(1 for t in ts if t["score"]["checks"].get(key, {}).get("ok"))
            return pct(ok, tot) if tot else "–"
        exp_tot = sum(1 for t in ts for k in ("expect_any", "expect_all") if k in t["score"]["checks"])
        exp_ok = sum(1 for t in ts for k in ("expect_any", "expect_all") if t["score"]["checks"].get(k, {}).get("ok"))
        md.append(f"| {cat} | {len(ts)} | {pct(sum(t['score']['passed'] for t in ts), len(ts))} | {rate('best_move')} | "
                  f"{rate('grounding')} | {pct(exp_ok, exp_tot) if exp_tot else '–'} | "
                  f"{statistics.mean(t['score']['words'] for t in ts):.0f} | {statistics.mean(t['record']['seconds'] for t in ts):.1f} |")
    # Level adaptation
    md += ["", "## Adaptation to player level (same questions, four audiences)", "",
           "| Level | Answers | Avg words | Jargon terms / 100 words | Move tokens / 100 words |", "|---|---|---|---|---|"]
    lv = defaultdict(list)
    for c, t in turns:
        if c["category"] == "player_level":
            lv[c["level"]].append(t["record"]["answer"])
    for level in ["Under 800", "800-1200", "1200-1600", "1600-2000"]:
        answers = lv.get(level, [])
        if not answers:
            continue
        w = [max(1, len(a.split())) for a in answers]
        jar = [sum(a.lower().count(j) for j in JARGON) * 100 / x for a, x in zip(answers, w)]
        mv = [len(SAN_TOKEN.findall(a)) * 100 / x for a, x in zip(answers, w)]
        md.append(f"| {level} | {len(answers)} | {statistics.mean(w):.0f} | {statistics.mean(jar):.1f} | {statistics.mean(mv):.1f} |")
    md += ["", "## Failed checks", ""]
    for c, t in turns:
        bad = {k: v for k, v in t["score"]["checks"].items() if not v["ok"]}
        if bad:
            md.append(f"- **{c['id']}** — _{t['turn']['msg'][:80]}_")
            for k, v in bad.items():
                md.append(f"  - `{k}`: {v['detail']}")
    md += ["", "Full transcripts: [`transcripts.md`](transcripts.md).", ""]
    (OUT / "report_auto.md").write_text("\n".join(x for x in md if x is not None), encoding="utf-8")

    tr = ["# Forked Coach evaluation — transcripts", ""]
    for c in cases:
        tr.append(f"## {c['id']}  ·  {c['category']}  ·  level {c.get('level')}")
        for i, t in enumerate(c["turns"]):
            r, s = t["record"], t["score"]
            tr.append(f"\n**User:** {t['turn']['msg'][:600]}\n")
            tr.append(f"**Coach** ({r['provider']}, {r['seconds']}s, tools: {', '.join(r['tools']) or 'none'}"
                      f"{', repaired' if r['repairs'] else ''}):\n")
            tr.append("> " + (r["answer"] or "(no answer)").replace("\n", "\n> "))
            tr.append("\n_Checks:_ " + "; ".join(f"{'✅' if v['ok'] else '❌'} {k} ({v['detail']})" for k, v in s["checks"].items()))
            if r["steps"]:
                tr.append("\n_Tool trace:_ " + " | ".join(r["steps"])[:900])
        tr.append("\n---\n")
    (OUT / "transcripts.md").write_text("\n".join(tr), encoding="utf-8")
    print(f"report → {OUT / 'report_auto.md'}  ({passed}/{n} turns passed)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--gap", type=int, default=75, help="seconds between turns")
    ap.add_argument("--backoff", type=int, default=900, help="seconds to wait when the free quota is exhausted")
    ap.add_argument("--retries", type=int, default=12)
    ap.add_argument("--only", default="")
    ap.add_argument("--report-only", action="store_true")
    a = ap.parse_args()
    if a.report_only:
        build_report()
    else:
        run(a)
    # The backend import leaves Stockfish and background threads alive; exit cleanly.
    sys.stdout.flush()
    import os
    os._exit(0)
