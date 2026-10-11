"""Save paired baseline/investigation runs for human review; never invent scores."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chess.engine
from dotenv import load_dotenv

load_dotenv(ROOT / ".env")
from backend.coach.baseline import benchmark_baseline
from backend.coach.explain import NARRATION_PROMPT, narrate_evidence
from backend.coach.config import MODEL, NARRATION_MAX_TOKENS, reasoning_options
from backend.coach.investigation import InvestigationRequest, factual_explanation, investigate, score_label
from ml.config import STOCKFISH_PATH

RUBRIC = ["factual_correctness", "engine_consistency", "causal_relevance",
          "completeness", "human_usefulness", "unsupported_claims", "counterfactual_quality"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=ROOT / "tests/fixtures/coach_positions.json")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--budget", type=float, default=8)
    parser.add_argument("--llm", action="store_true", help="Generate both narratives with identical Groq settings; requires network/key.")
    parser.add_argument("--output", type=Path, default=ROOT / "results/coach")
    args = parser.parse_args()
    if not 0.25 <= args.budget <= 15:
        parser.error("budget must be between 0.25 and 15 seconds")
    cases = json.loads(args.cases.read_text(encoding="utf-8"))["positions"][:args.limit]
    args.output.mkdir(parents=True, exist_ok=True)
    path = args.output / f"paired-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}.json"
    report = {"created_at": datetime.now(timezone.utc).isoformat(),
              "comparison": "same maximum engine-time budget; different search allocation",
              "llm": {"enabled": args.llm, "model": MODEL, "temperature": 0,
                      "max_tokens": NARRATION_MAX_TOKENS, **reasoning_options(),
                      "system_prompt": NARRATION_PROMPT if args.llm else None},
              "human_review": "pending; no quality improvement is claimed", "runs": []}
    try:
        # Fixed threads/hash and clearing between systems makes runs less
        # dependent on the live app's warm shared engine. Wall-time caps still
        # prevent bit-for-bit reproducibility across machines.
        with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as engine:
            engine.configure({"Threads": 1, "Hash": 64})
            report["engine"] = {**engine.id, "threads": 1, "hash_mb": 64, "budget_seconds": args.budget,
                                "hash_policy": "Clear Hash before each arm", "scan_depth": 12, "deep_depth": 18}
            for index, case in enumerate(cases):
                engine.configure({"Clear Hash": None})
                baseline = benchmark_baseline(case["fen"], engine, args.budget)
                engine.configure({"Clear Hash": None})
                evidence = investigate(InvestigationRequest(
                    case["fen"], case["question"], case.get("focus_move"),
                    case.get("alternative_move"), args.budget), engine=engine)
                result = evidence.to_dict()
                top = evidence.candidates[0] if evidence.candidates else None
                result.update(explanation=factual_explanation(evidence), source="stockfish",
                              best_move_san=top.move_san if top else None,
                              eval=score_label(top.score) if top else None)
                if args.llm:
                    # Same narrator/settings, single-PV evidence versus the
                    # investigation ledger. Log fallbacks, never count them as
                    # successfully generated LLM pairs.
                    baseline_input = {"fen": case["fen"], "question": case["question"],
                                      "side_to_move": "white" if chess.Board(case["fen"]).turn else "black",
                                      "status": "baseline", "warnings": [], "claims": [],
                                      "explanation": baseline["explanation"], "source": "baseline",
                                      "candidates": [{"move_san": baseline["best_move_san"], "roles": ["candidate"],
                                          "score": {"white_cp": baseline.get("white_cp"), "white_mate": baseline.get("white_mate")},
                                          "depth": baseline.get("depth", 0), "line": {"san": baseline.get("pv_san", []), "material_change": None}, "replies": []}]
                                      if baseline["best_move_san"] else []}
                    started = time.monotonic()
                    baseline["narration"], baseline["narration_source"] = narrate_evidence(baseline_input, force_groq=True)
                    baseline["narration_seconds"] = round(time.monotonic() - started, 3)
                    started = time.monotonic()
                    result["narration"], result["narration_source"] = narrate_evidence(result, force_groq=True)
                    result["narration_seconds"] = round(time.monotonic() - started, 3)
                report["runs"].append({"case": case, "baseline": baseline, "investigation": result,
                                       "review": {"baseline": dict.fromkeys(RUBRIC), "investigation": dict.fromkeys(RUBRIC),
                                                  "preferred": None, "notes": ""}})
                print(f"{index + 1}/{len(cases)} {case['id']}: {evidence.status}, {len(evidence.candidates)} candidates", flush=True)
    finally:
        path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Saved paired runs: {path}", flush=True)


if __name__ == "__main__":
    main()
