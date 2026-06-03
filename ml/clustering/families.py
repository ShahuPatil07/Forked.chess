"""
Stage-2 (profile approach): the fixed 14 -> 5 blindspot-family taxonomy.

This is a deterministic expert map, not a learned clustering. Mistakes are
"similar" when they fail the SAME underlying skill, which is what a coach groups
on — so the 14 THREAT_TYPES collapse into 5 trainable families (+ an
unclassified bucket for `other`, which is disproportionately positional).

See the discussion in the handoff: clustering on board geometry produced clusters
independent of motif (ARI ~ 0); grouping by shared skill is both coherent and
what makes a user trainable on 5 blindspots instead of 14 types.
"""
from __future__ import annotations

FAMILIES: dict[str, dict] = {
    "loose_pieces": {
        "name":  "Loose-piece awareness",
        "skill": "Keeping your pieces defended and off forkable squares",
        "threats": ["hanging_piece", "trapped_piece", "fork"],
    },
    "alignment": {
        "name":  "Pins & skewers (piece alignment)",
        "skill": "Not lining your pieces up on an enemy line-piece's ray",
        "threats": ["pin", "skewer"],
    },
    "defender_disruption": {
        "name":  "Defender disruption",
        "skill": "Tracking which piece defends what; overloaded / critical defenders",
        "threats": ["discovered_attack", "removing_defender", "deflection"],
    },
    "king_safety": {
        "name":  "King safety & mating nets",
        "skill": "Sensing king exposure, back-rank weakness, attacking patterns",
        "threats": ["back_rank", "king_attack"],
    },
    "positional": {
        "name":  "Positional & technique",
        "skill": "Slow strategic and endgame judgement",
        "threats": ["piece_activity", "passed_pawn", "endgame_technique"],
    },
}

# Bucket for threats with no clean tactical family (mostly positional / unclear).
UNCLASSIFIED = "unclassified"
UNCLASSIFIED_INFO = {
    "name":  "Unclassified / positional",
    "skill": "Mistakes with no clean tactical motif - often positional (needs deeper analysis)",
    "threats": ["other"],
}

THREAT_TO_FAMILY: dict[str, str] = {
    t: fam for fam, d in FAMILIES.items() for t in d["threats"]
}

FAMILY_ORDER = list(FAMILIES.keys()) + [UNCLASSIFIED]


def family_of(threat_type: str) -> str:
    """Map a THREAT_TYPE to its blindspot family key."""
    return THREAT_TO_FAMILY.get(threat_type, UNCLASSIFIED)


def family_info(family_key: str) -> dict:
    return FAMILIES.get(family_key, UNCLASSIFIED_INFO)


def family_lichess_themes() -> dict[str, list[str]]:
    """Family -> the Lichess puzzle theme tags to fetch for it (Stage 3).

    Derived by composing the canonical maps:
        threat_type  <- ML_CLASS_TO_THREAT  <- ML class
        ML class      <- LICHESS_TO_ML_CLASS <- Lichess theme
    so a blindspot family resolves to the exact set of Lichess themes whose
    puzzles train that skill. The `unclassified` family has no tactical theme
    (its mistakes are positional) and is intentionally absent.
    """
    from collections import defaultdict
    from ml.classifier.label_map import LICHESS_TO_ML_CLASS, ML_CLASS_TO_THREAT

    threat_to_mlclasses: dict[str, set] = defaultdict(set)
    for mlc, threat in ML_CLASS_TO_THREAT.items():
        threat_to_mlclasses[threat].add(mlc)
    mlclass_to_themes: dict[str, set] = defaultdict(set)
    for theme, mlc in LICHESS_TO_ML_CLASS.items():
        mlclass_to_themes[mlc].add(theme)

    out: dict[str, list[str]] = {}
    for fam, d in FAMILIES.items():
        themes: set[str] = set()
        for threat in d["threats"]:
            for mlc in threat_to_mlclasses.get(threat, ()):
                themes |= mlclass_to_themes.get(mlc, set())
        out[fam] = sorted(themes)
    return out
