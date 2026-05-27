"""
Puzzle retriever — given a BlindspotCluster centroid, returns the N nearest
puzzles from the indexed Lichess puzzle pool, filtered by threat type and
difficulty (rating band).

The index was built by importer.py and lives in data/puzzles/.
Searching is pure numpy L2 distance — fast enough for 100K puzzles in <100ms.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

PUZZLE_DIR = Path(__file__).parent.parent.parent / "data" / "puzzles"


@dataclass
class PuzzleResult:
    puzzle_id:  str
    fen:        str
    moves:      str           # space-separated UCI moves; first=opponent trigger, rest=solution
    rating:     int
    themes:     str
    threat:     str
    game_url:   str
    distance:   float         # L2 distance to cluster centroid in UMAP space


class PuzzleIndex:
    """Lazy-loaded in-memory index. Load once, query many times."""

    def __init__(self, puzzle_dir: Path = PUZZLE_DIR):
        self._dir    = puzzle_dir
        self._loaded = False

    def _load(self) -> None:
        if self._loaded:
            return

        index_path = self._dir / "index.npz"
        meta_path  = self._dir / "meta.json"
        ids_path   = self._dir / "ids.txt"
        themes_path = self._dir / "themes.txt"

        if not index_path.exists():
            raise FileNotFoundError(
                f"Puzzle index not found at {index_path}.\n"
                "Run: python scripts/run_puzzle_import.py"
            )

        data = np.load(index_path)
        self._vectors = data["vectors"].astype(np.float32)   # (N, 16)
        self._ratings = data["ratings"].astype(np.int32)     # (N,)

        with open(meta_path, encoding="utf-8") as fh:
            self._meta = json.load(fh)

        self._ids    = [m["puzzle_id"] for m in self._meta]
        self._themes = [m["themes"]    for m in self._meta]
        self._threats = [m["threat"]   for m in self._meta]
        self._loaded = True

    @property
    def size(self) -> int:
        self._load()
        return len(self._meta)

    def query(
        self,
        centroid:    list[float] | np.ndarray,
        threat_type: Optional[str] = None,
        min_rating:  int = 800,
        max_rating:  int = 2800,
        seen_ids:    Optional[set[str]] = None,
        top_k:       int = 20,
    ) -> list[PuzzleResult]:
        """
        Return top_k puzzles nearest to `centroid` in UMAP space,
        optionally filtered by threat type and rating band.

        seen_ids: puzzle ids already shown to this user (skip them).
        """
        self._load()

        q = np.array(centroid, dtype=np.float32)

        # Rating filter mask
        mask = (self._ratings >= min_rating) & (self._ratings <= max_rating)

        # Threat filter (if specified and not "other" — "other" matches everything)
        if threat_type and threat_type != "other":
            threat_mask = np.array(
                [t == threat_type for t in self._threats], dtype=bool
            )
            mask = mask & threat_mask

        # Seen filter
        if seen_ids:
            seen_mask = np.array(
                [pid not in seen_ids for pid in self._ids], dtype=bool
            )
            mask = mask & seen_mask

        indices = np.where(mask)[0]
        if len(indices) == 0:
            # Fall back: drop threat filter but keep rating + seen filters
            rating_mask = (self._ratings >= min_rating) & (self._ratings <= max_rating)
            if seen_ids:
                seen_mask = np.array(
                    [pid not in seen_ids for pid in self._ids], dtype=bool
                )
                indices = np.where(rating_mask & seen_mask)[0]
            else:
                indices = np.where(rating_mask)[0]

        if len(indices) == 0:
            return []

        vecs = self._vectors[indices]
        dists = np.linalg.norm(vecs - q, axis=1)

        # Top-k by distance
        top_local = np.argsort(dists)[:top_k]
        results = []
        for li in top_local:
            gi = int(indices[li])
            m  = self._meta[gi]
            results.append(PuzzleResult(
                puzzle_id=m["puzzle_id"],
                fen=m["fen"],
                moves=m["moves"],
                rating=m["rating"],
                themes=m["themes"],
                threat=m["threat"],
                game_url=m["game_url"],
                distance=float(dists[li]),
            ))
        return results


# Module-level singleton — shared across all callers in the same process
_INDEX: Optional[PuzzleIndex] = None


def get_index(puzzle_dir: Path = PUZZLE_DIR) -> PuzzleIndex:
    global _INDEX
    if _INDEX is None:
        _INDEX = PuzzleIndex(puzzle_dir)
    return _INDEX
