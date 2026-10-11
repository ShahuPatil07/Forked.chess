# Forked AI Coach: implementation and research handoff

This document describes the Coach **as currently implemented** after the first
position investigation milestone. It is intended to give a new coding model or
maintainer enough context to continue without the preceding conversation.

The user's direction was to retain Forked's existing components and concentrate
new work on the AI Coach's reasoning/explanation component. The direction source
in this checkout is [`../../AIM.txt`](../../AIM.txt), not `AIM.md`. Treat that
document as product/research context; the current user's request still determines
what work is authorized. This milestone is a usable experiment, not a claim that
arbitrary chess explanations are now verified or better than the baseline.

Read [`../../instructions/COACH_TESTING.md`](../../instructions/COACH_TESTING.md)
for copyable FENs and user testing instructions, and
[`../../instructions/AIM_FIRST_SLICE.md`](../../instructions/AIM_FIRST_SLICE.md)
for the original milestone plan and implementation status.

The new **Share Screen** voice-session layer is documented separately in
[`SHARE_SCREEN.md`](SHARE_SCREEN.md), including its exact-board connection,
free default, spoken turn routing, limits, and manual acceptance tests. It reuses
the investigation described here and leaves the original Coach available.

## 1. What the Coach ultimately aims to become

AIM describes an open-source conversational chess assistant: a strong analyst,
teacher, playing partner and research assistant. Stockfish supplies calculation;
the agent investigates the resulting facts, compares decisions, tests explanations,
and communicates at the player's level. The end goal is an assistant that can
explain **why this move rather than a natural alternative**, answer follow-ups
with the board in context, analyze games as coherent stories, and connect the
ideas to useful practice and the player's real mistakes.

The goal is not to replace or outperform Stockfish. The research question in AIM
is whether investigation and counterfactual search yield better explanations
than handing an LLM one principal variation and asking for commentary.

| AIM direction | What was taken into this milestone | What remains |
| --- | --- | --- |
| Calculation versus communication | python-chess validates boards/moves; Stockfish analyzes; language models narrate a checked evidence ledger. | Broader explanation verification beyond concrete tactical/material claims. |
| Position and move explanation | Legal FEN input, explicit focus move, question, candidate lines and critical replies. | Rich positional features, plans, and arbitrary user-specified conceptual hypotheses. |
| Candidate comparison | MultiPV plus constrained searches of focus/alternative moves, including moves outside the top candidates. | Better instability detection, human difficulty estimates and strategic alternative selection. |
| Counterfactual reasoning | Investigate legal move branches and opposing replies; compare what each continuation preserves or loses. | More sophisticated branch selection and adaptive deepening based on a causal hypothesis. |
| Hypothesis verification | Deterministic tactical/material hypotheses, independent reply searches, exact board facts, supporting/contradicting evidence and uncertainty labels. | A general agent-generated hypothesis language and reliable domain-specific tests for quiet/prophylactic moves. |
| Efficient Stockfish integration | Initial scan, deeper candidate searches, time budget, separate mate/cp types, partial results. | Stronger cancellation, caching and more reliable ranking stability checks. |
| Human-centered explanations | Existing Coach conversation, a Position mode, requested-level narration and local factual fallback. | Reliable simplification/deepening without introducing unsupported new claims. |
| Evaluation | Frozen single-PV baseline, 30 legal seed cases, paired-run script and empty review rubrics. | Human-scored difficult positions/games and evidence of a quality improvement. |
| PGN/game stories | Existing PGN tool retained. | Critical moments beyond evaluation swings, strategic transitions and verified narrative summaries. |
| Playing and historical retrieval | Existing Maia practice and other training surfaces retained. | Conversational Stockfish playing modes, historical-game retrieval and integrated research workflows. |

AIM's instruction to build vertically guided the scope: prove a FEN → candidates
→ investigation → counterfactual comparison → explanation loop first. We did
not remove training, opening/endgame coaches, scanner, analysis board, Maia,
blindspot intelligence, or shareable DNA features to make room for the pivot.

## 2. Existing Coach foundations that remain

The Coach already had six callable tools, an SSE conversation loop, inline puzzle
and mistake boards, questionnaire onboarding, audio mode, and three context layers:

