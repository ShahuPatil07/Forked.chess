# Testing Forked's first position investigation milestone

## Start here

Open `http://localhost:5173`, resume your saved username (for example
`ShahuPatil27`), and open Coach. Choose **Position**. If the questionnaire appears,
**Investigate a position now** opens the same tool without completing onboarding.

Paste a complete FEN. The **Your move** and **Alternative** fields accept SAN
(`Nf6+`) or UCI (`d5f6`). Ask the question in the message box and send it.
Position mode retains the FEN for follow-up questions. A new FEN resets the move
fields. Choose candidates to inspect, click the variation's moves to replay
them, and select independently searched replies to compare defenses.

First turn **Use AI wording** off: this checks the local evidence and factual
template. Then repeat with it on: this checks whether the narration actually
teaches the idea without adding unsupported claims. Search results can vary a
little between runs because the live engine's hash is shared. For an identical
evidence comparison, use `/api/coach/investigate` once and inspect its saved JSON
alongside its AI narration, or use the paired evaluation runner below.

The engine budget is 3, 8, or 15 seconds and includes waiting for the engine.
AI narration has its own network timeout; total response time can exceed the
engine budget. Partial analysis is shown explicitly. A provider failure returns
the local evidence summary rather than losing the result.
Conservative evidence checks also reject some narration errors (invented moves,
overstated defense coverage, terminal draw claims, and mismatched gap language).
When a check rejects AI wording, the UI identifies the fallback. The checks do
not certify arbitrary prose; please still inspect the actual explanation.

## Suggested manual tests

### 1. Immediate mate versus a quiet alternative

```text
7k/6pp/8/8/8/8/R7/K7 w - - 0 1
```

Your move: `Ra8#`. Alternative: `Ra3`.
Question: **Why is Ra8 better than Ra3? What replies does Black have?**

Expected: Ra8 is checkmate, verified directly on the board. Black has no legal
reply. Ra3 is analyzed separately. A mate score must not become a huge invented
centipawn advantage or a material-based explanation.

### 2. A royal fork that saves a draw, rather than winning the game

```text
8/3q3k/8/3N4/8/8/8/6K1 w - - 0 1
```

Your move: `Nf6+`. Alternative: `Ne3`.
Question: **Why does Nf6 work? If I win the queen, do I win the game?**

Expected: the knight checks the king on h7 and attacks the queen on d7. Check
and attacks are verified board facts. The searched replies support the material
gain. After the queen is captured, king and knight versus king is an insufficient
material draw. The Coach must not call this a won game merely because a queen
was captured. Lines stop at the terminal draw.

Follow up: **Make that simpler, as if I am rated 1000.** Then: **Show the strongest
reply and explain why Ne3 differs.** The board must stay on this FEN; inspect
whether the wording is clearer without changing the chess facts.

### 3. A capture that loses material after a recapture

```text
6k1/8/3p4/4r3/4Q3/8/8/6K1 w - - 0 1
```

Your move: `Qxe5`. Alternative: `Qd3`.
Question: **Does capturing the rook win material? What happens after dxe5?**

Expected: Qxe5 captures a rook, but dxe5 captures the queen. Count both moves:
winning a rook and losing a queen costs four material points using the project's
standard piece values. A claim that the move wins material should be rejected
or left uncertain if the tested lines conflict. The system should also distinguish
losing material from proving that a sacrifice is unsound.

### 4. Black to move and score direction

```text
k7/r7/8/8/8/8/6PP/7K b - - 0 1
```

Your move: `Ra1#`. Alternative: `Ra6`.
Question: **Who is mating whom? Why is Ra1 best for Black?**

Expected: Black mates in one. Ordinary negative scores favor Black; candidates
must be ordered for Black, not by the largest White advantage. Labels must say
White/Black rather than assume which color you play.

### 5. Quiet opening moves: resist a fabricated causal story

```text
r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3
```

Your move: `a6`. Alternative: `Nf6`.
Question: **Why is a6 better than Nf6? Is it definitely better, or are both playable?**

Expected: actual candidate lines and replies, clear evaluation perspective,
and honest uncertainty. The system must not invent a forced tactical reason,
declare a tiny gap decisive, or claim that a numerical preference proves a
strategic cause. The current hypothesis checks focus on concrete tactics and
material; this case is deliberately useful for exposing that limitation.

Repeat with Quick and Deeper analysis. If the ranking changes, the narration
should acknowledge search uncertainty rather than defend the earlier claim.

### 6. A move outside the usual top candidates

```text
rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
```

Your move: `e4`. Alternative: `a3`.
Question: **Compare e4 and a3. Analyze a3 even if the engine would not suggest it.**

