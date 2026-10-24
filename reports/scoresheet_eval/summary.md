# Scoresheet → PGN: evaluation

**Benchmark.** 120 real handwritten tournament scoresheets from the public
[HCS dataset](https://sites.google.com/view/chess-scoresheet-dataset) (Eicher & Majid 2021),
frozen by `scripts/build_scoresheet_bench.py` into `data/bench/scoresheets/` (gitignored):
20 **dev** pages (used for every design decision below) and 100 **test** pages (held out,
not yet run, to keep spend down). Split by game, so both players' sheets of one game
never straddle dev and test.

**Ground truth.** HCS labels copy what the player *wrote*, including the player's own slips
(missing disambiguation, wrong squares, "de", "NxN", skipped moves): only 10 of 207 pages
replay verbatim as a legal game. So two measures:
- **exact-GT prefix**: the plies where the labels replay verbatim as legal moves — exact,
  decoder-free ground truth;
- **reference game**: the legal game the decoder recovers from the human labels. Checked
  independently: fed the human labels, the decoder reproduces 99.3% (3,326/3,350) of the
  verbatim-legal plies, and for the 49 games where both players' sheets exist, the two
  decoded references agree on 80.4% of plies (76.6% before the Maia prior). Much of the
  remaining disagreement is the two players genuinely recording different moves.

Reader: DeepSeek-V4.1-Flash vision (`deepseek-flash`, thinking off). Model calls are cached in
`data/raw/ocr_cache`, so decoder changes are re-evaluated for free.

## Dev split (20 pages), in the order the changes were made

| pipeline | cell reading | plies correct | exact-GT prefix | games ≥95% | fixes / game | silent errors / 100 plies |
|---|---|---|---|---|---|---|
| **previous production**: old prompt + right-half crop, greedy corrector | 62.2% | 21.1% | 73.5% | 10% | 56.8 | 2.4¹ |
| new literal prompt, greedy corrector | 76.6% | 19.8% | 73.9% | 5% | 57.6 | 2.2¹ |
| new prompt + **beam-search decoder** | 76.6% | 60.8% | 85.7% | 20% | 28.2 | 14.2 |
| + column tiles, ensembled with the full read | 74.3% | 60.9% | 86.8% | 25% | 27.8 | 10.4 |
| + targeted multiple-choice re-read of doubtful cells | 77.0% | 62.6% | 88.5% | 30% | 26.8 | 11.0 |
| + 2-sample voting | 79.9% | 63.1% | 88.9% | 25% | 26.5 | 9.2 |
| + contrast enhancement + row bands (instead of columns) | 79.9% | 69.5% | 89.5% | 15% | 22.0 | 8.6 |
| + **proofread every decoded move** | 82.6% | 73.3% | 88.5% | 40% | 18.5 | 10.2 |
| + wider beam (28 → 64) | **82.8%** | **74.7%** | **92.0%** | 30% | **18.1** | 9.4 |

¹ The old corrector stops at the first move it can't place, so it emits few wrong moves —
most of the game is simply missing (21% of plies correct, ~57 edits per game).

- *cell reading*: reader output vs the literal human transcription, per cell.
- *plies correct*: decoded game vs reference, position by position (a game shifted by one move counts as wrong from there on).
- *fixes / game*: move edits needed to turn the output into the reference.
- *silent errors*: wrong plies shown as confident (not highlighted for review).

Per page (last row): 10 of 20 sheets come out ≥90% correct (5 of them ≥97%), 4 at 77–80%,
and 5 sheets of very hard handwriting (≤62% of cells legible to the model) under 50%.

## Production configuration

To keep cost down the production default is **one read sample** (full page + 4 row bands)
plus the proofreading pass: ~9 calls, **about $0.004 per sheet**, ~12–15 s. The table's last
row used two read samples (~$0.007 per sheet); the second sample was worth about +0.5 points
of plies correct on dev. Set `SCORESHEET_SAMPLES=2` to turn it back on. The single-sample
configuration and the 100-page test split have not been evaluated yet (estimated $0.40 for
the test split).

Total evaluation spend for everything above: $0.59 (`data/ocr_spend.json`).

## Reproduce

    python scripts/build_scoresheet_bench.py                 # needs data/raw/hcs/pages (HCS download)
    python scripts/eval_scoresheets.py --split dev --variants old,pipeline-bands
    python scripts/eval_scoresheets.py --split test --variants pipeline-bands   # held-out run (~$0.40)