1. A persisted questionnaire in `{username}_coach_profile.json`.
2. Rolling cross-session memory in `{username}_coach_memory.json`.
3. Live context from the user's games, skill-family blindspots and training data.

Those foundations remain. Identity is still the local username convention rather
than an authentication system. State is stored in JSON/SQLite files under `data/`.
The backend remains one FastAPI app in `backend/main.py`. There is no new service,
database, vector store, agent framework or dependency introduced by this milestone.

## 3. File map

| File | Responsibility |
| --- | --- |
| `router.py` | Coach HTTP endpoints, request models, SSE orchestration and deterministic routing into position investigation. |
| `tools.py` | The six tool schemas/dispatch handlers; `explain_position` now accepts focus/alternative/budget arguments. |
| `investigation.py` | Provider-independent typed chess evidence, legality checks, bounded engine searches, hypothesis checks and factual template. |
| `explain.py` | Tool-compatible result wrapper, compact evidence for the narrator, optional C1/Groq synthesis and conservative prose rejection checks. |
| `config.py` | Shared model ID and reasoning options for Coach chat, narration and memory. |
| `baseline.py` | Preserved previous explanation code plus a time-capped single-PV benchmark adapter. It is a historical comparison, not the live implementation. |
| `context.py` | Player's live data context and top-blindspot lookup. |
| `profile.py` | Questionnaire and Coach memory file persistence. |
| `memory.py` | Best-effort rolling session summary using the shared configured model. |
| `../../frontend/src/pages/Coach.tsx` | Existing Coach UI plus Position inputs, conversation attachments and narration-source indication. |
| `../../frontend/src/components/coach/InvestigationEvidence.tsx` | Candidate selection, board/variation playback, searched reply navigation, checked hypotheses and JSON export. |
| `../../frontend/src/api/coach.ts` | Typed payloads and SSE client. Callback/provider errors now propagate instead of being swallowed as malformed JSON. |
| `../../tests/test_coach_investigation.py` | Chess correctness, budget, API/streaming and narration-check regression tests. |
| `../../tests/fixtures/coach_positions.json` | Thirty legal project-authored seed positions; human quality review is pending. |
| `../../scripts/evaluate_coach.py` | Paired baseline/investigation capture, optional same-settings narration and human review fields. |

## 4. User-facing behavior

At `http://localhost:5173/coach`, the new **Position** mode accepts:

- A complete six-field FEN.
- An optional **Your move** in SAN or UCI.
- An optional **Alternative** in SAN or UCI.
- Quick/Standard/Deeper analysis budgets of 3/8/15 seconds.
- A question and the **Use AI wording** toggle.

Built-in Mate, Fork and Opening examples fill a position. The original FEN is
retained for follow-ups. Editing the FEN clears explicit move fields. A move
question can infer legal root moves if the explicit fields are blank; explicit
fields are more reliable, especially when the question discusses an opponent reply.

For users who have not completed the questionnaire, **Investigate a position now**
opens Position mode without discarding onboarding. A stored username is still
required by the app's existing route guard. Saved local profiles can be resumed
from the homepage without running ingestion again.

The attachment shows candidates, White-relative evaluations, completed depths,
the original board and principal variation, sampled opponent replies, confidence
labels, exact all-legal-first-reply enumeration, and analysis warnings. Clicking
a variation move changes the displayed board only; it does not change the next
analysis request's root FEN. Evidence can be downloaded as JSON for feedback.

AI prose appears separately from the evidence card. The UI explicitly distinguishes
AI wording from a local factual summary. A verification label on a claim does
not certify the entire prose answer.

## 5. Request routing and endpoints

### `POST /api/coach/chat`

The existing request still accepts `username`, `message`, `mode`, and
`conversation_history`. Additional optional fields are `position_fen`,
`focus_move`, `alternative_move`, `budget_seconds`, and `use_llm`.

If mode is `position`, or a complete recognizable FEN is pasted in the message:

1. Emit `meta` and `tool` events.
2. Run `explain_position` directly. An LLM key or tool-selection error cannot
   prevent this request from collecting local evidence.
3. Emit the full `tool_result` for the board/evidence UI.
4. Optionally narrate the evidence using conversation history.
5. Emit narrator-source/rejection metadata, answer tokens, and `done`.

The synchronous FastAPI streaming generator runs blocking work off the event loop
through the framework's thread pool. The other conversation modes retain the
bounded general tool-orchestration loop (four rounds, with trimmed history).

