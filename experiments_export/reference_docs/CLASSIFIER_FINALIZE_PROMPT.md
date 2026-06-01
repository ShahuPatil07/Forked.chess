# Claude Code prompt — finalize threat classifier, wire pipeline, connect frontend

## Context

We have a trained LightGBM threat classifier (`models/threat_lgbm.pkl`) that
classifies chess mistakes into 13 categories. Test accuracy is 63.5%. We are
satisfied and shipping it. This is Stage 1 of the Forked pipeline.

Classification report (test set, 200K examples):
- fork 0.612 f1 | pin 0.557 | skewer 0.582 | discoveredAttack 0.606
- deflection 0.502 | hangingPiece 0.715 | trappedPiece 0.568
- backRankMate 0.912 | removeDefender 0.348 | passingPawn 0.730
- quietMove 0.558 | endgame 0.521 | mate 0.776 | overall 0.635

---

## Task 0 — Align threat_classifier.py with ML model categories

The existing `threat_classifier.py` has 18 categories. The ML model uses 13.
They must match exactly or the hybrid pipeline breaks.

**Final 14 categories (13 classifiable + other) — source of truth:**

```
fork, pin, skewer, discovered_attack, deflection, hanging_piece,
trapped_piece, back_rank, removing_defender, passed_pawn,
piece_activity, endgame_technique, king_attack, other
```

**Delete these 4 functions and their calls from threat_classifier.py:**
- `_is_overloaded_piece` → absorbed into `removing_defender`
- `_is_zwischenzug` → absorbed into `king_attack` (any check fires it)
- `_is_missed_threat` → absorbed into `hanging_piece`
- `_is_pawn_structure` → absorbed into `passed_pawn`

**Remove `move_played_uci` parameter** from `classify_threat()` — it was only
used by the deleted `_is_missed_threat`. New signature: `classify_threat(fen, best_move_uci)`.

**Update priority order** in `classify_threat()`:
`back_rank` first (highest precision 0.912), then fork, pin, skewer,
hanging_piece, discovered_attack, removing_defender, deflection,
trapped_piece, king_attack, passed_pawn, piece_activity, endgame_technique.

**Update all callers** — search codebase, remove the third argument everywhere.

**Write `scripts/verify_category_alignment.py`** — confirms rule-based and
ML encoder use identical labels. Must pass before proceeding.

---

## Task 1 — Fix removeDefender over-prediction

`removeDefender` has precision 0.233 — model over-predicts it, polluting other
classes. Add per-class confidence thresholds in `hybrid_classifier.py`:

- `removing_defender` → 0.75
- `deflection`, `trapped_piece` → 0.65
- `skewer` → 0.60
- all others → 0.55 (default)

---

## Task 2 — Finalize HybridThreatClassifier (4-stage funnel)

Implement `src/classifier/hybrid_classifier.py` with this exact funnel:

- **Stage 0**: eval_drop < 50cp → skip. 50–99cp → "inaccuracy". ≥100cp → classify.
- **Stage 1**: rule-based. Non-"other" result AND pv_length < 3 → done (confidence 1.0).
  If pv_length ≥ 3, run Stage 2 regardless of Stage 1 result.
- **Stage 2**: depth lookahead. Play out Stockfish PV (up to 4 half-moves, stop
  if > 10 legal moves = not forcing). Classify terminal position with rule-based.
  Non-"other" → done (confidence 0.85).
- **Stage 3**: LightGBM. Apply per-class confidence thresholds. Above threshold → done.
- **Stage 4**: log uncertain example (FEN + move + probabilities) for future
  fine-tuning. Return "other".

`ClassificationResult` fields: `threat_type`, `confidence`, `method`, `eval_drop_category`.

Add a thread-safe method counter. Expose `get_method_distribution()` for health checks.
Expected healthy distribution: rule_based ~65%, depth_lookahead ~15%,
ml_model ~12%, ml_model_uncertain <5%.

Wire into annotation pipeline — replace all direct `classify_threat()` calls.
Add `classification_confidence`, `classification_method`, `eval_drop_category`
columns to `MistakeEvent` (with migration).

---

## Task 3 — Unit tests

Write `tests/test_hybrid_classifier.py` with at least 3 known positions covering
back_rank, fork, and hanging_piece. Verify both `threat_type` and `method`.

---


## Task 4 — Generate stage1.md

After all above tasks are complete, generate `stage1.md` in the repo root.
Cover every step of Stage 1 in detail: game fetching, PGN parsing, Stockfish
annotation, mistake extraction, hybrid classification (all 4 stages), persistence.
For each step include: what it does, why, which file/function, input/output,
edge cases, performance. Include ASCII data-flow diagram. Reference real file
paths. Detailed enough that a new developer needs no other context.

---

## Order of execution

0 → verify alignment → 1 → 2 → 3 → 4

Do not proceed past Task 0 until `verify_category_alignment.py` passes.
Generate stage1.md last — it documents the final state.

---

## Definition of done

- [ ] verify_category_alignment.py passes (zero assertions)
- [ ] threat_classifier.py has exactly 14 THREAT_TYPES, 4 functions deleted
- [ ] classify_threat() takes 2 args, all callers updated
- [ ] HybridThreatClassifier 4-stage funnel complete with monitoring
- [ ] MistakeEvent has 3 new columns + migration
- [ ] Unit tests pass for known positions
- [ ] BlindspotCluster model + migration
- [ ] Clustering pipeline runs end-to-end from MistakeEvents → BlindspotClusters
- [ ] Celery chain: Stage 1 → Stage 2 fires every 10 games
- [ ] 4 API endpoints live and auth-protected
- [ ] Frontend dashboard reads from real API, no mock data
- [ ] "Re-analyse" button works with live progress
- [ ] Onboarding triggers analysis and shows progress screen
- [ ] stage1.md complete in repo root
- [ ] No regressions in existing tests
