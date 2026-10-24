"""
Evaluate scoresheet -> PGN on the frozen HCS benchmark (scripts/build_scoresheet_bench.py).

    python scripts/eval_scoresheets.py --split test                       # all variants
    python scripts/eval_scoresheets.py --split dev --variants new-full    # quick tuning loop

Variants (reader | move resolution):
  old            previous production: old prompt + right-half crop pass | greedy corrector
  old+decoder    old prompt reads                                       | beam decoder   (ablation)
  new-full+old   new literal prompt, one pass                           | greedy corrector (ablation)
  new-full       new literal prompt, one pass                           | beam decoder
  new-tiles      one pass per table column                              | beam decoder
  new-ensemble   full pass + column passes, merged as alternatives      | beam decoder
  pipeline       new-ensemble + targeted multiple-choice re-read of doubtful cells, re-decoded
                 (backend/scoresheet_pipeline.py -- exactly what the API runs)

Model calls are cached in data/raw/ocr_cache, so re-running after a decoder change costs
nothing. Writes reports/scoresheet_eval/{summary.md,results.json}.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import sys
import time
from pathlib import Path

import chess
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from backend import scoresheet_reader as rd  # noqa: E402
from backend.scoresheet_decoder import cells_from_rows, decode, norm_reading  # noqa: E402
from backend.scoresheet_prior import move_logprobs  # noqa: E402

BENCH = ROOT / "data" / "bench" / "scoresheets"
OUT = ROOT / "reports" / "scoresheet_eval"
VARIANTS = ["old", "old+decoder", "new-full+old", "new-full", "new-tiles", "new-ensemble", "pipeline"]

# ── frozen baseline: the previous production prompts (backend/scoresheet.py before the
#    reader/decoder rewrite), kept here so "old" stays reproducible ──

_VLM_PROMPT = (
    "You are transcribing a chess scoresheet. Read EVERY move from the WHOLE sheet "
    "and return ONLY a JSON object of this exact shape:\n"
    '{"moves":[{"number":1,"white":"e4","black":"e5"},'
    '{"number":2,"white":"Nf3","black":"Nc6"}]}\n'
    "CRITICAL LAYOUT — most scoresheets have TWO side-by-side tables. The LEFT "
    "table holds the lower move numbers (e.g. 1-30) and the RIGHT table CONTINUES "
    "the SAME game with the higher move numbers (e.g. 31-60). You MUST read BOTH "
    "tables. Do NOT stop at the bottom of the left table — keep going into the "
    "right table until the moves run out. Each row is: number, White's move, "
    "Black's move.\n"
    "Notation rules: standard algebraic notation (SAN) with NO spaces inside a "
    "move; a capture is written like 'Qxc7' or 'exd5' (lowercase destination "
    "file, no space around the 'x'); piece letters are uppercase K Q R B N; "
    "square files are lowercase a-h; castling is O-O or O-O-O; if a cell is blank "
    "or unreadable use an empty string \"\"; ignore the header, player names, "
    "date, result and signatures. Output JSON only, no prose, no markdown fences."
)

_VLM_PROMPT_CROP = (
    "This image is ONE table cropped from a chess scoresheet — the RIGHT-HAND "
    "table that CONTINUES the same game. Columns are: move number, White's move, "
    "Black's move. The first data row is move number {start}, and the rows count "
    "UP from there ({start}, {next}, {next2}, ...).\n"
    "Transcribe EVERY row from top to bottom — there can be many rows. Do NOT "
    "stop after the first row. Go down the whole table until the rows become "
    "blank, then stop. Keep the printed move numbers.\n"
    "Return ONLY JSON: "
    '{{"moves":[{{"number":{start},"white":"...","black":"..."}},'
    '{{"number":{next},"white":"...","black":"..."}}]}}. '
    "Notation: SAN, no spaces, lowercase destination files, captures like Qxc7, "
    "castling O-O / O-O-O; a blank or unreadable cell = \"\". JSON only."
)

def _parse_moves_json(text: str) -> list[dict]:
    """Pull the moves array out of the model's response, tolerating stray prose."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        return []
    try:
        obj = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return []
    out: list[dict] = []
    for i, m in enumerate(obj.get("moves", []), start=1):
        if not isinstance(m, dict):
            continue
        white = (m.get("white") or "").strip()
        black = (m.get("black") or "").strip()
        try:
            number = int(m.get("number", i))
        except (TypeError, ValueError):
            number = i
        out.append(
            {
                "number": number,
                "white": white or None,
                "black": black or None,
                "white_raw": white,
                "black_raw": black,
            }
        )
    return out

