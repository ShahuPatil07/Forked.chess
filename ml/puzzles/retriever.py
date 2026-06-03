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
        # Pre-split theme strings into sets once for fast Stage-3 family queries.
        self._theme_sets = [set(t.split()) for t in self._themes]
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


    def query_by_themes(
        self,
        themes:     list[str],
        min_rating: int = 800,
        max_rating: int = 2800,
        seen_ids:   Optional[set[str]] = None,
        top_k:      int = 20,
        rng_seed:   Optional[int] = None,
    ) -> list[PuzzleResult]:
        """
        Stage-3 (family) retrieval: return up to `top_k` puzzles whose Lichess
        `Themes` intersect `themes` and whose rating is in band, sampled
        randomly (so repeated calls vary). Used by the blindspot-family drill
        builder — there is no centroid any more.
        """
        self._load()
        want = set(themes)
        if not want:
            return []

        seen = seen_ids or set()
        candidates = [
            i for i in range(len(self._meta))
            if (self._ratings[i] >= min_rating and self._ratings[i] <= max_rating)
            and (self._theme_sets[i] & want)
            and (self._ids[i] not in seen)
        ]
        if not candidates:
            # Relax the rating band before giving up (rare families can be sparse).
            candidates = [
                i for i in range(len(self._meta))
                if (self._theme_sets[i] & want) and (self._ids[i] not in seen)
            ]
        if not candidates:
            return []

        import random as _random
        rng = _random.Random(rng_seed)
        rng.shuffle(candidates)
        chosen = candidates[:top_k]

        results = []
        for gi in chosen:
            m = self._meta[gi]
            results.append(PuzzleResult(
                puzzle_id=m["puzzle_id"], fen=m["fen"], moves=m["moves"],
                rating=m["rating"], themes=m["themes"], threat=m["threat"],
                game_url=m["game_url"], distance=0.0,
            ))
        return results


# Module-level singleton — shared across all callers in the same process
_INDEX: Optional[PuzzleIndex] = None


def get_index(puzzle_dir: Path = PUZZLE_DIR) -> PuzzleIndex:
    global _INDEX
    if _INDEX is None:
        _INDEX = PuzzleIndex(puzzle_dir)
    return _INDEX