For ordinary chat, the model can still call `explain_position` as one of the six
tools. That result is compacted into valid JSON for the model rather than cut
mid-field. The narrative-specific conservative checks described below apply to
the direct Position/pasted-FEN synthesis path; a general chat tool answer is
still governed primarily by the system prompt and should be reviewed separately.

### `POST /api/coach/investigate`

This endpoint bypasses conversation and is useful for local experiments:

```json
{
  "fen": "8/3q3k/8/3N4/8/8/8/6K1 w - - 0 1",
  "question": "Why Nf6+ instead of Ne3? Does taking the queen win the game?",
  "focus_move": "Nf6+",
  "alternative_move": "Ne3",
  "budget_seconds": 8,
  "use_llm": false
}
```

It defaults to local evidence without a hosted model. With `use_llm: true`, the
result's explanation is replaced by accepted narration or the factual fallback.
Validation failures return HTTP 400; invalid request budgets return HTTP 422.
In chat, invalid position/move input is returned as an explanation error payload
with no board/candidates, so the conversation stays usable.

Existing questionnaire/profile/memory endpoints remain. Bot play and full PGN
analysis are not reimplemented by this endpoint.

## 6. Investigation algorithm

`InvestigationRequest` defaults to scan depth 12, target depth 18, three MultiPV
candidates and an eight-second budget. Internal tests can inject an engine, lock
and monotonic clock; the live path reuses `backend.main._sf_lock` and
`backend.main._ensure_engine`.

1. **Validate:** enforce a finite 0.25–15-second budget, complete FEN, valid board,
   legal SAN/UCI moves and distinct focus/alternative. Null moves are rejected.
2. **Terminal check:** detect automatic terminal outcomes before asking Stockfish
   for candidates. Checkmate, stalemate and insufficient material have exact board
   outcomes and zero engine calls. Claimable repetition draws are not reconstructed
   from a FEN because prior game history is absent.
3. **Acquire the engine:** lock acquisition counts against the same monotonic
   budget. If the engine is busy until the deadline, return a partial result.
4. **Scan:** use MultiPV to collect up to three candidates at the lower depth.
5. **Add explicit branches:** include named moves even if the initial top list
   omitted them. Use a constrained `root_moves` search for each requested move.
6. **Refine:** deepen candidates, prioritizing focus/alternative and the initially
   preferred move. Allocate a portion of the remaining budget across these calls.
7. **Recheck defenses:** from each relevant resulting board, independently search
   up to two opponent replies at depth up to 16. Use the original mover's score
   perspective and count the initial move's sacrifice/capture as well.
8. **Check claims:** build deterministic hypotheses and compare root and reply
   evidence. Exact one-ply legal reply enumeration is independent of Stockfish.
   If the root line contains a simple terminal continuation, apply that same
   continuation after every legal first reply and verify the terminal outcomes.
9. **Return evidence:** include searched lines, claims, contradictions, elapsed
   time, engine calls, depth warnings and complete/partial/terminal status.

Every displayed PV is replayed with python-chess. Illegal engine output fails
closed. Replay stops at automatic game termination rather than showing moves
after an insufficient-material draw. Lines are limited to twelve displayed plies.

The engine time/depth limits and monotonic deadline bound routine search work.
They are not a hard OS process cancellation guarantee: engine startup and call
overhead can overshoot the requested wall time. Model narration has its own
timeout and is not included in the engine budget.

## 7. Evidence schema and score semantics

The public result keeps the old `explanation`, `best_move_san`, `eval`, and
`source` fields, and adds:

- Root FEN/question, side to move, focus and alternative UCI moves.
- Candidates with stable `move:{uci}` IDs, roles, scores, depth and refinement flag.
- UCI/SAN lines, resulting FENs, captures, material delta/final balance and outcome.
- Independent reply searches plus all legal first-reply SAN moves.
- Claims with IDs, hypothesis, status, test, supporting/contradicting evidence and scope.
- Engine metadata, warnings, budget/call timings and narration metadata.

`Score` stores **both** White-relative and original-mover-relative centipawns and
mate distances. Positive White cp favors White; negative favors Black. Candidate
ordering uses the original mover's perspective. Mate is not represented as a
large cp number. Winning mate, cp evaluations and losing mate have separate
ordering bands; prefer faster winning mates and later losing mates.