Expected: a3 appears with the **alternative** label, has its own search, and
receives a reply check if the budget permits. The response must not silently
replace your alternative with another candidate.

### 7. Promotion and special-move correctness

```text
7k/P7/8/8/8/8/8/K7 w - - 0 1
```

Your move: `a8=Q+`. Alternative: `a8=N`.
Question: **What changes if I promote to a knight rather than a queen?**

Expected: the promotion piece is preserved in the board and UCI move. Knight
promotion produces an insufficient material draw; the queen line is evaluated
separately. Try UCI `a7a8q` and `a7a8n` as well.

For en passant, use:

```text
6k1/8/8/3pP3/8/8/8/6K1 w - d6 0 1
```

Your move: `exd6`. Alternative: `e6`. The captured pawn is on d5, although the
capturing pawn moves to d6. Inspect the replay and capture evidence.

### 8. Invalid inputs, terminal boards, and limited budgets

- With the initial-position FEN, set **Your move** to `e2e5`: expect a clear
  legality error, without an invented variation or a broken board.
- Paste `8/8/8/8/8/8/8/8 w - - 0 1`: expect a legal-position error because kings
  are missing.
- Paste `7k/5Q2/6K1/8/8/8/8/8 b - - 0 1` and leave move fields empty: expect
  stalemate, no candidate recommendation, and zero engine calls.
- Run a complex position on Quick analysis: incomplete reply checks or unequal
  depths must be visible. Repeat on Deeper and compare the evidence.
- Turn AI wording off: the entire investigation must still work locally.

## Feedback that will help us improve the approach

For each position, note whether the recommendation was correct, the explanation
actually answered **why this move instead of the alternative**, every cited move
was legal, uncertainty was appropriate, and the result taught you something.

Use **Analysis details and evidence → Download evidence for feedback**. Include
the question, focus/alternative moves, a concrete incorrect sentence or missing
idea, your expected explanation, and whether AI wording was on. The JSON captures
engine name, depths, budget, hypotheses, supporting/contradicting evidence, and
the local factual summary. Chat prose is separate; include the sentence you're
critiquing alongside the file.

Score each explanation from 1 to 5 for factual correctness, causal relevance,
completeness, and usefulness. Count unsupported claims separately. A correct
best move with a generic explanation is not a successful reasoning result.

## Automated checks and paired evaluation

```powershell
& .\.venv\Scripts\python.exe -m pytest tests/test_coach_investigation.py -q -p no:cacheprovider

# Local paired evidence runs; no hosted LLM required.
& .\.venv\Scripts\python.exe scripts/evaluate_coach.py --budget 3 --limit 30

# Optional paired narration with the same Groq model/settings in both arms.
& .\.venv\Scripts\python.exe scripts/evaluate_coach.py --budget 8 --limit 30 --llm
```

Outputs go to `results/coach/`. The runner clears engine hash between arms and
records engine configuration, actual elapsed time, prompts, and LLM settings.
Wall-time searches can vary across machines. Both arms receive the same maximum
time budget, but their actual cost and completed depths differ; inspect those
alongside quality. Narration fallbacks are labeled and must not be scored as
successful hosted-LLM pairs. Review fields start empty for you to fill in.

`tests/fixtures/coach_positions.json` contains 30 project-authored seed positions
whose legality is automatically checked. Their explanation quality is pending
human review. They cover the requested first categories but are not yet a mature
difficult-position benchmark. Add your real difficult positions as feedback arrives.

## API configuration

The existing `.env` Groq key is reused. The prior `llama-3.3-70b-versatile` default
returned `model_not_found` for this key. Chat, evidence narration and Coach memory
now share `FORKED_COACH_MODEL`, defaulting to `openai/gpt-oss-120b`, which appeared
in the key's accessible model list. Groq documents its text generation and tool
support in [the model documentation](https://console.groq.com/docs/model/openai/gpt-oss-120b).

To override the model, set `FORKED_COACH_MODEL` in `.env` and restart the backend.
The existing optional C1 endpoint remains available for narration after evidence
collection. No provider is required for local investigation; no new dependencies
or API keys are required for this milestone.

## Current research limits

Hypothesis generation currently uses deterministic board features and material
changes, then checks them against additional engine reply searches. It is a
bounded investigation loop, not a general verifier for arbitrary LLM strategic
claims. It samples up to two opponent replies per relevant move and separately
enumerates all legal first replies. Simple terminal continuations are tested
against every first reply when possible. A verified
attack is not proof that the attacked piece is lost. A PV reaching checkmate does
not prove every defense loses. AI wording remains a synthesis to review; its
sentences are not automatically marked verified by the backend.

The next useful improvement should be chosen from your feedback: deeper defense
coverage, quiet-move hypotheses, or better explanations from the existing evidence.
