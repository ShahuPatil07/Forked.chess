# Forked: first milestone toward the AIM pivot

## Implementation status

The first usable slice is implemented. See [COACH_TESTING.md](COACH_TESTING.md)
for instructions and concrete manual tests.

- Position mode in the existing Coach accepts a FEN and explicit SAN/UCI moves.
- Local bounded MultiPV investigation refines candidates and independently
  searches up to two replies to relevant moves. Out-of-list alternatives are
  explicitly searched, and partial results disclose budget/depth limits.
- Deterministic tactical/material hypotheses have checked supporting and
  contradicting evidence. First-ply replies are enumerated exactly; small
  terminal continuations can also be checked exhaustively on the board.
- Candidate boards, variation playback, hypothesis details, and downloadable
  evidence are available in the Coach. Hosted narration can be turned off.
- A frozen single-PV baseline, 30 legal seed positions, and a paired evaluation
  runner are present. Human quality review remains pending.
- Model settings are shared by Coach chat, narration and memory. Optional C1
  narration is preserved and grounded after engine investigation.

The prose narrator has conservative checks for invented moves, conflating
sampled defenses with legal replies, terminal-draw overclaims, and calling large
evaluation gaps small. These checks reject narration to the factual template;
they do not establish that arbitrary prose or strategic claims are verified.
This implementation does not yet generate and prove general quiet-move or
long-term positional hypotheses. The following plan remains the research
reference for iterating from feedback.

## Scope

The direction document currently present in this checkout is `AIM.txt`, not
`AIM.md`. This plan uses it as product context. The requested scope is to retain
the existing product and concentrate new development on the Coach's chess
reasoning and explanation component.

First user outcome: given a legal FEN and a question such as "Why is this move
better than my alternative?", Forked compares legal continuations, investigates
specific claims, and explains the evidence with explicit uncertainty.

## What is already built

| Area | Implementation and reusable progress |
| --- | --- |
| App | React/TypeScript/Vite frontend; FastAPI backend; files and SQLite for state. |
| Coach | `backend/coach/router.py` orchestrates six tools in a bounded loop, streams SSE, and combines questionnaire, session memory, and live player context. `frontend/src/pages/Coach.tsx` already renders interactive boards. |
| Engine | `backend/main.py` owns a shared Stockfish engine protected by `_sf_lock`. `/api/analyse` returns one best move and White-perspective centipawn/mate scores. |
| Position explanation | `backend/coach/explain.py` optionally calls a C1 endpoint; the local fallback runs depth 18 and returns one PV. Its attempted rule-based motif lookup currently fails silently because it passes three arguments to a two-argument function. |
| Game analysis | The Coach's `analyze_pgn` tool scans up to 80 plies at depth 12 and returns the five largest mistakes. It does not yet investigate strategic turning points or tell a verified game story. |
| Personal training | Game ingestion, transformer motif classification, deterministic skill-family profiles, theme-based puzzle retrieval, and spaced repetition are implemented. |
| Other surfaces | Opening explorer/coaches, endgame theory/practice/coaches, Maia games/debriefs, analysis board, OTB capture/OCR, mistake replay, live alerts, rating estimates, and Chess DNA remain available. |

Local artifacts inspected: Stockfish, transformer and Maia weights, 90,138 puzzle
entries, 66 curated endgame positions, and two saved blindspot profiles. These
are asset counts, not a claim that every feature has been tested end to end.
The README's classifier accuracy is a historical reported result; it was not
re-measured during this review.

Some documentation still describes older clustering/vector paths. The current
ingestion path imports `ml.clustering.profile_pipeline`, which groups mistakes
into fixed families. Follow the executing code when extending it.

## The gap to address first

The existing explanation fallback describes an engine choice. It does not
investigate why that choice succeeds:

- No MultiPV candidate comparison or analysis of a user-specified alternative.
- The question is not used to guide the Stockfish fallback's investigation.
- The motif lookup has a call-signature mismatch. Even after fixing it, a motif
  label would need causal checking before it can establish "the key idea".
- Optional C1 prose is returned without an engine verification stage.
- No evidence ledger, claim confidence, or explanation-quality benchmark.

Two small correctness fixes should accompany the baseline work: repair the
`classify_threat` call, and replace the mate score formatter's "you/against you"
labels with explicit White/Black labels. Its score is White-relative and it has
no information about the user's color. The optional C1 path also imports
`openai`, which is absent from this environment and not listed in requirements;
that path would fall back until its optional client dependency is supplied.

The existing counterfactual **rating estimate** is a different feature from the
move-level counterfactual search described in AIM; keep it intact.

## First vertical slice

### 1. Establish a baseline and benchmark

Capture the current single-PV explanation before changing its behavior. Assemble
an initial set of about 30 reviewed positions spanning tactics, quiet moves,
defense, sacrifices, prophylaxis, endgames, Black to move, and mate scores. Each
case should include a legal FEN, the question, a proposed alternative where
relevant, source attribution, and human-reviewed claims/critical continuations.
Use these cases for a paired comparison of the old and new systems.