Material uses conventional values P=1, N/B=3, R=5, Q=9, K=0. A **material delta**
of +9 means nine points were gained relative to the root; it is not the current
material advantage and not an engine evaluation. A queen capture followed by
a queen recapture must count both operations. Promotion replaces the pawn;
en passant captures off the destination square.

## 8. What verification labels mean

| Label | Meaning |
| --- | --- |
| `verified` | The specific board fact, terminal consequence or faithfully reported search observation passed its stated check. Examples: immediate mate, check, captured piece, geometric attacks, all first replies are king moves, a specific continuation ends identically after every legal first reply. |
| `likely` | The sampled root line and independent defenses support an interpretation, such as a material gain; defenses beyond the sample may change it. |
| `uncertain` | Evidence is missing, inconsistent, too shallow or incomparable. |
| `rejected` | The investigated material-winning hypothesis is contradicted by the checked lines; it must not become the explanation. |

A geometric fork is not automatically a forced material gain. A favorable score
is not itself an explanation. A PV reaching mate is not an exhaustive mate proof.
The old rule classifier supplies a motif hint only; it no longer becomes a
confident "key idea" without checking. Its call-signature bug was fixed in the
live path. White/Black mate labeling replaces the old ungrounded "you" labels.

One important seed case is Nf6+ with White Kg1/Nd5 versus Black Kh7/Qd7.
The knight checks and attacks the queen. All four legal first replies are king
moves. After any of them Nxd7 reaches king+knight versus king: an automatic
insufficient-material draw. This is a material gain that **saves a draw**, not a
won game. The milestone includes an exact board proof for that short consequence.

## 9. Narration, provider configuration and fallbacks

The narrator receives compact JSON with board pieces, candidates, typed scores,
explicit pawn-unit evaluation labels, material delta/final balance, final board
pieces, all legal replies, searched defenses and the checked claims. The prompt
asks for a concise answer at the requested level, forbids invented lines/claims,
and preserves uncertainty. It is not asked to independently calculate tactics.

Provider order when AI wording is enabled:

1. Optional `C1_ENDPOINT` narration, using the existing requests dependency,
   `C1_MODEL` and `C1_API_KEY`, with a three-second timeout.
2. Groq with the existing `GROQ_API_KEY`, a twelve-second timeout and no SDK retries.
3. Local factual template if no provider succeeds or the prose fails a check.

`config.py` shares `FORKED_COACH_MODEL` across general Coach chat, narration and
session memory. The default is `openai/gpt-oss-120b`. The previous
`llama-3.3-70b-versatile` returned `model_not_found` for the existing project key;
the new default was found in that key's accessible model list and live requests
succeeded. The model is hosted through Groq; no OpenAI API key is required.
Groq's [model documentation](https://console.groq.com/docs/model/openai/gpt-oss-120b)
describes its text/tool capabilities.

To change the **product's** model, set `FORKED_COACH_MODEL` in `.env` and restart
the backend. Supported GPT-OSS models receive low reasoning effort; other model
IDs do not receive that provider-specific setting. Narration uses temperature 0
and a 2,000-token cap. General chat and memory retain their separate temperatures.
A user switching the coding/chat model that reads this handoff is a different
operation and does not require changing the product's `.env`.

Narration rejection checks are deliberately conservative and narrow. They detect
some invented SAN/UCI moves, sampled-versus-legal defense overclaims, suggestions
that a terminal insufficient-material draw can still be won, captured heavy
pieces wrongly placed on a terminal board, unexplored "only saving move" claims,
evaluation/material conflation, cp/pawn unit mismatches and claims that large
evaluation gaps are tiny. Rejected narration falls back to the factual summary
and exposes `narration_warnings`.

These are not a semantic verifier. Plain pawn-square mentions and arbitrary
strategic prose can still be wrong. A passed prose check does not earn a verified
claim label. During live tests the model produced contradictory material/draw
statements even with correct evidence. This is a central unresolved research
problem, not something to hide by making the prompt sound more confident.

## 10. Evaluation and validation at handoff

