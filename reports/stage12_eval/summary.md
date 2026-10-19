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
| v2stage1_v1model | 73.2% | 6.8% | 71.6% |
| v2stage1_v1model_verifier | 74.0% | 5.8% | 72.4% |
| v2stage1_v2model | 84.9% | 6.1% | 88.1% |
| v2stage1_v2model_verifier (production) | 86.7% | 5.5% | 89.6% |

Direction detected correctly: allowed 93.1%, missed 93.6% (n = 1393 / 1487).

## E3 — noise & hygiene on benchmark accounts (identical engine annotations)

| Account | Legacy mistakes | …of which <10% win-chance loss | Legacy 'opening' | v2 mistakes | v2 incidents | v2 'opening' | Legacy unclassified | v2 unclassified |
|---|---|---|---|---|---|---|---|---|
| ShahuPatil27 | 503 | 25.0% | 44.1% | 966 | 814 | 14.2% | 20.3% | 22.7% |
| semilore17 | 383 | 22.7% | 41.0% | 721 | 631 | 18.3% | 19.6% | 25.0% |
| MinnowMate | 407 | 28.0% | 47.2% | 676 | 576 | 10.8% | 16.5% | 24.4% |
| sambartiquel | 368 | 24.5% | 57.9% | 697 | 611 | 26.1% | 25.5% | 23.4% |
| Pilkification | 394 | 27.9% | 43.7% | 751 | 642 | 22.0% | 15.5% | 22.0% |

## E4 — split-half stability of the family ranking

Games split randomly in half 30× per account; Spearman correlation of the 5 family scores between halves.

| Variant | Spearman | Same #1 family |
|---|---|---|
| legacy_labels+legacy_scoring | 0.922 | 93.3% |
| v2_labels+legacy_scoring | 0.843 | 100.0% |
| v2_labels+v2_scoring | 0.890 | 94.0% |

## E5 — predictive validity (labels fixed to v2, so this isolates Stage-2 scoring)

Profile from older games vs the next 20% of games, 4 cut points per account.

| Scoring | Spearman vs future points lost | NDCG@2 | #1 family in future top-2 | Spearman vs future excess over peers |
|---|---|---|---|---|
| legacy_scoring | 0.781 | 0.972 | 100.0% | 0.256 |
| v2_scoring | 0.835 | 0.996 | 100.0% | 0.200 |

## E6 — gold set (your labels)

- **ShahuPatil27**: labelled = 150, legacy_family_accuracy_all_flagged = 0.23, legacy_family_n_all_flagged = 74, v2_family_accuracy_all_flagged = 0.308, v2_family_n_all_flagged = 78, legacy_family_accuracy_flagged_by_both = 0.225, legacy_family_n_flagged_by_both = 71, v2_family_accuracy_flagged_by_both = 0.324, v2_family_n_flagged_by_both = 71, v2_human_family_among_attached = 0.59, v2_mean_families_attached = 1.85, v2_flags_legacy_only_items_now = 0.8, v2_direction_accuracy = 0.686, v2_direction_n = 137, not_a_mistake_share[legacy-flagged] = 0.075, not_a_mistake_share[both-flagged] = 0.029, not_a_mistake_share[v2-flagged] = 0.0