def _max_move_number(moves: list[dict]) -> int:
    return max((m.get("number", 0) for m in moves if (m.get("white") or m.get("black"))), default=0)


# ── readers ─────────────────────────────────────────────────────────────────

def read_old(img_bytes: bytes) -> list[dict]:
    """The previous production prompts (full pass + right-half continuation), on DeepSeek."""
    def call(prompt: str, jpeg: bytes) -> str:
        key = rd._cache_key("deepseek", "old", jpeg, prompt)
        path = rd.CACHE_DIR / f"{key}.json"
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))["text"]
        text, _ = rd._chat("deepseek", prompt, jpeg, max_tokens=4000)
        rd.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"text": text}), encoding="utf-8")
        return text

    img = rd.prep_image(img_bytes, 1500)
    moves = _parse_moves_json(call(_VLM_PROMPT, rd.to_jpeg(img, 85)))
    mx = _max_move_number(moves)
    if mx >= 16:
        w, h = img.size
        crop = img.crop((int(w * .46), 0, w, h))
        start = mx + 1
        extra = [m for m in _parse_moves_json(call(_VLM_PROMPT_CROP.format(start=start, next=start + 1, next2=start + 2),
                                                   rd.to_jpeg(crop, 90)))
                 if m.get("number", 0) > mx and (m.get("white") or m.get("black"))]
        moves = sorted(moves + extra, key=lambda m: m.get("number", 0))
    return [{"number": m["number"], "white": m.get("white_raw") or "", "black": m.get("black_raw") or "",
             "white_alt": [], "black_alt": []} for m in moves]


def read_new(img_bytes: bytes, mode: str) -> list[dict]:
    return rd.read_sheet(img_bytes, passes=mode, provider="deepseek", cache=True)["rows"]


# ── resolution ──────────────────────────────────────────────────────────────

def resolve_old(rows: list[dict]) -> list[dict]:
    from backend.scoresheet_parser import autocorrect_and_validate
    moves = [{"number": r["number"], "white": r["white"] or None, "black": r["black"] or None,
              "white_raw": r["white"], "black_raw": r["black"]} for r in rows]
    out, b = [], chess.Board()
    for m in autocorrect_and_validate(moves):
        for c in ("white", "black"):
            if m.get(f"{c}_valid") and m.get(c):
                try:
                    mv = b.parse_san(m[c])
                except ValueError:
                    return out
                out.append({"san": b.san(mv), "status": "exact"})
                b.push(mv)
            elif m.get(c):
                return out
        if not (m.get("white_valid") and (m.get("black_valid") or not m.get("black"))):
            return out
    return out


def resolve_new(rows: list[dict]) -> list[dict]:
    return decode(cells_from_rows(rows), prior=move_logprobs)["plies"]


# ── metrics ─────────────────────────────────────────────────────────────────

def norm_cell(s: str) -> str:
    s = norm_reading(s or "")
    return re.sub(r"[+#]", "", s)


def reading_acc(rows: list[dict], gt_rows: list[dict]) -> tuple[int, int]:
    got = {r["number"]: r for r in rows}
    ok = n = 0
    for g in gt_rows:
        for c in ("white", "black"):
            if not g[c]:
                continue
            n += 1
            ok += norm_cell((got.get(g["number"]) or {}).get(c, "")) == norm_cell(g[c])
    return ok, n


def seq_edit(a: list[str], b: list[str]) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return prev[-1]