The targeted suite has **31 passing tests** covering invalid boards/moves,
outside-MultiPV alternatives, SAN/UCI promotions, en passant, score orientation,
mate ordering, legal replay and terminal stopping, recapture accounting, terminal
boards, busy-engine deadlines, budget exhaustion, real Stockfish mate/fork cases,
API validation, local SSE behavior, narrator failure/fallback and observed prose
overclaim regressions. It also validates the thirty seed positions' legality.

The TypeScript/Vite production build passed. Its existing large-bundle warnings
remain. Desktop and mobile browser checks loaded Coach, submitted mate/fork
requests without AI wording, replayed a variation and displayed the evidence
without JavaScript page errors or mobile horizontal overflow. Live Groq narration
and generic Coach greeting requests succeeded after the model configuration fix.

The only test-run warning was an upstream FastAPI/Starlette TestClient deprecation
about httpx; no dependency churn was introduced to silence it.

Paired evaluation commands:

```powershell
& .\.venv\Scripts\python.exe -m pytest tests/test_coach_investigation.py -q -p no:cacheprovider
& .\.venv\Scripts\python.exe scripts/evaluate_coach.py --budget 3 --limit 30
& .\.venv\Scripts\python.exe scripts/evaluate_coach.py --budget 8 --limit 30 --llm
```

Run from the repo root. JSON reports go to `results/coach/` (ignored generated
artifacts). Each records engine identity, Threads=1/Hash=64, hash clearing between
arms, same maximum time budget, actual search cost, model/prompt settings and
empty human review fields. Wall-time search does not guarantee identical outputs
across machines or builds. Same maximum budget is not the same actual cost.

The baseline adapter preserves the previous single-PV behavior, including its
legacy mate prose and omitted motif. Terminal baseline behavior is retained for
comparison rather than made correct retroactively. The new narrator can be used
with baseline evidence for same-model paired prose comparisons.

Hosted-model limits/errors can produce template fallbacks in evaluation runs.
Those runs are labeled; do not score them as successful LLM pairs or infer a
quality win from them. An integration issue with minimal baseline narrator input
was found and fixed; its regression test is included.

Thirty seed cases ran through local paired capture, and small hosted comparisons
were attempted. The seed set is synthetic, not a reviewed difficult-position
benchmark. Human review and a demonstrated explanation-quality improvement are
still pending. Use the testing guide's rubric and the user's real positions.

## 11. Running and continuing the work

```powershell
# Terminal 1, repo root
& .\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

# Terminal 2
Set-Location frontend
npm.cmd run dev -- --host localhost --port 5173 --strictPort
```

The frontend proxies `/api` to the backend; existing bot WebSockets connect to
port 8000 directly. API docs are at `http://127.0.0.1:8000/docs`. Background
processes started for the user have log/PID metadata in `logs/`. The restricted
execution sandbox prevented outbound API calls when launching a backend inside
it; the user-authorized final server was launched outside that sandbox so its
existing Groq connection can work. Normal user terminals do not need that agent
sandbox workaround. No secret values are documented here.

The repo already contained other uncommitted changes in README/CLAUDE, backend
main and scoresheet code, scanner tests/docs, and SQLite caches. Preserve them.
This milestone's live edits are in the Coach package, Coach UI/API, targeted
tests/fixtures, evaluation script and milestone/testing/handoff docs. Imports,
live sync and browser activity can update existing caches/generated user state.

## 12. Best next decisions after user feedback

1. Review actual failed explanations and downloaded evidence before expanding
   the UI or choosing an agent framework.
2. Grow a human-reviewed benchmark with difficult quiet/prophylactic/defensive
   positions from the user's games. Record sources and expected causal claims.
3. Introduce a typed hypothesis/test language for strategic ideas; have an agent
   propose tests, and verify the domain-specific consequences with board/engine
   tools. Do not equate another LLM judging a sentence with verification.
4. Improve branch choice and depth stability. A small/unequal-depth cp gap should
   not become a definitive move-quality verdict.
5. Compare baseline and investigation at matched budgets and comparable narration
   settings, measuring correctness, causal relevance, completeness, usefulness,
   unsupported claims and latency. Choose the next improvement from those results.

After the position loop is demonstrably useful, expand to critical PGN moments
and coherent game stories, then playing/retrieval/personalized teaching. Keep the
existing player-data tools and surrounding product available throughout. The
end goal remains AIM's conversational chess analyst that investigates and
explains, with Stockfish as its calculation tool and evidence as its trust basis.
