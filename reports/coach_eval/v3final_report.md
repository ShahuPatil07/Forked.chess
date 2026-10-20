# Forked Coach — automated evaluation report

_Generated 2026-10-20 13:51 from `reports\coach_eval\v3final_results.jsonl` — 73 conversations, 88 turns._

## Headline numbers

| Metric | Value |
|---|---|
| Turns passing every automated check | **66/88 (75%)** |
| Engine best-move agreement (≤0.30 pawns) | 10/11 (91%) |
| Final answers with zero grounding issues | 78/88 (89%) |
| Expected content present (any / all) | 93% / 93% |
| Forbidden (false) claims avoided | 12/12 (100%) |
| Correct tool chosen when one was required | 12/12 (100%) |
| Within length budget | 98% |
| Follow-up checks (simpler / deeper / memory) | 0/2 · 2/2 · 1/1 |
| Verifier repair rounds triggered | 57 (65% of turns) |
| Latency median / p90 | 11.6s / 22.9s |
| Tool calls per turn (mean) | 3.05 |
| LLM calls / prompt tokens / completion tokens | 319 / 970,354 / 113,499 |
| Answers by model | deepseek:deepseek-flash: 86, groq:openai/gpt-oss-120b: 2 |

## By category

| Category | Turns | Pass | Best-move | Grounded | Expected content | Avg words | Avg s |
|---|---|---|---|---|---|---|---|
| player_level | 12 | 83% | 100% | 92% | 96% | 148 | 16.4 |
| difficulty_easy | 2 | 100% | 100% | 100% | 100% | 93 | 4.3 |
| difficulty_medium | 2 | 100% | – | 100% | 100% | 116 | 9.4 |
| difficulty_hard | 2 | 100% | – | 100% | 100% | 134 | 12.6 |
| knowledge | 6 | 67% | – | 67% | 100% | 133 | 11.2 |
| positional | 6 | 50% | 0% | 83% | 89% | 143 | 14.9 |
| tactical | 3 | 67% | – | 100% | 67% | 129 | 17.7 |
| opening_theory | 3 | 100% | – | 100% | 100% | 121 | 8.8 |
| middlegame | 1 | 100% | 100% | 100% | – | 148 | 11.6 |
| endgame_theory | 3 | 67% | 100% | 100% | 75% | 140 | 18.9 |
| history | 4 | 75% | – | 75% | 100% | 124 | 9.9 |
| history_retrieval | 1 | 0% | – | 100% | 0% | 23 | 19.2 |
| history_honesty | 1 | 100% | – | 100% | 100% | 126 | 7.3 |
| long_term_ideas | 2 | 100% | – | 100% | 100% | 169 | 13.7 |
| followup_memory | 17 | 65% | 100% | 82% | 80% | 112 | 15.8 |
| agentic | 5 | 80% | – | 80% | 100% | 105 | 12.6 |
| improvement_advice | 4 | 100% | – | 100% | 100% | 141 | 4.7 |
| robustness | 6 | 67% | – | 83% | 100% | 128 | 6.8 |
| game_review | 6 | 67% | – | 100% | 100% | 114 | 14.6 |
| counterfactual | 2 | 100% | – | 100% | 100% | 138 | 6.9 |

## Adaptation to player level (same questions, four audiences)

| Level | Answers | Avg words | Jargon terms / 100 words | Move tokens / 100 words |
|---|---|---|---|---|
| Under 800 | 3 | 143 | 0.2 | 7.9 |
| 800-1200 | 3 | 151 | 0.2 | 8.7 |
| 1200-1600 | 3 | 146 | 1.8 | 10.1 |
| 1600-2000 | 3 | 153 | 1.5 | 12.8 |

## Failed checks

- **level-kpk-0** — _Is this winning for White? What's the key idea?_
  - `grounding`: These piece placements don't match the board or any analysed line: pawn on e5. Re-read CURRENT BOARD and fix them.
- **level-kpk-1** — _Is this winning for White? What's the key idea?_
  - `expect_all`: missing ['opposition|king in front|key square']
- **know-castling** — _Can I castle when my king is in check, or through an attacked square?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: O-O, O-O-O. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **know-zugzwang** — _What is zugzwang? Give me a simple example._
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Kb5, Kb4. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **pos-french-bishop** — _Why is Black's light-squared bishop on c8 often called bad in this structure?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Ba4. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **pos-french-plan** — _What is Black's plan with Qb6?_
  - `expect_any`: none of ['b2|pressure|attack(s|ing)? (the )?d4']
- **pos-italian-quiet** — _Nothing tactical is happening. How should White improve the position?_
  - `best_move`: d4 vs best h3 (+0.24)
- **tac-backrank-why** — _Why does Rd8 work here?_
  - `expect_all`: missing ['back rank|pawns? (on f7|block|in front)|no escape|luft']
- **end-lucena** — _How does White win this rook endgame?_
  - `expect_any`: none of ['bridge|Lucena']
- **hist-karpov-kasparov-16** — _Load game 16 of the 1985 Karpov–Kasparov world championship match (the famous on_
  - `expect_any`: none of ['Kasparov']
  - `expect_all`: missing ['1985']
- **hist-opera** — _Who played the Opera Game and why is it famous?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Nxb8. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **conv-italian** — _I don't get it, make it simpler._
  - `simpler`: 89 words vs previous 129; 14 move tokens
- **conv-carlsbad** — _What's White's long-term plan?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: bxc6. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **conv-carlsbad** — _How should Black counter it?_
  - `expect_any`: none of ['kingside|Ne4|Ne4|f5|counterplay|a5|c6']
- **conv-lucena** — _How does White win?_
  - `grounding`: These piece placements don't match the board or any analysed line: pawn on b8. Re-read CURRENT BOARD and fix them.
- **conv-history** — _What happened in the first game of that match?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Bb4, Bxc3. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **conv-history** — _And the second game?_
  - `expect_any`: none of ["forfeit|didn'?t show|did not show|default"]
- **agent-pgn-review** — _Review this game and show me the three most important moments:
[Event "Paris"]
[_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: cxb5, Bxd7. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **rob-illegal-move** — _Why is Qh5 so strong here?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Qh5. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **rob-offtopic** — _What's the best pizza topping?_
  - `length`: 102 words (budget 80)
- **review-bad-b5** — _Explain it simpler_
  - `simpler`: 79 words vs previous 108; 12 move tokens
- **review-good-nf3** — _Why is e4 a good opening move?_
  - `length`: 127 words (budget 110)

Full transcripts: [`v3final_transcripts.md`](v3final_transcripts.md).
