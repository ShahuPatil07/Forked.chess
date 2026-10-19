# Stage 1 & 2 — Ingestion, Classification and the Blindspot Profile (v2)

Reference for a developer picking up the blindspot pipeline with no prior
context. Measured results live in `reports/stage12_eval/` (see "Evaluation").

---

## Data flow

```
username + platform
   │
   ▼  [1] Fetch                 ml/ingestion/fetcher.py
   │     rated, standard chess, GAME_TIME_CLASSES only (rapid by default)
   ▼  [2] Annotate              ml/ingestion/annotator.py  (+ engine_pool.py, annotation_cache.py)
   │     depth-12 every position → depth-18 on flagged ones; PV + mate kept per
   │     position; cached per game in data/annotation_cache.db
   ▼  [3] Extract (both sides)  ml/ingestion/mistake_extractor.py
   │     mistakes by win-probability loss, mechanism tag (allowed / missed /
   │     both / quiet), tactical opportunities (found / missed), exposure
   ▼  [4] Maia2 personalness    ml/ingestion/maia_annotator.py
   │     P(a player at the mover's real rating avoids this mistake) → weight
   ▼  [5] Classify (batch)      ml/ingestion/classify_events.py
   │     v2 multi-label transformer in the RIGHT framing + deterministic
   │     verifier → soft family probabilities; cascades collapsed
   ▼  [6] Stage 2 profile       ml/clustering/profile.py (via profile_pipeline.run_clustering)
         peer-relative rates, shrinkage, status, direction, hit rate
```

Outputs (`data/output/<user>_*.json`): `mistakes` (user), `peer_mistakes`
(opponents), `opportunities`, `exposure` (moves per game), `game_meta`,
`ingest_stats`, then Stage 2's `clusters` and `profile`.

---

## Stage 1

### Fetch
Lichess: `perfType=rapid&rated=true`, variant standard. Chess.com: archive list
walked newest-first, `rules == "chess"`, `time_class` in GAME_TIME_CLASSES,
rated. `FORKED_TIME_CLASSES=rapid,blitz` widens it. Each game carries ratings,
initial/increment seconds and the user's result.

### Annotate
Two passes per game over N+1 boards. A move is flagged for depth 18 when its
depth-12 win-probability loss is ≥ 4%, or when the depth-12 line shows a tactic
for the mover (so found/missed opportunities are judged at full depth too).
Every position keeps its PV (12 plies) and mate distance, which gives each move
both the mover's best line and the opponent's refutation at no extra cost.
Engine work runs on a pool of single-thread Stockfish processes
(`FORKED_SF_WORKERS`, default min(6, cores−2)) and is cached per game, so
re-runs and reclassification never re-analyse.

### What counts as a mistake
Expected-score loss ≥ 10% (Lichess "mistake"; Lichess inaccuracy = 5%,
blunder = 15%) using Lichess's win-probability curve, and the mover not already
lost (expected score ≥ 0.15). This drops "+9 → +6" non-events and makes mate
scores behave (no 30,000cp drops). See `ml/ingestion/winprob.py`.

### Mechanism — the most important fix
The classifier is trained on Lichess puzzles = (position after a blunder, the
winning reply). A mistake is only in that distribution if we show the
classifier the right position:

| Direction | Meaning | Classified as |
|---|---|---|
| `allowed` | your move created a tactic for the opponent (`allowed_kind`: `walked_into` or `ignored_threat`, from a null-move threat probe) | (position after your move, opponent's refutation) |
| `missed` | you had a tactic and didn't play it | (position before, engine best move) |
| `both` | both | both; family mass mixed by material swing |
| `quiet` | no material/mate swing within 10 plies | (position before, best move); the learned "none" class decides |

Swings are settled material along the PV relative to a baseline that ignores
exchanges in progress (a recapture is not a tactic). `ml/ingestion/mechanism.py`.

The pre-v2 pipeline classified every mistake as (position before, best move).
For an allowed mistake the best move is usually a quiet defence, so the label
was effectively noise.

### Cascades
Consecutive mistakes with one root cause (the opponent didn't cash in the
refutation and you allowed the same thing again, or the same family failed on
the next move) are linked into one incident (`incident_id`, `cascade`). Stage 2
counts incidents.

### Classifier (v2)
`models/stage1_transformer_v2.pt`: the Chessformer encoder fine-tuned from v1
into a 17-way MULTI-LABEL model (`ml/classifier/label_map_v2.py`):
- label space rebuilt from the real Lichess theme vocabulary — v1 keyed classes
  on names that don't exist in the DB (`overloadedPiece`, `zwischenzug`,
  `removeDefender`, `check`, …) so two outputs never trained, and dropped
  `exposedKing`, `defensiveMove`, `discoveredCheck`, `intermezzo`, many mates;
