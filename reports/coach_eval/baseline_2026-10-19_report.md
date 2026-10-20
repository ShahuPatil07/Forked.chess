# Forked Coach — automated evaluation report

_Generated 2026-10-20 10:50 from `reports\coach_eval\results.jsonl` — 50 conversations, 56 turns._

## Headline numbers

| Metric | Value |
|---|---|
| Turns passing every automated check | **37/56 (66%)** |
| Engine best-move agreement (≤0.30 pawns) | 8/11 (73%) |
| Final answers with zero grounding issues | 51/56 (91%) |
| Expected content present (any / all) | 84% / 84% |
| Forbidden (false) claims avoided | 11/11 (100%) |
| Correct tool chosen when one was required | 5/5 (100%) |
| Within length budget | 91% |
| Follow-up checks (simpler / deeper / memory) | 0/1 · 1/1 · 1/1 |
| Verifier repair rounds triggered | 4 (7% of turns) |
| Latency median / p90 | 4.8s / 13.6s |
| Tool calls per turn (mean) | 2.20 |
| LLM calls / prompt tokens / completion tokens | 139 / 320,047 / 46,025 |
| Answers by model | groq:openai/gpt-oss-120b: 31, groq:qwen/qwen3.8-27b: 21, groq:openai/gpt-oss-20b: 4 |

## By category

| Category | Turns | Pass | Best-move | Grounded | Expected content | Avg words | Avg s |
|---|---|---|---|---|---|---|---|
| player_level | 12 | 58% | 100% | 83% | 88% | 155 | 5.0 |
| difficulty_easy | 2 | 100% | 100% | 100% | 100% | 24 | 1.7 |
| difficulty_medium | 2 | 100% | – | 100% | 100% | 155 | 6.2 |
| difficulty_hard | 2 | 100% | – | 100% | 100% | 156 | 8.8 |
| knowledge | 6 | 83% | – | 100% | 90% | 108 | 3.5 |
| positional | 6 | 83% | 100% | 100% | 89% | 120 | 9.0 |
| tactical | 3 | 33% | – | 100% | 33% | 57 | 13.0 |
| opening_theory | 3 | 67% | – | 67% | 100% | 129 | 8.6 |
| middlegame | 1 | 0% | 0% | 100% | – | 9 | 9.1 |
| endgame_theory | 3 | 33% | 0% | 33% | 50% | 170 | 11.2 |
| history | 4 | 100% | – | 100% | 100% | 127 | 9.1 |
| history_retrieval | 1 | 0% | – | 100% | 0% | 33 | 15.3 |
| history_honesty | 1 | 100% | – | 100% | 100% | 96 | 4.5 |
| long_term_ideas | 2 | 50% | – | 100% | 75% | 234 | 4.8 |
| followup_memory | 8 | 50% | 50% | 100% | 67% | 92 | 5.5 |

## Adaptation to player level (same questions, four audiences)

| Level | Answers | Avg words | Jargon terms / 100 words | Move tokens / 100 words |
|---|---|---|---|---|
| Under 800 | 3 | 146 | 1.2 | 8.1 |
| 800-1200 | 3 | 141 | 0.7 | 9.8 |
| 1200-1600 | 3 | 170 | 1.4 | 8.0 |
| 1600-2000 | 3 | 162 | 0.8 | 11.9 |

## Failed checks

- **level-fork-1** — _What's the best move for Black here, and why?_
  - `expect_all`: missing ['fork|attack(s|ing)? (both|two)|double attack']
- **level-fork-2** — _What's the best move for Black here, and why?_
  - `expect_all`: missing ['fork|attack(s|ing)? (both|two)|double attack']
- **level-fork-3** — _What's the best move for Black here, and why?_
  - `expect_all`: missing ['fork|attack(s|ing)? (both|two)|double attack']
- **level-iqp-2** — _What should each side aim for in this position?_
  - `length`: 269 words (budget 200)
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Bb2. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **level-iqp-3** — _What should each side aim for in this position?_
  - `length`: 248 words (budget 200)
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Bb6, cxd4. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **know-prophylaxis** — _What does prophylaxis mean in chess?_
  - `expect_any`: none of ["Nimzowitsch|Karpov|opponent'?s (plan|idea)"]
- **pos-outpost** — _Why does Black play ...a6 in the Najdorf?_
  - `expect_any`: none of ['b5', 'Nb5|Bb5|b5 square|knight.{0,20}b5']
- **tac-backrank-why** — _Why does Rd8 work here?_
  - `expect_all`: missing ['back rank|pawns? (on f7|block|in front)|no escape|luft']
- **tac-two-knights-line** — _Show me what happens after Ng5 d5 exd5 Nxd5 Nxf7._
  - `expect_any`: none of ['Fried Liver|Kxf7|king']
- **open-sicilian-stats** — _What do masters usually play here and how does it score?_
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: e4. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **mid-iqp-move** — _What's a good move for White here?_
  - `best_move`: check failed: engine event loop dead
- **end-lucena** — _How does White win this rook endgame?_
  - `expect_any`: none of ['bridge|Lucena']
  - `length`: 360 words (budget 200)
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Rda1, Kd6, Rxa2, Kc5. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **end-philidor** — _Black to move. How should Black defend?_
  - `expect_any`: none of ['Ra6|third rank|sixth rank|Philidor']
  - `best_move`: check failed: engine event loop dead
  - `grounding`: These moves are not legal in, or reached by, any position you analysed: Kd3. Check them with a tool (explore_line / evaluate_moves) or remove them.
- **hist-karpov-kasparov-16** — _Load game 16 of the 1985 Karpov–Kasparov world championship match (the famous on_
  - `expect_any`: none of ['Kasparov']
  - `expect_all`: missing ['1985']
- **long-kid-race** — _Explain the long-term race in this position — who attacks where and what decides_
  - `expect_all`: missing ['kingside|f5|g5']
  - `length`: 252 words (budget 200)
- **conv-italian** — _I don't get it, make it simpler._
  - `simpler`: 102 words vs previous 9; 10 move tokens
- **conv-blackburne** — _What happens after Qg5 then?_
  - `expect_any`: none of ['g2|Nxf7|Rg8|Qxg2']
- **conv-blackburne** — _OK, so what should I play instead?_
  - `best_move`: check failed: engine event loop dead
- **conv-blackburne** — _Now explain it like I'm 2000 rated._
  - `length`: 244 words (budget 200)

Full transcripts: [`transcripts.md`](transcripts.md).
