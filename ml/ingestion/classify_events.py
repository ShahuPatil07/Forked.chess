"""
Batch motif classification of Stage-1 events, in the RIGHT framing.

    allowed  -> (fen_after, opponent's refutation)  == how Lichess puzzles are built
    missed   -> (fen_before, engine best move)
    both     -> both; family mass mixed by each side's material swing
    quiet    -> (fen_before, best move); the v2 model's learned "none" decides
                whether any motif is present at all

Opportunities (tactics available to the mover) are classified as (fen, best).

The deterministic verifier (ml/classifier/verifier.py) adds board-proven motifs
as extra evidence (noisy-OR, weighted by its measured precision). Each event gets
`family_probs` (soft assignment Stage 2 aggregates), a primary `threat_type`
consistent with its top family (so cluster_id == family_of(threat_type) holds),
the per-framing labels, and the verified motifs.

Works with the v2 multi-label predictor and, for ablations, the v1 softmax one.
"""
from __future__ import annotations

import chess

from ml.classifier import label_map_v2 as v2
from ml.classifier.verifier import verify, VERIFIER_PRECISION
from ml.clustering.families import family_distribution, family_of, UNCLASSIFIED

_MATE_WEIGHT_CP = 1000


def _predictor(classifier):
    return getattr(classifier, "_predictor", classifier)


def _framing_result(out: dict, j: int, verified: set, multilabel: bool, use_verifier: bool) -> dict:
    if multilabel:
        probs = {c: float(out["probs"][j][i]) for i, c in enumerate(v2.MOTIF_CLASSES) if c != "none"}
        p_none = float(out["p_none"][j])
        if use_verifier:
            for c in verified:
                prec = VERIFIER_PRECISION.get(c, 0.5)
                probs[c] = 1.0 - (1.0 - probs.get(c, 0.0)) * (1.0 - prec)
                p_none *= (1.0 - prec)
        fam = family_distribution(probs, p_none)
    else:
        threat = "other" if bool(out["is_positional"][j]) else out["threat_type"][j]
        if use_verifier and threat == "other" and verified:
            best = max(verified, key=lambda c: VERIFIER_PRECISION.get(c, 0.0))
            threat = v2.CLASS_TO_THREAT.get(best) or "other"
        probs, p_none = {}, (1.0 if threat == "other" else 0.0)
        fam = {family_of(threat): 1.0}
    return {"probs": probs, "p_none": p_none, "family": fam, "verified": sorted(verified),
            "conf": float(out["confidence"][j]), "raw_threat": out["threat_type"][j]}


def _top_threat(res: dict, family: str) -> str:
    if family == UNCLASSIFIED:
        return "other"
    if res["probs"]:
        cands = [(p, c) for c, p in res["probs"].items()
                 if v2.CLASS_TO_THREAT.get(c) and family_of(v2.CLASS_TO_THREAT[c]) == family]
        if cands:
            return v2.CLASS_TO_THREAT[max(cands)[1]]
    raw = res.get("raw_threat") or "other"
    return raw if family_of(raw) == family else "other"


def _mix(a: dict, b: dict, wa: float) -> dict:
    out = {k: wa * a.get(k, 0.0) + (1 - wa) * b.get(k, 0.0) for k in set(a) | set(b)}
    return {k: round(v, 4) for k, v in sorted(out.items(), key=lambda kv: -kv[1]) if v >= 0.01}


_TB_URL = "https://tablebase.lichess.ovh/standard"
_TB_RANK = {"win": 2, "maybe-win": 2, "cursed-win": 1, "draw": 0, "blessed-loss": -1,
            "maybe-loss": -2, "loss": -2}
_tb_cache: dict[str, int | None] = {}


def _tb_rank(fen: str) -> int | None:
    """Syzygy WDL rank for the side to move (≤7 pieces), cached; None on failure."""
    if fen in _tb_cache:
        return _tb_cache[fen]
    rank = None
    try:
        import requests
        from ml.config import REQUEST_HEADERS
        r = requests.get(_TB_URL, params={"fen": fen}, headers=REQUEST_HEADERS, timeout=4)
        if r.ok:
            rank = _TB_RANK.get(r.json().get("category"))
    except Exception:
        rank = None
    _tb_cache[fen] = rank
    return rank


