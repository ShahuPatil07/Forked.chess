"""
Lichess-native ML class taxonomy for the threat classifier.

Design:
  - The ML model is trained on 16 Lichess-native classes (ML_LICHESS_CLASSES).
    These map directly from Lichess theme tags with minimal collapsing, which
    preserves class balance and avoids zero-sample classes.
  - At INFERENCE TIME only, ML_CLASS_TO_THREAT maps the model's prediction
    back to our 18 THREAT_TYPES for the application layer.
  - Classes not reachable from Lichess puzzles (missed_threat, pawn_structure,
    other) stay as rule-based-only and are never predicted by the ML model.

Key choices:
  - All mate patterns (mateIn1-5, named mates, kingsideAttack, etc.) collapse
    into one "mate" bucket — they all become king_attack in our system anyway,
    and keeping them separate would just dilute a class we already handle well.
  - All endgame subtype tags (rookEndgame, queenEndgame, etc.) collapse into
    "endgame" — same reasoning.
  - Everything else keeps its Lichess name as the ML class label.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# ML class vocabulary (Lichess-native names, 16 classes)
# ---------------------------------------------------------------------------

ML_LICHESS_CLASSES: tuple[str, ...] = (
    "fork",
    "pin",
    "skewer",
    "discoveredAttack",
    "deflection",
    "overloadedPiece",
    "zwischenzug",
    "hangingPiece",
    "trappedPiece",
    "backRankMate",
    "removeDefender",
    "passingPawn",
    "promotion",
    "quietMove",
    "endgame",
    "mate",           # all mating-attack themes merged here
)

# ---------------------------------------------------------------------------
# Raw Lichess theme → ML class
# ---------------------------------------------------------------------------

# fmt: off
LICHESS_TO_ML_CLASS: dict[str, str] = {
    # ── Tactical (direct / near-direct) ───────────────────────────────────────
    "fork":              "fork",
    "pin":               "pin",
    "skewer":            "skewer",
    "discoveredAttack":  "discoveredAttack",
    "xRayAttack":        "discoveredAttack",
    "deflection":        "deflection",
    "interference":      "deflection",     # closest match
    "attraction":        "deflection",
    "overloadedPiece":   "overloadedPiece",
    "zwischenzug":       "zwischenzug",
    "hangingPiece":      "hangingPiece",
    "trappedPiece":      "trappedPiece",
    "backRankMate":      "backRankMate",
    "backRank":          "backRankMate",
    "removeDefender":    "removeDefender",
    "capturingDefender": "removeDefender",

    # ── Pawn-related ──────────────────────────────────────────────────────────
    "passingPawn":       "passingPawn",
    "advancedPawn":      "passingPawn",
    "promotion":         "promotion",
    "underPromotion":    "promotion",

    # ── Positional / quiet ────────────────────────────────────────────────────
    "quietMove":         "quietMove",
    "clearance":         "quietMove",
    # "sacrifice" intentionally excluded — too broad to carry a reliable label

    # ── Endgame subtypes → unified "endgame" ──────────────────────────────────
    "endgame":           "endgame",
    "rookEndgame":       "endgame",
    "queenEndgame":      "endgame",
    "pawnEndgame":       "endgame",
    "bishopEndgame":     "endgame",
    "knightEndgame":     "endgame",
    "queenVsRook":       "endgame",
    "zugzwang":          "endgame",

    # ── All mating-attack themes → unified "mate" ─────────────────────────────
    "mate":              "mate",
    "mateIn1":           "mate",
    "mateIn2":           "mate",
    "mateIn3":           "mate",
    "mateIn4":           "mate",
    "mateIn5":           "mate",
    "kingsideAttack":    "mate",
    "queensideAttack":   "mate",
    "attackingF2F7":     "mate",
    "check":             "mate",
    "anastasiaMate":     "mate",
    "arabianMate":       "mate",
    "bodenMate":         "mate",
    "doubleBishopMate":  "mate",
    "dovetailMate":      "mate",
    "hookMate":          "mate",
    "lawnMowerMate":     "mate",
    "operaHouseMate":    "mate",
    "smotheredMate":     "mate",
    "vukovicMate":       "mate",
    "queenRookMate":     "mate",
}
# fmt: on

# Tags that carry no tactical information (difficulty, style markers, etc.)
_META_THEMES = frozenset({
    "opening", "middlegame", "long", "short", "veryLong",
    "master", "masterVsMaster", "superGM",
    "oneMove", "equality",
})

# Specificity order for conflict resolution (most specific first).
# When a puzzle maps to 2+ ML classes, the highest-priority one wins.
_PRIORITY: tuple[str, ...] = (
    "zwischenzug",
    "overloadedPiece",
    "backRankMate",
    "deflection",
    "skewer",
    "removeDefender",
    "trappedPiece",
    "discoveredAttack",
    "fork",
    "pin",
    "hangingPiece",
    "passingPawn",
    "promotion",
    "quietMove",
    "endgame",
    "mate",        # least specific — lowest priority
)

# ---------------------------------------------------------------------------
# Inference-time mapping: ML class → our THREAT_TYPES name
# ---------------------------------------------------------------------------

ML_CLASS_TO_THREAT: dict[str, str] = {
    "fork":             "fork",
    "pin":              "pin",
    "skewer":           "skewer",
    "discoveredAttack": "discovered_attack",
    "deflection":       "deflection",
    "overloadedPiece":  "removing_defender",   # absorbed into removing_defender
    "zwischenzug":      "king_attack",          # absorbed into king_attack
    "hangingPiece":     "hanging_piece",
    "trappedPiece":     "trapped_piece",
    "backRankMate":     "back_rank",
    "removeDefender":   "removing_defender",
    "passingPawn":      "passed_pawn",
    "promotion":        "passed_pawn",
    "quietMove":        "piece_activity",
    "endgame":          "endgame_technique",
    "mate":             "king_attack",
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def map_lichess_themes_to_ml_class(themes: list[str]) -> str | None:
    """
    Given a puzzle's Lichess theme tags, return the ML class name to use
    for training (one of ML_LICHESS_CLASSES), or None to skip this puzzle.
    """
    mapped: set[str] = set()
    for theme in themes:
        if theme in _META_THEMES:
            continue
        ml_class = LICHESS_TO_ML_CLASS.get(theme)
        if ml_class is not None:
            mapped.add(ml_class)

    if not mapped:
        return None

    if len(mapped) == 1:
        return next(iter(mapped))

    # Conflict: pick highest-priority (most specific) class
    for cls in _PRIORITY:
        if cls in mapped:
            return cls

    return None  # unreachable
