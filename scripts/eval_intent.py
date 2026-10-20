"""Accuracy of the Coach's request router (position / create / general).

    python scripts/eval_intent.py            # rules, then the LLM router for ambiguous messages
    python scripts/eval_intent.py --rules    # rules only (free; ambiguous ones count as unresolved)

Labelled cases: tests/fixtures/coach_intents.json (60 realistic messages, incl. topic switches and
follow-ups). LLM calls happen only for messages the rules leave ambiguous (~$0.0001 each).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
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
from backend.coach.agent.intent import classify, rule_intent  # noqa: E402


def main(rules_only: bool) -> None:
    data = json.loads((ROOT / "tests" / "fixtures" / "coach_intents.json").read_text(encoding="utf-8"))
    boards = data["boards"]
    ok, by_source, confusion, misses = 0, Counter(), Counter(), []
    for case in data["cases"]:
        board = chess.Board(boards[case["board"]])
        info = {"kind": case["boardInfo"]} if case.get("boardInfo") else None
        history = [{"role": "assistant", "content": "(previous answer)"}] if case.get("prev") else []
        if rules_only:
            got = rule_intent(case["msg"], board, prev=case.get("prev"))
            kind, source = (got.kind, got.source) if got else ("?", "unresolved")
        else:
            got = classify(case["msg"], board, prev=case.get("prev"), history=history, board_info=info)
            kind, source = got.kind, got.source
        by_source[source] += 1
        confusion[(case["expect"], kind)] += 1
        if kind == case["expect"]:
            ok += 1
        else:
            misses.append(f"  ✗ [{case['board']}{', prev=' + case['prev'] if case.get('prev') else ''}] "
                          f"{case['msg']!r}: expected {case['expect']}, got {kind} ({source})")
    n = len(data["cases"])
    print(f"Router accuracy: {ok}/{n} = {100 * ok / n:.0f}%   (decided by: {dict(by_source)})")
    for kind in ("position", "create", "general"):
        row = {k: confusion[(kind, k)] for k in ("position", "create", "general", "?") if confusion[(kind, k)]}
        print(f"  expected {kind:8s} → {row}")
    if misses:
        print("Misses:")
        print("\n".join(misses))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rules", action="store_true")
    main(ap.parse_args().rules)
