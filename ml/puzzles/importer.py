"""
Lichess puzzle importer — downloads the Lichess puzzle CSV, extracts features for
each position, and saves a search index that Stage 3 can query.

The full puzzle DB is ~50M rows / 7GB compressed. For MVP we download a sample
(default 100K puzzles) which is enough to cover all blindspot clusters.

Index file layout (data/puzzles/index.npz):
  - vectors: (N, 16) float32  — UMAP-projected feature vectors
  - puzzle_ids: (N,) str
  - ratings: (N,) int16
  - themes: (N,) str  — space-separated Lichess theme tags

Metadata (data/puzzles/meta.json): list of puzzle dicts with all original fields.
"""
from __future__ import annotations

import csv
import io
import json
import pickle
import time
from pathlib import Path
from typing import Optional

import chess
import numpy as np
import requests
from tqdm import tqdm

from ml.classifier.label_map import map_lichess_themes_to_ml_class, ML_CLASS_TO_THREAT
from ml.clustering.feature_extractor import extract_features, FEATURE_DIM
from ml.ingestion.mistake_extractor import MistakeEvent

PUZZLE_CSV_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"
PUZZLE_DIR = Path(__file__).parent.parent.parent / "data" / "puzzles"


def _threat_from_themes(themes_str: str) -> str:
    ml_class = map_lichess_themes_to_ml_class(themes_str.split())
    if ml_class is None:
        return "other"
    return ML_CLASS_TO_THREAT.get(ml_class, "other")


def _puzzle_to_mistake(row: dict) -> Optional[MistakeEvent]:
    """Convert a Lichess puzzle row to a MistakeEvent for feature extraction."""
    try:
        fen = row["FEN"]
        moves = row["Moves"].split()
        if not moves:
            return None

        board = chess.Board(fen)
        # Apply the first move (opponent's last move that created the tactic)
        board.push_uci(moves[0])
        solution_uci = moves[1] if len(moves) > 1 else moves[0]

        threat = _threat_from_themes(row.get("Themes", ""))
        move_num = board.fullmove_number

        # Determine game phase from move number (simple heuristic)
        if move_num <= 20:
            phase = "opening"
        elif len(board.piece_map()) <= 10:
            phase = "endgame"
        else:
            phase = "middlegame"

        return MistakeEvent(
            game_id=row["PuzzleId"],
            user_id="",
            fen=board.fen(),
            move_played_uci=solution_uci,
            move_played_san="",
            best_move_uci=solution_uci,
            eval_before_cp=0,
            eval_after_cp=300,
            eval_drop_cp=300,
            threat_type=threat,
            game_phase=phase,
            time_remaining_ms=None,
            move_number=move_num,
            played_at_unix=None,
            cluster_id=None,
        )
    except Exception:
        return None


def _stream_csv_zst(url: str, max_rows: int) -> list[dict]:
    """Stream-decompress a .zst CSV from URL, returning up to max_rows dicts."""
    try:
        import zstandard as zstd
    except ImportError:
        raise ImportError(
            "zstandard not installed. Run: pip install zstandard"
        )

    rows = []
    print(f"Streaming puzzle CSV from {url} ...")
    with requests.get(url, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        dctx = zstd.ZstdDecompressor()
        stream = dctx.stream_reader(resp.raw)
        reader = io.TextIOWrapper(stream, encoding="utf-8")
        csv_reader = csv.DictReader(reader)
        for row in csv_reader:
            rows.append(row)
            if len(rows) >= max_rows:
                break
            if len(rows) % 10000 == 0:
                print(f"  {len(rows):,} puzzles read...")
    return rows


def build_puzzle_index(
    scaler_path: Path,
    reducer_path: Path,
    max_puzzles: int = 100_000,
    output_dir: Path = PUZZLE_DIR,
    min_rating: int = 800,
    max_rating: int = 2800,
) -> Path:
    """
    Download Lichess puzzles, embed them in the same UMAP space as user mistakes,
    and save a searchable numpy index.

    Returns path to the saved index file.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    index_path = output_dir / "index.npz"
    meta_path  = output_dir / "meta.json"

    if not scaler_path.exists():
        raise FileNotFoundError(
            f"Scaler not found at {scaler_path}. Run Stage 2 first."
        )
    if not reducer_path.exists():
        raise FileNotFoundError(
            f"Reducer not found at {reducer_path}. Run Stage 2 first."
        )

    with open(scaler_path, "rb") as fh:
        scaler = pickle.load(fh)
    with open(reducer_path, "rb") as fh:
        reducer = pickle.load(fh)

    print(f"Building puzzle index (up to {max_puzzles:,} puzzles)...")
    rows = _stream_csv_zst(PUZZLE_CSV_URL, max_puzzles)

    # Filter by rating
    rows = [
        r for r in rows
        if min_rating <= int(r.get("Rating", 9999)) <= max_rating
    ]
    print(f"  {len(rows):,} puzzles after rating filter [{min_rating}, {max_rating}]")

    # Convert to MistakeEvent for feature extraction
    print("  Extracting features...")
    mistakes = []
    valid_rows = []
    for r in tqdm(rows, desc="Parsing puzzles", unit="puzzle"):
        m = _puzzle_to_mistake(r)
        if m is not None:
            mistakes.append(m)
            valid_rows.append(r)

    print(f"  {len(mistakes):,} puzzles parsed successfully")

    # Extract 111-dim features
    X = extract_features(mistakes)
    X = np.nan_to_num(X, nan=0.0)

    # Scale + reduce to same 16-dim UMAP space
    X_scaled  = scaler.transform(X)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        X_reduced = reducer.transform(X_scaled)

    print(f"  Embedded: {X.shape} -> {X_reduced.shape}")

    # Build metadata list
    meta = []
    for i, r in enumerate(valid_rows):
        meta.append({
            "puzzle_id": r["PuzzleId"],
            "fen":       r["FEN"],
            "moves":     r["Moves"],
            "rating":    int(r.get("Rating", 1500)),
            "themes":    r.get("Themes", ""),
            "threat":    _threat_from_themes(r.get("Themes", "")),
            "game_url":  r.get("GameUrl", ""),
        })

    # Save index
    np.savez_compressed(
        index_path,
        vectors=X_reduced.astype(np.float32),
        ratings=np.array([m["rating"] for m in meta], dtype=np.int16),
    )

    # Save themes as a plain text list (one line per puzzle, space-separated tags)
    themes_path = output_dir / "themes.txt"
    with open(themes_path, "w", encoding="utf-8") as fh:
        for m in meta:
            fh.write(m["themes"] + "\n")

    # Save puzzle ids
    ids_path = output_dir / "ids.txt"
    with open(ids_path, "w", encoding="utf-8") as fh:
        for m in meta:
            fh.write(m["puzzle_id"] + "\n")

    with open(meta_path, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, separators=(",", ":"))

    print(f"\nIndex saved to {index_path}")
    print(f"Metadata saved to {meta_path}")
    print(f"Total indexed: {len(meta):,} puzzles")
    return index_path
