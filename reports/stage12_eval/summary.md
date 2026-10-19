# Stage 1 / Stage 2 evaluation — legacy vs v2

## E1 — classifier on held-out Lichess puzzles

40,056 puzzles from the v1 test split (neither model trained on them). Hit = the predicted motif / family is one of the puzzle's Lichess themes.

| | v1 (83.1% model) | v2 |
|---|---|---|
| Motif hit@1 | 82.2% | 88.0% |
| Family hit@1 | 86.3% | 91.8% |
| v1's own single-label accuracy | 83.0% | n/a |

## E2 — end-to-end Stage 1 on held-out real-game blunders

Real game positions behind held-out puzzles. *Allowed*: the player's blunder allowed the puzzle tactic. *Missed*: the player then failed to find it (second-best move). Score = the pipeline's family is one of the tactic's families.

| Pipeline | Allowed: family right | Allowed: unclassified | Missed: family right |
|---|---|---|---|
| legacy_v1_before_best | 29.4% | 13.9% | 74.5% |
| v2stage1_v1model | 73.1% | 7.0% | 71.5% |
| v2stage1_v1model_verifier | 73.9% | 6.0% | 72.3% |
| v2stage1_v2model | 84.9% | 6.1% | 88.1% |
| v2stage1_v2model_verifier (production) | 86.7% | 5.5% | 89.6% |

Direction detected correctly: allowed 93.1%, missed 93.6% (n = 1393 / 1487).

## E3 — noise & hygiene on benchmark accounts (identical engine annotations)

| Account | Legacy mistakes | …of which <10% win-chance loss | Legacy 'opening' | v2 mistakes | v2 incidents | v2 'opening' | Legacy unclassified | v2 unclassified |
|---|---|---|---|---|---|---|---|---|
| ShahuPatil27 | 503 | 25.0% | 44.1% | 491 | 437 | 11.0% | 20.3% | 44.6% |
| semilore17 | 383 | 22.7% | 41.0% | 371 | 341 | 11.9% | 19.6% | 48.5% |
| MinnowMate | 407 | 28.0% | 47.2% | 364 | 324 | 4.9% | 16.5% | 45.3% |
| sambartiquel | 368 | 24.5% | 57.9% | 362 | 331 | 19.9% | 25.5% | 45.0% |
| Pilkification | 394 | 27.9% | 43.7% | 355 | 322 | 16.3% | 15.5% | 46.5% |

## E4 — split-half stability of the family ranking

Games split randomly in half 30× per account; Spearman correlation of the 5 family scores between halves.

| Variant | Spearman | Same #1 family |
|---|---|---|
| legacy_labels+legacy_scoring | 0.922 | 93.3% |
| v2_labels+legacy_scoring | 0.683 | 42.0% |
| v2_labels+v2_scoring | 0.815 | 82.7% |

## E5 — predictive validity (labels fixed to v2, so this isolates Stage-2 scoring)

Profile from older games vs the next 20% of games, 4 cut points per account.

| Scoring | Spearman vs future points lost | NDCG@2 | #1 family in future top-2 | Spearman vs future excess over peers |
|---|---|---|---|---|
| legacy_scoring | 0.592 | 0.887 | 80.0% | 0.104 |
| v2_scoring | 0.738 | 0.962 | 95.0% | 0.082 |
