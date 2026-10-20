# Forked Coach — automated evaluation report

_Generated 2026-10-20 13:28 from `reports\coach_eval\v3_results.jsonl` — 73 conversations, 88 turns._

## Headline numbers

| Metric | Value |
|---|---|
| Turns passing every automated check | **68/88 (77%)** |
| Engine best-move agreement (≤0.30 pawns) | 11/11 (100%) |
| Final answers with zero grounding issues | 77/88 (88%) |
| Expected content present (any / all) | 93% / 87% |
| Forbidden (false) claims avoided | 12/12 (100%) |
| Correct tool chosen when one was required | 12/12 (100%) |
| Within length budget | 100% |
| Follow-up checks (simpler / deeper / memory) | 1/2 · 2/2 · 1/1 |
| Verifier repair rounds triggered | 55 (62% of turns) |
| Latency median / p90 | 9.9s / 17.6s |
| Tool calls per turn (mean) | 2.61 |
| LLM calls / prompt tokens / completion tokens | 294 / 720,639 / 91,094 |
| Answers by model | deepseek:deepseek-flash: 84, groq:openai/gpt-oss-120b: 4 |

## By category

| Category | Turns | Pass | Best-move | Grounded | Expected content | Avg words | Avg s |
|---|---|---|---|---|---|---|---|
| player_level | 12 | 67% | 100% | 100% | 83% | 116 | 10.8 |
| difficulty_easy | 2 | 100% | 100% | 100% | 100% | 106 | 7.3 |
| difficulty_medium | 2 | 50% | – | 100% | 75% | 127 | 11.5 |
| difficulty_hard | 2 | 100% | – | 100% | 100% | 144 | 12.6 |
| knowledge | 6 | 17% | – | 33% | 80% | 132 | 7.4 |
| positional | 6 | 67% | 100% | 83% | 89% | 153 | 14.5 |
| tactical | 3 | 100% | – | 100% | 100% | 121 | 11.9 |
| opening_theory | 3 | 67% | – | 67% | 100% | 116 | 7.4 |
| middlegame | 1 | 100% | 100% | 100% | – | 106 | 6.3 |
| endgame_theory | 3 | 67% | 100% | 100% | 75% | 141 | 13.1 |
| history | 4 | 50% | – | 50% | 100% | 113 | 8.1 |
| history_retrieval | 1 | 0% | – | 0% | 50% | 121 | 19.1 |
| history_honesty | 1 | 100% | – | 100% | 100% | 111 | 8.6 |
| long_term_ideas | 2 | 100% | – | 100% | 100% | 143 | 13.8 |
| followup_memory | 17 | 94% | 100% | 94% | 100% | 122 | 14.1 |
| agentic | 5 | 100% | – | 100% | 100% | 80 | 13.0 |
| improvement_advice | 4 | 100% | – | 100% | 100% | 135 | 3.2 |
| robustness | 6 | 83% | – | 83% | 83% | 111 | 6.5 |
| game_review | 6 | 83% | – | 100% | 100% | 114 | 11.3 |
| counterfactual | 2 | 100% | – | 100% | 100% | 74 | 7.0 |

## Adaptation to player level (same questions, four audiences)

| Level | Answers | Avg words | Jargon terms / 100 words | Move tokens / 100 words |
|---|---|---|---|---|
| Under 800 | 3 | 92 | 0.2 | 9.0 |
| 800-1200 | 3 | 123 | 0.2 | 7.7 |
| 1200-1600 | 3 | 126 | 1.3 | 8.5 |
| 1600-2000 | 3 | 124 | 0.2 | 10.3 |

## Failed checks

- **level-fork-0** — _What's the best move for Black here, and why?_
  - `expect_all`: missing ['fork|attack(s|ing)? (both|two)|double attack']
- **level-iqp-1** — _What should each side aim for in this position?_
  - `expect_any`: none of ['isolat', 'd4[- ]pawn|pawn on d4']
- **level-kpk-0** — _Is this winning for White? What's the key idea?_
  - `expect_all`: missing ['opposition|king in front|key square']
- **level-kpk-3** — _Is this winning for White? What's the key idea?_
  - `expect_all`: missing ['opposition|king in front|key square']
- **medium-two-knights** — _Is Ng5 a good move here?_
  - `expect_any`: none of ['f7']
- **know-en-passant** — _Explain en passant in simple words._
  - `expect_all`: missing ['immediately|right away|next move|only on']
- **know-zugzwang** — _What is zugzwang? Give me a simple example._
  - `expect_all`: missing ['(have|has|forced) to move|obliga|any move']
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Kd4, Kc6, Kd5, Kd7. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **know-stalemate** — _What's the difference between checkmate and stalemate?_
  - `grounding`: These piece placements don't match the board or any analysed line: king on g6. Re-read CURRENT BOARD and fix them.
- **know-minority** — _What is a minority attack and in which structure does it usually appear?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: cxb5, bxc6. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **know-prophylaxis** — _What does prophylaxis mean in chess?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Ne4. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **pos-carlsbad-plan** — _What is White's long-term plan in this structure?_
  - `expect_any`: none of ['minority attack|b4.{0,40}b5|b4-b5']
- **pos-kid-plans** — _What are the typical plans for both sides here?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Ne7. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **open-italian-idea** — _What is the main idea behind the Italian Game?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Re1, Ba7. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **end-lucena** — _How does White win this rook endgame?_
  - `expect_any`: none of ['bridge|Lucena']
- **hist-game-of-century** — _What was the 'Game of the Century'?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Bxb6, Bxc4, Kg1, Kf1. Check them with a tool (explore_line / evaluate_moves) or remove them.; These piece placements don't match the board or any analysed line: queen on b6. Re-read CURRENT BOARD and fix them.
- **hist-karpov-kasparov-16** — _Load game 16 of the 1985 Karpov–Kasparov world championship match (the famous on_
  - `expect_all`: missing ['1985']
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Nd3, Bd6, Rc8, Qxd3. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **hist-opera** — _Who played the Opera Game and why is it famous?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Qb8, Nxb8, Rd8, Bg4. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **conv-history** — _What happened in the first game of that match?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Bxh2, Bg1. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **rob-lowercase** — _is nf3 a good first move?_
  - `expect_any`: none of ['good|fine|solid|popular|main']
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Bg2. Check them with a tool (explore_line / evaluate_moves) or remove them.; These piece placements don't match the board or any analysed line: bishop on g2. Re-read CURRENT BOARD and fix them.
- **review-bad-b5** — _Explain it simpler_
  - `simpler`: 98 words vs previous 113; 12 move tokens

Full transcripts: [`v3_transcripts.md`](v3_transcripts.md).