def _tablebase_error(m) -> bool:
    """A ≤7-piece position whose tablebase result got worse with the move."""
    try:
        if len(chess.Board(m.fen).piece_map()) > 7:
            return False
        before, after = _tb_rank(m.fen), _tb_rank(m.fen_after)
        return before is not None and after is not None and -after < before
    except Exception:
        return False


def _reason(m) -> str:
    if m.time_trouble:
        return "time_trouble"
    if m.game_phase == "opening":
        return "opening"
    if m.fen_after and _tablebase_error(m):
        return "endgame_technique_tablebase"
    if m.game_phase == "endgame":
        return "endgame_technique"
    return "positional"


ATTACH_FAMILY_P = 0.2      # a family with at least this much mass is attached to the mistake


def _line_facts(fen: str, line: list[str], plies: int = 6) -> dict:
    """What the punishing / winning line does: checks given, captures, mate."""
    out = {"checks": 0, "captures": 0, "mate": False, "promotes": False}
    try:
        b = chess.Board(fen)
    except Exception:
        return out
    for i, uci in enumerate(line[:plies]):
        try:
            mv = chess.Move.from_uci(uci)
        except ValueError:
            break
        if mv not in b.legal_moves:
            break
        if i % 2 == 0:
            out["checks"] += b.gives_check(mv)
            out["captures"] += b.is_capture(mv)
            out["promotes"] |= bool(mv.promotion)
        b.push(mv)
        if b.is_checkmate():
            out["mate"] = True
            break
    return out


def describe(m, ra: dict | None, rm: dict | None) -> dict:
    """Structured, multi-type description of one mistake.

    A real mistake is often several things at once (a fork that only works
    because of a pin, or because the king is exposed), so besides the primary
    family it lists every family with evidence, the motifs, and plain tags.
    King safety is attached as a secondary family whenever the punishing line
    attacks the king, while the primary family keeps the Lichess convention
    (drills are pulled by Lichess themes)."""
    allowed = m.direction in ("allowed", "both")
    fen, line = (m.fen_after, m.reply_line) if allowed else (m.fen, m.best_line)
    facts = _line_facts(fen, line)

    fams: dict[str, str] = {}
    for f, p in sorted((m.family_probs or {}).items(), key=lambda kv: -kv[1]):
        if p >= ATTACH_FAMILY_P and f != UNCLASSIFIED:
            fams[f] = "model"
    motifs = []
    for res, framing in ((ra, "allowed"), (rm, "missed")):
        if not res:
            continue
        for c, p in sorted(res["probs"].items(), key=lambda kv: -kv[1]):
            verified = c in res["verified"]
            if p >= 0.3 or verified:
                motifs.append({"motif": c, "p": round(p, 3), "verified": verified, "side": framing})
            threat = v2.CLASS_TO_THREAT.get(c)
            if verified and threat and threat != "other":
                fams.setdefault(family_of(threat), "verified")
    involves_king = facts["checks"] > 0 or facts["mate"] or bool(m.mate_allowed or m.mate_missed)
    if involves_king:
        fams.setdefault("king_safety", "king_attacked")

    tags = []
    if involves_king:
        tags.append("involves_king")
    if facts["checks"]:
        tags.append("check")
    if facts["mate"] or m.mate_allowed or m.mate_missed:
        tags.append("mate_threat")
    if facts["promotes"]:
        tags.append("promotion")
    if max(m.swing_allowed_cp if allowed else m.swing_missed_cp, 0) >= 200:
        tags.append("wins_material")
    elif m.direction != "quiet" and facts["captures"] == 0:
        tags.append("quiet_tactic")
    if m.allowed_kind == "ignored_threat":
        tags.append("ignored_threat")
    if m.time_trouble:
        tags.append("time_trouble")
    tags += [m.game_phase, m.eval_bucket, m.judgement or "mistake"]

    primary = m.cluster_id
    return {
        "primary_family": primary,
        "families": [{"family": f, "evidence": e} for f, e in fams.items()] or [{"family": primary, "evidence": "default"}],
        "motifs": motifs[:6],
        "direction": m.direction,
        "allowed_kind": m.allowed_kind,
        "tags": tags,
    }