- `endgame` is a phase tag, used as a class only when no motif is present;
- a learned `none` class from 30K Stockfish-mined real-game quiet positions;
- sigmoid/BCE: a puzzle can be fork + discovered attack + mate.
Rebuild: `python -m ml.classifier.transformer.prepare_data`,
`python -m ml.classifier.transformer.mine_negatives`,
`python -m ml.classifier.transformer.train_mt --minutes 170`,
`python -m ml.classifier.transformer.predict --fit-v2` (temperature + OOD ref).
The v1 checkpoint stays as the fallback.

### Verifier
`ml/classifier/verifier.py` ports the relevant detectors from Lichess's own
puzzle tagger (lichess-puzzler `cook.py`): mate, back-rank mate, hanging piece,
fork, discovered attack/check, skewer, pin, capturing the defender, advanced
pawn. Proven motifs are combined with the transformer by noisy-OR weighted by
their measured precision on engine lines (`reports/stage12_eval/verifier_precision.json`).

### Maia2
Run at the players' real ratings. `maia2_prob_safe` = Maia probability mass on
moves losing < 5% expected score; `personal_weight = 0.5 + 0.5 × prob_safe`.
The old hard filter (drop if P(best move) < 0.04 at 1500) is gone — it discarded
positions with many safe moves, i.e. exactly the "walked into it" mistakes.

---

## Stage 2 — the profile (`ml/clustering/profile.py`)

Five fixed families (`families.py`) plus `unclassified`; `cluster_id` is the
family key (contract unchanged; `family_of(threat_type) == cluster_id`).

Per family:
- **rate** — incidents per 100 moves, soft-assigned by `family_probs`, weighted
  by Maia personalness and by game recency (half-life 50 games);
- **peer rate** — the same measured on the opponents in the same games
  (rating-matched, same time control, free);
- **posterior** — Gamma–Poisson shrinkage toward the peer rate (prior worth
  2,000 moves) with an 80% interval and P(you > peers);
- **status** — `confirmed` (P ≥ 0.9, ≥ 5 incidents), `emerging` (P ≥ 0.7),
  `typical`, `strength` (P ≤ 0.15), `insufficient_data` (< 3), then raised by
  a second, independent test: when ≥ 12 opportunities exist on each side and
  P(your hit rate < peers') ≥ 0.95 → `confirmed` (≥ 0.85 → `emerging`).
  `status_reasons` says which test fired. (A player can make an average number
  of mistakes in a family yet miss most of the chances it offers — the
  benchmark's own owner finds 53% of defender-disruption shots vs peers' 85%.)
- **impact / excess** — expected points lost per 10 games, and the part above
  peer level (excess from a higher mistake rate + from missed available
  tactics); **score = 0.75·excess + 0.25·impact** ranks the families;
- **direction** split, **hit rate** (tactics found / available vs peers),
  **context** (ahead/equal/behind, time trouble), and for `unclassified` the
  reason (opening / endgame technique / time trouble / positional).

Clusters carry these under `BlindspotCluster.profile`; the dashboard shows
status, × peers, the allowed/missed mix and hit rate.

---

## Running

```bash
# product path (backend job or programmatic)
from ml.pipeline import run_ingestion
mistakes = run_ingestion("ShahuPatil27", platform="chesscom", min_games=150)

# relabel saved events with the current model + rebuild Stage 2 (no Stockfish)
python -m ml.clustering.reclassify ShahuPatil27

# benchmark accounts (frozen games in data/bench/) and the evaluation
python scripts/run_stage12_bench.py
python scripts/eval_stage12.py --all
```

## Evaluation (`scripts/eval_stage12.py` → `reports/stage12_eval/`)

| | What it measures |
|---|---|
| E1 | classifier on 40K held-out Lichess puzzles (v1 test split) |
| E2 | end-to-end Stage 1 on held-out real-game blunders: right family for allowed and missed mistakes; ablations for framing / retrain / verifier |
| E3 | noise & hygiene on the benchmark accounts (same engine annotations) |
| E4 | split-half stability of the family ranking |
| E5 | predictive validity: profile from older games vs points lost in the next games |
| E6 | gold set: accuracy vs the user's own labels (`scripts/build_gold_set.py` builds the labelling page) |

Unit tests: `tests/test_stage12.py`.

## Key files

| File | Role |
|---|---|
| `ml/pipeline.py` | orchestration, engine pool, output files |
| `ml/ingestion/{fetcher,annotator,annotation_cache,engine_pool}.py` | games → cached engine annotations |
| `ml/ingestion/{winprob,mechanism,mistake_extractor}.py` | mistakes, mechanism, opportunities, cascades |
| `ml/ingestion/{maia_annotator,classify_events}.py` | personalness, classification |
| `ml/classifier/{label_map_v2,verifier}.py`, `ml/classifier/transformer/*` | model, labels, verifier, training |
| `ml/clustering/{families,profile,profile_pipeline,reclassify}.py` | Stage 2 |
| `ml/eval/{legacy,legacy_profile}.py` | the pre-v2 logic, kept only for comparisons |
