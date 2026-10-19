"""
Stage-1 v2 label space: MULTI-LABEL motif classes built from the real Lichess
puzzle-theme vocabulary.

Why v2 (audited against all 5.94M puzzles in lichess_db_puzzle.csv.zst):
  - v1 keyed several classes on theme names that do not exist in the Lichess DB
    (`overloadedPiece`, `zwischenzug`, `removeDefender`, `backRank`, `check`,
    `passingPawn`), so 2 of its 16 output units never saw a training example and
    `promotion` always lost the priority tie-break to `advancedPawn`.
  - High-volume real themes were dropped entirely: `exposedKing` (179K),
    `defensiveMove` (361K), `discoveredCheck` (109K), `intermezzo` (72K),
    `doubleCheck`, and ~15 named mates.
  - `endgame` is a PHASE tag on half the DB; v1 trained it as a motif, so a fork
    played in an endgame was labelled "endgame technique". v2 only emits the
    `endgame` class when no tactical motif is present.
  - Puzzles carry several themes (fork + discoveredCheck + mateIn2 ...). v1 kept
    one by priority; v2 trains every motif (sigmoid / BCE) and lets Stage 2 use
    the per-family probability mass.

Class order: indexes 0..15 line up with the v1 head rows whose meaning carried
over, so fine-tuning can initialise from the v1 checkpoint (see V1_INIT_ROW).
"""
from __future__ import annotations

MOTIF_CLASSES: tuple[str, ...] = (
    "fork",              # 0
    "pin",               # 1
    "skewer",            # 2
    "discoveredAttack",  # 3
    "deflection",        # 4
    "intermezzo",        # 5  modifier (no family of its own)
    "hangingPiece",      # 6
    "trappedPiece",      # 7
    "backRankMate",      # 8
    "capturingDefender", # 9
    "advancedPawn",      # 10
    "quietMove",         # 11
    "endgame",           # 12 only when no tactical motif is present
    "mate",              # 13
    "kingAttack",        # 14
    "defensiveMove",     # 15 modifier (solution is an only-move defence)
    "none",              # 16 no tactic (real-game quiet positions, Stockfish-mined)
)
N_CLASSES = len(MOTIF_CLASSES)
CLASS_INDEX = {c: i for i, c in enumerate(MOTIF_CLASSES)}
NONE_INDEX = CLASS_INDEX["none"]

# v1 head row to initialise each v2 output from (None = fresh init).
V1_INIT_ROW: dict[int, int | None] = {
    0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: None, 6: 7, 7: 8, 8: 9, 9: 10,
    10: 11, 11: 13, 12: 14, 13: 15, 14: 15, 15: None, 16: None,
}

_MATE_THEMES = {
    "mate", "mateIn1", "mateIn2", "mateIn3", "mateIn4", "mateIn5",
    "anastasiaMate", "arabianMate", "bodenMate", "doubleBishopMate",
    "dovetailMate", "hookMate", "smotheredMate", "vukovicMate", "pillsburysMate",
    "operaMate", "epauletteMate", "cornerMate", "swallowstailMate",
    "triangleMate", "morphysMate", "blindSwineMate", "killBoxMate",
    "balestraMate",
}

THEME_TO_CLASS: dict[str, str] = {
    "fork": "fork",
    "pin": "pin",
    "skewer": "skewer", "xRayAttack": "skewer",
    "discoveredAttack": "discoveredAttack", "discoveredCheck": "discoveredAttack",
    "doubleCheck": "discoveredAttack",
    "deflection": "deflection", "attraction": "deflection", "interference": "deflection",
    "intermezzo": "intermezzo",
    "hangingPiece": "hangingPiece",
    "trappedPiece": "trappedPiece",
    "backRankMate": "backRankMate",
    "capturingDefender": "capturingDefender",
    "advancedPawn": "advancedPawn", "promotion": "advancedPawn", "underPromotion": "advancedPawn",
    "quietMove": "quietMove", "clearance": "quietMove",
    "zugzwang": "endgame",
    "kingsideAttack": "kingAttack", "queensideAttack": "kingAttack",
    "attackingF2F7": "kingAttack", "exposedKing": "kingAttack",
    "defensiveMove": "defensiveMove",
    **{t: "mate" for t in _MATE_THEMES},
}

_ENDGAME_TAGS = {
    "endgame", "rookEndgame", "pawnEndgame", "bishopEndgame", "knightEndgame",
    "queenEndgame", "queenRookEndgame",
}
MODIFIERS = {"intermezzo", "defensiveMove"}

# Rarest-first order (global DB counts) — a puzzle is bucketed by its rarest
# label when sampling a class-balanced training set.
RARITY_ORDER: tuple[str, ...] = (
    "capturingDefender", "trappedPiece", "intermezzo", "skewer", "backRankMate",
    "hangingPiece", "quietMove", "pin", "defensiveMove", "discoveredAttack",
    "deflection", "advancedPawn", "fork", "kingAttack", "endgame", "mate",
)

# v2 class -> the product's 14 THREAT_TYPES (Stage-2 family_of() keys off these).
# Modifiers map to None: they describe HOW a tactic works, not which skill failed,
# so they never pull a mistake into a family on their own.
CLASS_TO_THREAT: dict[str, str | None] = {
    "fork": "fork", "pin": "pin", "skewer": "skewer",
    "discoveredAttack": "discovered_attack", "deflection": "deflection",
    "intermezzo": None, "hangingPiece": "hanging_piece",
    "trappedPiece": "trapped_piece", "backRankMate": "back_rank",
    "capturingDefender": "removing_defender", "advancedPawn": "passed_pawn",
    "quietMove": "piece_activity", "endgame": "endgame_technique",
    "mate": "king_attack", "kingAttack": "king_attack",
    "defensiveMove": None, "none": "other",
}


def themes_to_classes(themes: list[str] | str) -> list[str]:
    """Lichess theme tags -> sorted list of v2 motif classes ([] = unusable)."""
    if isinstance(themes, str):
        themes = themes.split()
    out = {THEME_TO_CLASS[t] for t in themes if t in THEME_TO_CLASS}
    core = out - MODIFIERS
    if not core and any(t in _ENDGAME_TAGS for t in themes):
        out.add("endgame")
    return sorted(out, key=CLASS_INDEX.__getitem__)


def rarest(classes: list[str]) -> str | None:
    for c in RARITY_ORDER:
        if c in classes:
            return c
    return classes[0] if classes else None


def threats_of(classes) -> set[str]:
    """Set of THREAT_TYPES implied by a set of v2 classes (modifiers dropped)."""
    return {CLASS_TO_THREAT[c] for c in classes if CLASS_TO_THREAT.get(c)}