def classify_events(mistakes: list, opportunities: list, classifier,
                    use_verifier: bool = True, batch: int = 512) -> None:
    pred = _predictor(classifier)
    multilabel = bool(getattr(pred, "multilabel", False))
    version = getattr(pred, "version", "v1")

    # (fen, move, line, target, framing, last move into fen, position before it)
    jobs = []
    for m in mistakes:
        if m.direction in ("allowed", "both") and m.refutation_uci:
            jobs.append((m.fen_after, m.refutation_uci, m.reply_line, m, "allowed", m.move_played_uci, m.fen))
        if m.direction in ("missed", "both", "quiet") and m.best_move_uci:
            jobs.append((m.fen, m.best_move_uci, m.best_line, m, "missed" if m.direction != "quiet" else "quiet",
                         getattr(m, "prev_move_uci", ""), getattr(m, "prev_fen", "")))
    for o in opportunities:
        jobs.append((o.fen, o.best_move_uci, o.best_line, o, "opportunity",
                     getattr(o, "prev_move_uci", ""), getattr(o, "prev_fen", "")))

    results: dict[int, dict] = {}
    for s in range(0, len(jobs), batch):
        chunk = jobs[s:s + batch]
        out = pred.predict_many([j[0] for j in chunk], [j[1] for j in chunk])
        keep = out["keep"]
        r = 0
        for k, (fen, _mv, line, target, framing, last_mv, prev_fen) in enumerate(chunk):
            if not keep[k]:
                continue
            verified = set()
            if use_verifier:
                try:
                    verified = verify(chess.Board(fen), line, last_move=last_mv or None,
                                      prev_board=chess.Board(prev_fen) if prev_fen else None)
                except Exception:
                    verified = set()
            results.setdefault(id(target), {})[framing] = _framing_result(out, r, verified, multilabel, use_verifier)
            r += 1

    for m in mistakes:
        res = results.get(id(m), {})
        ra, rm = res.get("allowed"), res.get("missed") or res.get("quiet")
        if m.direction == "both" and ra and rm:
            sa = _MATE_WEIGHT_CP if m.mate_allowed else max(0, m.swing_allowed_cp)
            sm = _MATE_WEIGHT_CP if m.mate_missed else max(0, m.swing_missed_cp)
            wa = sa / max(1, sa + sm)
            fam = _mix(ra["family"], rm["family"], wa)
            primary, framing = (ra, "allowed") if wa >= 0.5 else (rm, "missed")
        elif ra:
            fam, primary, framing = ra["family"], ra, "allowed"
        elif rm:
            fam, primary, framing = rm["family"], rm, ("quiet" if m.direction == "quiet" else "missed")
        else:
            fam, primary, framing = {UNCLASSIFIED: 1.0}, None, None

        top = max(fam, key=fam.get)
        m.family_probs = fam
        m.framing = framing
        m.cluster_id = top
        m.threat_type = _top_threat(primary, top) if primary else "other"
        if family_of(m.threat_type) != top:          # keep cluster_id == family_of(threat_type)
            m.threat_type, m.cluster_id = "other", UNCLASSIFIED
        m.classification_confidence = round(fam.get(m.cluster_id, 0.0), 4)
        m.classification_method = f"transformer_{version}:{framing}" if framing else "none"
        m.threat_allowed = _top_threat(ra, max(ra["family"], key=ra["family"].get)) if ra else None
        m.threat_missed = _top_threat(rm, max(rm["family"], key=rm["family"].get)) if rm else None
        if primary:
            m.motif_probs = {c: round(p, 3) for c, p in sorted(primary["probs"].items(), key=lambda kv: -kv[1])
                             if p >= 0.05}
            m.verified_motifs = primary["verified"]
        m.unclassified_reason = _reason(m) if m.cluster_id == UNCLASSIFIED else None
        m.description = describe(m, ra, rm)
        if m.judgement == "inaccuracy":
            # 5-10% losses count on the positional side only; what the model
            # saw stays in the description.
            m.cluster_id = "positional"
            m.threat_type = "endgame_technique" if m.game_phase == "endgame" else "piece_activity"
            m.family_probs = {"positional": 1.0}
            m.unclassified_reason = None
            m.description["primary_family"] = "positional"

    for o in opportunities:
        res = results.get(id(o), {}).get("opportunity")
        if not res:
            o.family_probs = {UNCLASSIFIED: 1.0}
            continue
        top = max(res["family"], key=res["family"].get)
        o.family_probs = res["family"]
        o.threat_type = _top_threat(res, top)
        o.confidence = round(res["family"].get(top, 0.0), 4)
