"""
Scoresheet image -> decoded legal game. The one function the API and the
evaluation both call (backend/scoresheet.py, scripts/eval_scoresheets.py).

  1. read     full-page pass + one pass per table column, concurrently
              (backend/scoresheet_reader.py) -- disagreements become alternatives
  2. decode   beam search over legal games with the Maia2 prior
              (backend/scoresheet_decoder.py, backend/scoresheet_prior.py)
  3. proof    every decoded move goes back to the model as a multiple choice against
              the image band it was read from ("row 23, White: Bd6, Be7 or Bd2?").
              Checking is far easier for a vision model than free transcription, and
              it is the only way to catch silent misreads -- a misread that happens
              to be another legal move. The raw reading and "something else" are
              always options, so it can't force a chess-plausible answer.
  4. decode   again with the answers as the strongest votes; then one more targeted
              round on whatever is still doubtful.
"""
from __future__ import annotations

import os
import re

from backend import scoresheet_reader as reader
from backend.scoresheet_decoder import cells_from_rows, decode
from backend.scoresheet_prior import move_logprobs

MAX_QUESTIONS = 24     # targeted rounds
MAX_PROOF = 160        # first round proofreads every decoded move (up to 80 full moves)
PROOF_ROUNDS = 2
VERIFY_STATUSES = ("uncertain", "inferred", "corrected")


def prior_for(elo: int | None):
    level = min(max(int(elo or 1500), 800), 2400)
    return lambda boards: move_logprobs(boards, level)


def _strip(s: str) -> str:
    return re.sub(r"[+#]", "", s or "")


def build_questions(plies: list[dict], rows: list[dict], everything: bool = False) -> list[dict]:
    """Decoded moves -> multiple-choice questions. `everything` proofreads every move
    (silent misreads are legal moves marked "exact", so nothing can be skipped);
    otherwise only the doubtful ones, most doubtful first."""
    by_n = {r["number"]: r for r in rows}
    order = {"uncertain": 0, "inferred": 1, "corrected": 2, "exact": 3, "confirmed": 4}
    if everything:
        picked = list(plies[:MAX_PROOF])
    else:
        picked = sorted((p for p in plies if p["status"] in VERIFY_STATUSES),
                        key=lambda p: (order[p["status"]], p["ply"]))[:MAX_QUESTIONS]
    qs = []
    for p in picked:
        row = p["row"] if p["row"] is not None else p["ply"] // 2 + 1
        color = p["color"] or ("w" if p["ply"] % 2 == 0 else "b")
        side_key = "white" if color == "w" else "black"
        raw = (by_n.get(row) or {}).get(side_key, "") or p.get("read") or ""
        opts: list[str] = []
        for o in [_strip(p["san"])] + [_strip(a) for a in p.get("alternatives", [])[:3]] + [raw]:
            if o and o not in opts:
                opts.append(o)
        qs.append({"id": len(qs), "row": row, "side": "White" if color == "w" else "Black",
                   "key": side_key, "options": opts})
    return qs


def group_questions(qs: list[dict], band_rows: dict[str, list[int]] | None) -> dict[str, list[dict]]:
    """Send each question to the image band its row was read from (else the whole page)."""
    groups: dict[str, list[dict]] = {}
    for q in qs:
        g = "full"
        for name in ("left-top", "left-bottom", "right-top", "right-bottom"):
            if band_rows and q["row"] in band_rows.get(name, []):
                g = name
                break
        groups.setdefault(g, []).append(q)
    return groups


def apply_answers(rows: list[dict], questions: list[dict], answers: dict[int, dict]) -> tuple[list[dict], int]:
    """Fold verification answers into the readings: the answer becomes the primary
    reading and the earlier reading stays as an alternative."""
    by_n = {r["number"]: dict(r, white_alt=list(r.get("white_alt") or []), black_alt=list(r.get("black_alt") or []))
            for r in rows}
    changed = 0
    for q in questions:
        a = answers.get(q["id"])
        if not a:
            continue
        choice = a.get("choice", "")
        text = a.get("text", "") if choice.lower() == "other" else choice
        if choice.lower() == "blank" or not text:
            continue
        r = by_n.setdefault(q["row"], {"number": q["row"], "white": "", "black": "", "white_alt": [], "black_alt": []})
        k = q["key"]
        old = r.get(k) or ""
        n_pass = r.get("passes")
        if n_pass and r.get(f"{k}_votes") is not None:
            # the targeted answer is the strongest vote; earlier readings stay as weaker ones
            r[f"{k}_votes"] = [[text, n_pass]] + [[v, c * .5] for v, c in r[f"{k}_votes"] if _strip(v) != _strip(text)]
        if _strip(old) != _strip(text):
            r[k] = text
            if old and old not in r[f"{k}_alt"]:
                r[f"{k}_alt"].append(old)
        changed += 1
    return [by_n[n] for n in sorted(by_n)], changed


def scan_image(image_bytes: bytes, elo: int | None = None, passes: str | None = None, verify: bool = True,
               samples: int | None = None, provider: str | None = None, cache: bool = False) -> dict:
    """Read, decode, proofread every move, re-decode, then one more targeted round on
    whatever is still doubtful. Accuracy first: ~8-14 model calls, about a cent a page."""
    passes = passes or os.getenv("SCORESHEET_PASSES", "full+bands")
    read = reader.read_sheet(image_bytes, passes=passes, provider=provider, cache=cache, samples=samples)
    rows = read["rows"]
    prior = prior_for(elo)
    res = decode(cells_from_rows(rows), prior=prior)
    checked = 0
    if verify and rows:
        for rnd in range(PROOF_ROUNDS):
            qs = build_questions(res["plies"], rows, everything=(rnd == 0))
            if not qs:
                break
            answers = reader.proofread(image_bytes, group_questions(qs, read.get("band_rows")),
                                       provider=read["provider"], cache=cache)
            rows2, n = apply_answers(rows, qs, answers)
            checked += len(answers)
            if not n:
                break
            rows = rows2
            res = decode(cells_from_rows(rows), prior=prior)
    return {"rows": rows, "decoded": res, "provider": read["provider"], "meta": read.get("meta") or {},
            "raw": read["raw"], "verified": checked}
