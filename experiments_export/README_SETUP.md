# Experiment repo — setup

Read `TAKEAWAY.md` first for what to build and why. This file gets you running.

## 1. Python env

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux

pip install python-chess numpy pyarrow scikit-learn lightgbm joblib umap-learn
# Stage 1 transformer + Stage 2 CSAE:
pip install torch --index-url https://download.pytorch.org/whl/cpu
# Stage 2 only, if you use Maia2 embeddings:
pip install maia2
# Stage 2 baseline only, if you re-run the Groq labeller:
pip install groq
```

`requirements_baseline.txt` in this folder lists the exact baseline deps.

## 2. Suggested layout in the new repo

Keep the imports working with the least friction by mirroring the package paths
the files already use (`from ml.classifier... import`, `from ml.ingestion...`):

```
experiment-repo/
  ml/
    __init__.py
    config.py                  ← shared/config.py (trim paths)
    classifier/
      __init__.py
      features.py              ← stage1_classifier/features.py
      label_map.py             ← stage1_classifier/label_map.py
      hybrid_classifier.py     ← stage1_classifier/hybrid_classifier.py
    ingestion/
      __init__.py
      threat_classifier.py     ← stage1_classifier/threat_classifier.py
      mistake_extractor.py     ← stage2_clustering/mistake_extractor.py
      maia_annotator.py        ← stage2_clustering/maia_annotator.py
      annotator.py             ← (only the PositionAnnotation dataclass is needed;
                                   mistake_extractor.py imports it — copy a stub
                                   or the real file from the main repo)
    clustering/
      __init__.py
      feature_extractor.py     ← stage2_clustering/feature_extractor.py
      pipeline.py              ← stage2_clustering/pipeline.py
      blindspot.py             ← stage2_clustering/blindspot.py
      labeller.py              ← stage2_clustering/labeller.py
  scripts/
    build_training_data.py     ← stage1_classifier/build_training_data.py
    train_classifier.py        ← stage1_classifier/train_classifier.py
    evaluate_classifier.py     ← stage1_classifier/evaluate_classifier.py
    run_clustering.py          ← stage2_clustering/run_clustering.py
  experiments/                 ← YOUR new code goes here
    stage1_transformer/
    stage2_csae/
  data/                        ← copied datasets (below)
  models/                      ← trained artifacts land here
```

Add empty `__init__.py` files where shown. `threat_classifier.py` is needed by
both `hybrid_classifier.py` and `feature_extractor.py` (it exports
`THREAT_TYPES` and `PIECE_VALUES`), so it sits in both experiments' dependency
graphs — copy it once into `ml/ingestion/`.

> `mistake_extractor.py` imports `PositionAnnotation` from
> `ml.ingestion.annotator`. You only need that dataclass to reconstruct events
> from JSON, and `run_clustering.py` rebuilds `MistakeEvent` straight from JSON
> dicts anyway — if you only do Stage 2 from saved `_mistakes.json`, you can
> stub `annotator.py` with just the `PositionAnnotation` dataclass.

## 3. Datasets to copy (not in this bundle — too large for git)

From the main repo's `data/`:

| Path | Size | Used by |
|---|---|---|
| `data/processed/train.parquet` | ~172 MB | Stage 1 training |
| `data/processed/val.parquet`   | ~21 MB  | Stage 1 early stopping |
| `data/processed/test.parquet`  | ~21 MB  | Stage 1 eval (the scoreboard) |
| `data/puzzles/meta.json` + `index.npz` + `ids.txt` + `themes.txt` | ~32 MB | optional raw FEN+theme source |
| `data/output/ShahuPatil27_mistakes.json` | small | Stage 2 real input |
| `data/output/ShahuPatil27_clusters.json` | small | Stage 2 baseline output to beat |

If `processed/*.parquet` is missing, regenerate it (slow, downloads the ~700 MB
Lichess puzzle DB once):

```bash
python scripts/build_training_data.py --resume --max 2000000
```

## 4. Reproduce the baselines first (always do this before experimenting)

```bash
# Stage 1 baseline (LightGBM). Produces models/threat_lgbm.pkl + label_encoder.pkl
python scripts/train_classifier.py
python scripts/evaluate_classifier.py --split test    # ← record these numbers

# Stage 2 baseline (UMAP + HDBSCAN + Groq). Needs GROQ_API_KEY for naming,
# but clustering itself runs without it (labels just stay "Cluster N").
python scripts/run_clustering.py ShahuPatil27
```

Lock those numbers in — they're what your transformer / CSAE has to beat on the
**same** test split and the **same** user files.

## 5. Env vars

- `GROQ_API_KEY` — only for the Stage-2 *baseline* LLM labeller. The CSAE
  experiment aims to remove this dependency entirely.
- `STOCKFISH_PATH` — only if you roll out trajectories with Stockfish for the
  CSAE; point it at a Stockfish binary. Not needed to train Stage 1 from the
  parquet files.