def game_metrics(plies: list[dict], ref: list[str], legal_prefix: int) -> dict:
    sans = [p["san"] for p in plies]
    n = len(ref)
    pos_ok = sum(1 for i in range(n) if i < len(sans) and sans[i] == ref[i])
    first_err = next((i for i in range(n) if i >= len(sans) or sans[i] != ref[i]), n)
    lp = legal_prefix
    lp_ok = sum(1 for i in range(lp) if i < len(sans) and sans[i] == ref[i])
    wrong = [i for i in range(min(n, len(sans))) if sans[i] != ref[i]]
    flagged = {i for i, p in enumerate(plies) if p.get("status") in ("uncertain", "inferred")}
    return {
        "ref_plies": n, "plies": len(sans), "pos_ok": pos_ok, "first_error": first_err,
        "exact_game": sans[:n] == ref and len(sans) >= n,
        "lp": lp, "lp_ok": lp_ok, "fixes": seq_edit(sans, ref),
        "wrong": len(wrong), "wrong_flagged": sum(1 for i in wrong if i in flagged),
        "flagged": len(flagged), "flagged_wrong": sum(1 for i in flagged if i in set(wrong)),
    }


# ── driver ──────────────────────────────────────────────────────────────────

SOURCE = {"old": "old", "old+decoder": "old", "new-full+old": "full", "new-full": "full",
          "new-tiles": "tiles", "new-ensemble": "full+tiles", "pipeline": "pipeline", "pipeline-bands": "pipeline-bands"}


def read_page(page: dict, sources: set[str]) -> dict:
    """Phase 1 (threads, network-bound): every reading a page's variants need."""
    img = (BENCH / "images" / f"{page['id']}.jpg").read_bytes()
    out = {}
    for src in sources:
        t0 = time.time()
        try:
            if src.startswith("pipeline"):   # production path end to end: reads + decode + targeted re-read
                from backend.scoresheet_pipeline import scan_image
                sc = scan_image(img, passes="full+bands" if src == "pipeline-bands" else "full+tiles", verify=True,
                                provider="deepseek", cache=True)
                out[src] = {"rows": sc["rows"], "plies": sc["decoded"]["plies"], "verified": sc["verified"],
                            "read_s": round(time.time() - t0, 2)}
                continue
            out[src] = {"rows": read_old(img) if src == "old" else read_new(img, src), "read_s": round(time.time() - t0, 2)}
        except Exception as exc:  # noqa: BLE001
            out[src] = {"error": f"{type(exc).__name__}: {exc}"}
    return out


def resolve_job(job: tuple) -> dict:
    """Phase 2 (processes, CPU-bound): resolve one variant's readings into a game."""
    variant, rows, ref, legal_prefix, gt_rows = job
    t1 = time.time()
    plies = resolve_old(rows) if variant in ("old", "new-full+old") else resolve_new(rows)
    ok, n = reading_acc(rows, gt_rows)
    return {**game_metrics(plies, ref, legal_prefix), "read_ok": ok, "read_n": n,
            "decode_s": round(time.time() - t1, 2), "sans": [p["san"] for p in plies],
            "status": [p.get("status") for p in plies]}


def summarize(results: list[dict], variants: list[str]) -> dict:
    summ = {}
    for v in variants:
        rs = [r[v] for r in results if v in r and "error" not in r[v]]
        if not rs:
            continue
        tot = lambda k: sum(r[k] for r in rs)
        summ[v] = {
            "pages": len(rs), "errors": sum(1 for r in results if "error" in r.get(v, {})),
            "reading_acc": tot("read_ok") / max(1, tot("read_n")),
            "ply_acc": tot("pos_ok") / max(1, tot("ref_plies")),
            "legal_prefix_acc": tot("lp_ok") / max(1, tot("lp")),
            "exact_games": sum(r["exact_game"] for r in rs) / len(rs),
            "games_95": sum(r["pos_ok"] >= .95 * r["ref_plies"] for r in rs) / len(rs),
            "first_error_frac": sum(min(1, r["first_error"] / r["ref_plies"]) for r in rs) / len(rs),
            "fixes_per_game": tot("fixes") / len(rs),
            "flag_recall": tot("wrong_flagged") / max(1, tot("wrong")),
            "flag_precision": tot("flagged_wrong") / max(1, tot("flagged")),
            "silent_errors_per_100": 100 * (tot("wrong") - tot("wrong_flagged")) / max(1, tot("ref_plies")),
            "flags_per_game": tot("flagged") / len(rs),
            "decode_s": sum(r["decode_s"] for r in rs) / len(rs),
            "read_s": sum(r.get("read_s", 0) for r in rs) / len(rs),
        }
    return summ


