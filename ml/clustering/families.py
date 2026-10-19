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


def family_distribution(class_probs: dict[str, float], p_none: float = 0.0) -> dict[str, float]:
    """Soft family assignment from v2 multi-label motif probabilities.

    Each family's evidence is the noisy-OR of its motifs' probabilities (a
    discovered-attack fork supports both loose_pieces and defender_disruption).
    `unclassified` gets the learned no-tactic probability, and absorbs the mass
    when no motif is convincing. Normalised to sum to 1.
    """
    from ml.classifier.label_map_v2 import CLASS_TO_THREAT
    keep_out: dict[str, float] = {}
    for cls, p in class_probs.items():
        threat = CLASS_TO_THREAT.get(cls)
        if not threat or threat == "other":
            continue
        fam = family_of(threat)
        keep_out[fam] = 1.0 - (1.0 - keep_out.get(fam, 0.0)) * (1.0 - float(p))
    best = max(keep_out.values(), default=0.0)
    unc = max(float(p_none), 0.0)
    if best < 0.2:
        unc = max(unc, 0.5)
    scores = {**keep_out, UNCLASSIFIED: unc}
    total = sum(scores.values())
    if total <= 0:
        return {UNCLASSIFIED: 1.0}
    return {f: round(v / total, 4) for f, v in sorted(scores.items(), key=lambda kv: -kv[1]) if v / total >= 0.01}


def family_lichess_themes() -> dict[str, list[str]]:
    """Family -> the Lichess puzzle theme tags to fetch for it (Stage 3).

    Derived by composing the canonical v2 maps (real Lichess theme names):
        threat_type  <- label_map_v2.CLASS_TO_THREAT <- v2 motif class
        motif class  <- label_map_v2.THEME_TO_CLASS  <- Lichess theme
    so a blindspot family resolves to the exact set of Lichess themes whose
    puzzles train that skill. Endgame-type tags feed the positional family's
    technique drills. The `unclassified` family has no tactical theme (its
    mistakes are positional) and is intentionally absent.
    """
    from collections import defaultdict
    from ml.classifier.label_map_v2 import THEME_TO_CLASS, CLASS_TO_THREAT, _ENDGAME_TAGS

    threat_to_mlclasses: dict[str, set] = defaultdict(set)
    for mlc, threat in CLASS_TO_THREAT.items():
        if threat:
            threat_to_mlclasses[threat].add(mlc)
    mlclass_to_themes: dict[str, set] = defaultdict(set)
    for theme, mlc in THEME_TO_CLASS.items():
        mlclass_to_themes[mlc].add(theme)
    mlclass_to_themes["endgame"] |= set(_ENDGAME_TAGS)

    out: dict[str, list[str]] = {}
    for fam, d in FAMILIES.items():
        themes: set[str] = set()
        for threat in d["threats"]:
            for mlc in threat_to_mlclasses.get(threat, ()):
                themes |= mlclass_to_themes.get(mlc, set())
        out[fam] = sorted(themes)
    return out