### 2. Build a bounded engine investigation service

Add `backend/coach/investigation.py` with typed request/evidence structures.
Reuse python-chess, Stockfish, the existing engine lock, and worker execution.

Inputs: FEN, optional focus move, optional alternative move, question, and an
analysis budget. Parse SAN/UCI against the actual board; validate board legality
and handle terminal positions explicitly.

Start with three MultiPV candidates at a modest depth. If a user names a move
outside the top three, analyze that move explicitly with a constrained root
search. Investigate the opponent's strongest responses and deepen only the
branches relevant to the question or an unstable result. Bound total engine
time and tool rounds; return partial evidence when the budget expires.

Record UCI and SAN lines, resulting FENs, depth, elapsed time, engine version,
and typed centipawn/mate scores. Keep a consistent evaluation perspective when
comparing branches, including after Black's moves. Do not subtract mate scores
as if they were ordinary centipawns.

### 3. Generate and test narrow hypotheses

Produce a few explicit, testable hypotheses from the candidate evidence. For
example: "The natural alternative allows a forcing reply that wins this piece."
Each hypothesis must name its supporting branch and a test that could refute it.

Check concrete board claims with python-chess, replay every cited line legally,
and use additional bounded engine searches to test relevant alternatives and
opponent replies. Include both supporting and contradicting evidence.

Use legal move branches for counterfactuals first. Removing a bishop from the
board changes material and often legality; the resulting evaluation difference
alone does not establish the cause of the original move's strength.

Use these claim labels:

- **Verified within the analysis budget:** a concrete board/variation claim
  passed its specified checks; disclose search limits.
- **Likely:** evidence supports an interpretation but does not isolate its cause.
- **Uncertain/rejected:** insufficient or contradictory evidence; do not present
  rejected claims as explanations.

A deeper evaluation alone does not verify a broad strategic explanation.

### 4. Explain through the existing Coach

Extend the existing `explain_position` tool with optional explicit focus and
alternative moves. Preserve its current response fields for compatibility and
add candidates, claims, evidence, and budget metadata.

Generate prose from the checked evidence: the important feature, why the move
works, the strongest reply, why the alternative differs, and the remaining
uncertainty. When the LLM is unavailable, provide the structured comparison and
a factual template. Keep the evidence service independent of the LLM provider.

Initially reuse the current Groq integration for the experiment. A configurable
local OpenAI-compatible provider can follow once the core evidence loop works;
do not require a GPU or introduce an agent framework to prove this slice.

Use the existing Coach board for display. Add a compact candidate/evidence view
only after the backend comparison is working. Do not redesign the app shell or
expand PGN analysis, play modes, or historical-game retrieval in this milestone.

## How to judge completion

- Tests cover illegal positions/moves, terminal boards, Black's perspective,
  mate handling, alternatives outside MultiPV, legal PV replay, and budget limits.
- Save reproducible baseline and investigation runs for the benchmark with
  identical LLM settings and disclosed engine budgets/configuration.
- Human review scores factual correctness, causal relevance, completeness,
  usefulness, unsupported claims, and counterfactual quality. Engine agreement
  is supporting evidence, not the sole quality metric.
- Record latency and engine cost alongside quality. Compare both practical
  default budgets and matched budgets to expose the cost/quality tradeoff.
- Decide whether the new loop improves explanations before broadening scope.
  Do not claim a quality improvement solely because MultiPV was added.

Recommended implementation order: benchmark and baseline, structured MultiPV
service, explicit alternative comparison, hypothesis checks, Coach integration,
then paired evaluation. The first code change should be the evidence service
and its meaningful chess correctness tests.

## Local development

The existing `.venv`, `.env`, frontend dependencies, and local data were reused.
No training/index rebuild is required for this checkout. Run from the repo root
in two terminals:

```powershell
# Terminal 1
& .\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000

# Terminal 2
Set-Location frontend
npm.cmd run dev -- --host localhost --port 5173 --strictPort
```

App: `http://localhost:5173`. API docs: `http://127.0.0.1:8000/docs`.
The frontend proxies `/api` to port 8000; bot WebSockets use port 8000 directly.
For the background processes launched during setup, logs are in `logs/`.

The Coach and other hosted-LLM features still need a working Groq key/network;
opening statistics and tablebases use external services. `.env` has those key
settings present, but presence is not proof of service availability. C1 is not
configured; Stockfish remains the position explanation fallback. Local OCR
also requires its configured model server to be running.

Setup validation completed: Python dependency consistency (`pip check`),
TypeScript/Vite production build, frontend HTTP response, API schema, saved
profile retrieval, and Stockfish analysis through the Vite API proxy. A headless
Edge browser loaded the homepage and analysis board, received an engine result,
and reported no JavaScript page errors. This does not validate external LLM/OCR
providers or every training surface. The build reports large bundle warnings.

The UI currently requires a stored username before opening `/coach` or
`/analysis`. Enter a username on the home page; a saved profile can be resumed
without repeating ingestion. The README's suggestion that these sections are
freely accessible without that step does not match the current route guard.