def write_report(summ: dict, results: list[dict], split: str, spent: float) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"results_{split}.json").write_text(json.dumps({"summary": summ, "pages": results}, indent=1), encoding="utf-8")
    pct = lambda x: f"{100 * x:.1f}%"
    lines = [f"# Scoresheet OCR evaluation ({split} split)", "",
             "HCS handwritten scoresheets (real tournament sheets), DeepSeek-V4.1-Flash vision reader.",
             "Reference = legal game decoded from the human per-cell labels; *legal-prefix* = the plies where the",
             "labels replay verbatim as legal moves (exact, decoder-free ground truth).", "",
             "| variant | pages | cell reading | ply accuracy | legal-prefix acc | exact games | games ≥95% | fixes/game | flag recall | silent errors /100 plies | flags/game | read s | decode s |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for v, s in summ.items():
        lines.append(f"| {v} | {s['pages']} | {pct(s['reading_acc'])} | {pct(s['ply_acc'])} | {pct(s['legal_prefix_acc'])} | "
                     f"{pct(s['exact_games'])} | {pct(s['games_95'])} | {s['fixes_per_game']:.2f} | {pct(s['flag_recall'])} | "
                     f"{s['silent_errors_per_100']:.2f} | {s['flags_per_game']:.1f} | {s['read_s']:.1f} | {s['decode_s']:.1f} |")
    lines += ["", f"OCR spend so far (data/ocr_spend.json): ${spent:.4f}", "",
              "- *cell reading*: reader output vs the literal human transcription, per cell.",
              "- *ply accuracy*: decoded game vs reference, position by position (a shifted game counts as wrong).",
              "- *fixes/game*: move edits needed to turn the output into the reference (sequence edit distance).",
              "- *flag recall*: share of wrong plies the review screen highlights (uncertain/inferred).",
              "- *silent errors*: wrong plies shown as confident, per 100 plies -- what a user could miss."]
    (OUT / f"summary_{split}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--split", default="test", choices=["dev", "test", "all"])
    ap.add_argument("--variants", default=",".join(VARIANTS))
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--workers", type=int, default=6, help="parallel model calls")
    ap.add_argument("--procs", type=int, default=8, help="parallel decoder processes")
    args = ap.parse_args()
    variants = [v for v in args.variants.split(",") if v]
    pages = json.loads((BENCH / "manifest.json").read_text(encoding="utf-8"))["pages"]
    pages = [p for p in pages if args.split == "all" or p["split"] == args.split]
    if args.limit:
        pages = pages[: args.limit]
    t0 = time.time()
    sources = {SOURCE[v] for v in variants}
    with cf.ThreadPoolExecutor(args.workers) as ex:
        reads = list(ex.map(lambda p: read_page(p, sources), pages))
    print(f"  read {len(pages)} pages in {time.time() - t0:.0f}s", flush=True)
    jobs, keys = [], []
    results = [{"id": p["id"], "split": p["split"]} for p in pages]
    for i, (p, r) in enumerate(zip(pages, reads)):
        for v in variants:
            got = r[SOURCE[v]]
            if "error" in got:
                results[i][v] = {"error": got["error"]}
                continue
            if v.startswith("pipeline"):
                ok, n = reading_acc(got["rows"], p["rows"])
                results[i][v] = {**game_metrics(got["plies"], p["reference"], p["legal_prefix"]), "read_ok": ok,
                                 "read_n": n, "decode_s": 0.0, "read_s": got["read_s"], "verified": got["verified"],
                                 "sans": [x["san"] for x in got["plies"]], "status": [x["status"] for x in got["plies"]]}
                continue
            jobs.append((v, got["rows"], p["reference"], p["legal_prefix"], p["rows"]))
            keys.append((i, v, got["read_s"]))
    with cf.ProcessPoolExecutor(args.procs) as ex:
        for (i, v, read_s), res in zip(keys, ex.map(resolve_job, jobs, chunksize=2)):
            results[i][v] = {**res, "read_s": read_s}
    print(f"  resolved {len(jobs)} games in {time.time() - t0:.0f}s total", flush=True)
    write_report(summarize(results, variants), results, args.split, rd.spent_usd())


if __name__ == "__main__":
    main()
