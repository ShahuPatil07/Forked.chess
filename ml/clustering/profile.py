"""
Stage-2 profile builder: turn a user's classified mistakes into a ranked
blindspot profile over the 5 families.

For each family we report the components a coach actually reasons about, then a
combined score:
  - frequency : share of the user's mistakes in this family
  - recency   : mean exp-decay weight on when the mistakes happened (14-day
                half-life) — a fading blindspot matters less than a current one
  - severity  : mean eval-drop (centipawns) — how costly the mistakes are
  - score     : frequency * recency * severity_factor  (ranking key)

Each family is also emitted as a `BlindspotCluster` (the product's Stage-2 output
contract), so this drops in where the UMAP+HDBSCAN clusterer used to sit — but
deterministically and self-labelled, no LLM, no learned clustering.
"""
from __future__ import annotations

import math
import time
from collections import Counter, defaultdict

import numpy as np

from ml.ingestion.mistake_extractor import MistakeEvent
from ml.clustering.blindspot import BlindspotCluster, _event_summary
from ml.clustering.families import (
    FAMILIES, FAMILY_ORDER, UNCLASSIFIED, family_of, family_info,
)

_RECENCY_LAMBDA = 0.05          # per day; half-life ~14 days (matches blindspot.py)
_SEVERITY_CAP   = 1000.0        # cp; beyond "completely losing" all drops count equally
                                # (stops mate-score blunders, eval_drop~30000, from
                                #  dominating severity and over-ranking rare families)
_SEVERITY_SCALE = 500.0         # cp; 500cp avg capped drop -> severity_factor 1.0


def _recency_weight(unix_ts) -> float:
    if not unix_ts:
        return 0.5
    days = (time.time() - unix_ts) / 86_400
    return math.exp(-_RECENCY_LAMBDA * max(0.0, days))


def _family_indicator(family_key: str) -> list[float]:
    """A stable per-family one-hot centroid in the 6-family space."""
    vec = [0.0] * len(FAMILY_ORDER)
    vec[FAMILY_ORDER.index(family_key)] = 1.0
    return vec


def build_profile(mistakes: list[MistakeEvent], user_id: str) -> dict:
    """Return a dict with `families` (ranked profile rows) and `clusters`
    (BlindspotCluster per non-empty family)."""
    n_total = len(mistakes)
    by_family: dict[str, list[MistakeEvent]] = defaultdict(list)
    for m in mistakes:
        by_family[family_of(m.threat_type)].append(m)

    rows = []
    clusters: list[BlindspotCluster] = []
    for fam in FAMILY_ORDER:
        evs = by_family.get(fam, [])
        if not evs:
            continue
        info = family_info(fam)
        n = len(evs)
        freq = n / max(n_total, 1)
        recency = float(np.mean([_recency_weight(e.played_at_unix) for e in evs]))
        drops = [min(_SEVERITY_CAP, max(0, e.eval_drop_cp)) for e in evs]
        sev_cp = float(np.mean(drops))
        sev_factor = sev_cp / _SEVERITY_SCALE
        score = freq * recency * sev_factor

        threat_breakdown = Counter(e.threat_type for e in evs)
        phase_breakdown = Counter(e.game_phase for e in evs)
        # time-pressure share (low clock < 30s) where clock data exists
        clocks = [e.time_remaining_ms for e in evs if e.time_remaining_ms is not None]
        tp_share = (sum(1 for c in clocks if c < 30_000) / len(clocks)) if clocks else None

        rows.append({
            "family": fam,
            "name": info["name"],
            "skill": info["skill"],
            "count": n,
            "frequency": round(freq, 4),
            "recency": round(recency, 3),
            "severity_cp": round(sev_cp, 1),
            "score": round(score, 4),
            "threats": dict(threat_breakdown.most_common()),
            "phases": dict(phase_breakdown.most_common()),
            "time_pressure_share": round(tp_share, 3) if tp_share is not None else None,
        })

        if fam != UNCLASSIFIED:
            dom_threat = threat_breakdown.most_common(1)[0][0]
            dom_phase = phase_breakdown.most_common(1)[0][0]
            last_ts = max((e.played_at_unix for e in evs if e.played_at_unix), default=None)
            worst = sorted(evs, key=lambda e: -e.eval_drop_cp)[:5]
            # cluster_id IS the family key (a string), so it matches the
            # mistake.cluster_id = family_of(threat_type) set in profile_pipeline.
            # The whole intelligence layer (replay / counterfactual / sessions)
            # groups mistakes to clusters by this shared key.
            clusters.append(BlindspotCluster(
                cluster_id=fam, user_id=user_id, label=info["name"], size=n,
                centroid=_family_indicator(fam),
                dominant_threat_type=dom_threat, dominant_game_phase=dom_phase,
                mastery=0.0, last_occurrence_unix=last_ts, next_review_unix=None,
                score=round(score, 4),
                representative_events=[_event_summary(e) for e in worst],
            ))

    rows.sort(key=lambda r: r["score"], reverse=True)
    clusters.sort(key=lambda c: c.score, reverse=True)
    return {"user_id": user_id, "n_mistakes": n_total, "families": rows, "clusters": clusters}
