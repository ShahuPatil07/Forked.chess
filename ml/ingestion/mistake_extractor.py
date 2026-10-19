"""
Extract mistake events (and tactical opportunities) from annotated games.

A MistakeEvent is a move where:
 - the mover lost >= 10% expected score (Lichess "mistake" in win-probability
   terms — a +900 -> +600 slip is NOT a mistake, 0 -> -150 is), and
 - the mover was not already lost (expected score >= 0.15, ~ -480cp).

Both sides are extracted: the user's mistakes are the blindspot corpus, the
opponents' mistakes (rating-matched, same time control, already analysed for
free) are the PEER BASELINE Stage 2 compares against.

Each mistake is tagged with its MECHANISM (allowed / missed / both / quiet, see
mechanism.py), which decides which position the classifier is shown. Tactical
OPPORTUNITIES (a tactic was available to the mover) are recorded as found or
missed for hit-rate tracking. Classification itself happens afterwards in one
batch (classify_events.py).
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Optional

import chess
import chess.engine

from ml.config import MISTAKE_THRESHOLD_CP, EXCLUDE_OPENING_MISTAKES
from ml.ingestion import annotation_cache
from ml.ingestion.annotator import PositionAnnotation
from ml.ingestion.mechanism import tag_mechanism, opportunity_gain
from ml.ingestion.winprob import MISTAKE_ES, LOST_ES, INACCURACY_ES, judgement
from ml.ingestion.threat_classifier import classify_threat  # legacy rule-only fallback

OPPORTUNITY_MAX_ES = 0.92      # already this winning -> another tactic is moot
THREAT_DEPTH = 12


@dataclass
class MistakeEvent:
    game_id:           str
    user_id:           str
    fen:               str
    move_played_uci:   str
    move_played_san:   str
    best_move_uci:     str
    eval_before_cp:    int
    eval_after_cp:     int
    eval_drop_cp:      int
    threat_type:       str
    game_phase:        str          # "opening" | "middlegame" | "endgame"
    time_remaining_ms: Optional[int]
    move_number:       int
    played_at_unix:    Optional[int]  = field(default=None)
    cluster_id:        Optional[str]  = field(default=None)   # filled in Stage 2
    # Classification metadata
    classification_confidence: Optional[float] = field(default=None)
    classification_method:     Optional[str]   = field(default=None)
    eval_drop_category:        Optional[str]   = field(default=None)
    # Maia2 human-move probability fields (populated in pipeline after Stockfish)
    maia2_prob_best:   Optional[float] = field(default=None)
    maia2_prob_played: Optional[float] = field(default=None)
    maia2_surprise:    Optional[float] = field(default=None)
    maia2_difficulty:  Optional[float] = field(default=None)
    # ── v2 Stage-1 fields ──────────────────────────────────────────────────
    side:              str = "user"         # "user" | "opponent" (peer baseline)
    event_id:          str = ""
    ply:               int = 0
    fen_after:         str = ""
    best_line:         list = field(default_factory=list)
    reply_line:        list = field(default_factory=list)
    refutation_uci:    str = ""             # opponent's best reply after the move
    opp_reply_played:  str = ""             # what the opponent actually played next
    es_before:         float = 0.5
    es_after:          float = 0.5
    es_loss:           float = 0.0
    judgement:         Optional[str] = None # "mistake" | "blunder"
    direction:         str = "quiet"        # allowed | missed | both | quiet
    allowed_kind:      Optional[str] = None # walked_into | ignored_threat
    swing_missed_cp:   int = 0
    swing_allowed_cp:  int = 0
    mate_missed:       Optional[int] = None
    mate_allowed:      Optional[int] = None
    framing:           Optional[str] = None # which position was classified
    threat_allowed:    Optional[str] = None
    threat_missed:     Optional[str] = None
    motif_probs:       dict = field(default_factory=dict)
    verified_motifs:   list = field(default_factory=list)
    family_probs:      dict = field(default_factory=dict)
    incident_id:       str = ""
    cascade:           bool = False
    think_time_ms:     Optional[int] = None
    time_trouble:      bool = False
    eval_bucket:       str = "equal"        # ahead | equal | behind (before the move)
    user_elo:          Optional[int] = None # the mover's rating
    opp_elo:           Optional[int] = None
    time_control:      str = ""
    maia2_prob_safe:   Optional[float] = None  # P(peer at this rating avoids the mistake)
    personal_weight:   float = 1.0
    unclassified_reason: Optional[str] = None
    deep:              bool = False
    prev_fen:          str = ""             # position before the opponent's last move
    prev_move_uci:     str = ""             # the opponent's last move (verifier: recaptures)


@dataclass
class Opportunity:
    game_id:        str
    side:           str              # "user" | "opponent"
    ply:            int
    fen:            str
    best_move_uci:  str
    best_line:      list
    gain_cp:        int
    mate:           Optional[int]
    found:          bool
    es_loss:        float
    played_at_unix: Optional[int] = None
    threat_type:    str = "other"
    family_probs:   dict = field(default_factory=dict)
    confidence:     Optional[float] = None
    prev_fen:       str = ""
    prev_move_uci:  str = ""


@dataclass
class GameEvents:
    mistakes:      list            # user MistakeEvents
    peer_mistakes: list            # opponent MistakeEvents
    opportunities: list            # Opportunity (both sides)
    exposure:      dict            # {"user": moves in play, "opponent": ...}


# ---------------------------------------------------------------------------
# Game phase detection
# ---------------------------------------------------------------------------

_PHASE_VAL = {chess.QUEEN: 9, chess.ROOK: 5, chess.BISHOP: 3, chess.KNIGHT: 3}
_HOME_MINORS = {
    chess.WHITE: (chess.B1, chess.G1, chess.C1, chess.F1),
    chess.BLACK: (chess.B8, chess.G8, chess.C8, chess.F8),
}


def _undeveloped(board: chess.Board, color: chess.Color) -> int:
    n = 0
    for sq in _HOME_MINORS[color]:
        p = board.piece_at(sq)
        if p and p.color == color and p.piece_type in (chess.KNIGHT, chess.BISHOP):
            n += 1
    return n


def game_phase(board: chess.Board) -> str:
    """Material + development phase (replaces the old 'move <= 20 = opening'
    rule, which labelled half of all mistakes as opening)."""
    non_pawn = sum(len(board.pieces(pt, chess.WHITE) | board.pieces(pt, chess.BLACK)) * v
                   for pt, v in _PHASE_VAL.items())
    queens = board.pieces(chess.QUEEN, chess.WHITE) | board.pieces(chess.QUEEN, chess.BLACK)
    if non_pawn <= 20 or (not queens and non_pawn <= 26):
        return "endgame"
    if board.fullmove_number <= 8:
        return "opening"
    if board.fullmove_number <= 14 and _undeveloped(board, chess.WHITE) + _undeveloped(board, chess.BLACK) >= 3:
        return "opening"
    return "middlegame"


def _game_phase(fen: str, move_number: int) -> str:   # back-compat helper
    return game_phase(chess.Board(fen))


# ---------------------------------------------------------------------------
# Null-move threat lines (did the opponent already threaten this?)
# ---------------------------------------------------------------------------

def _threat_line(engine: Optional[chess.engine.SimpleEngine], board: chess.Board,
                 cache: dict, ply: int) -> Optional[list]:
    key = str(ply)
    if key in cache:
        return cache[key]
    if engine is None or board.is_check():
        return None
    nb = board.copy(stack=False)
    nb.push(chess.Move.null())
    nb = chess.Board(nb.fen())          # drop the null move from the stack (UCI can't send it)
    if nb.is_game_over() or not any(True for _ in nb.legal_moves):
        cache[key] = []
        return []
    try:
        info = engine.analyse(nb, chess.engine.Limit(depth=THREAT_DEPTH))
        line = [m.uci() for m in info.get("pv", [])[:10]]
    except Exception:
        line = []
    cache[key] = line
    return line


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_game_events(
    annotations: list[PositionAnnotation],
    game: dict,
    user_color: str,
    engine: Optional[chess.engine.SimpleEngine] = None,
    played_at_unix: Optional[int] = None,
    initial_s: Optional[float] = None,
) -> GameEvents:
    """One pass over an annotated game -> user mistakes, peer (opponent)
    mistakes, tactical opportunities for both sides, and exposure counts.

    `game` is the normalised fetcher dict (game_id, white/black usernames, elo,
    time_control). Mistakes are NOT classified here — see classify_events."""
    user_white = user_color == "white"
    gid = game.get("game_id", "")
    names = {True: game.get("white_username", ""), False: game.get("black_username", "")}
    elos = {True: game.get("white_elo"), False: game.get("black_elo")}
    tc = game.get("time_control", "")
    tt_ms = max(30_000, int(0.1 * initial_s * 1000)) if initial_s else 30_000

    threat_cache = annotation_cache.get(gid, "threats") or {}
    n_cached = len(threat_cache)
    mistakes, peer, opps = [], [], []
    exposure = {"user": 0, "opponent": 0}

    for i, ann in enumerate(annotations):
        is_user = ann.is_white_move == user_white
        side = "user" if is_user else "opponent"
        board = chess.Board(ann.fen)
        prev = chess.Board(annotations[i - 1].fen) if i > 0 else None

        if ann.es_before >= LOST_ES:
            exposure[side] += 1

        # ── tactical opportunity (found / missed) ────────────────────────────
        if ann.best_line and ann.es_before < OPPORTUNITY_MAX_ES:
            has_tactic, gain = opportunity_gain(board, ann.best_line, ann.mate_before, prev)
            if has_tactic and (ann.es_loss < INACCURACY_ES or ann.es_loss >= MISTAKE_ES):
                opps.append(Opportunity(
                    game_id=gid, side=side, ply=ann.ply, fen=ann.fen,
                    best_move_uci=ann.best_line[0], best_line=list(ann.best_line),
                    gain_cp=gain, mate=ann.mate_before,
                    found=ann.es_loss < INACCURACY_ES, es_loss=ann.es_loss,
                    played_at_unix=played_at_unix,
                    prev_fen=annotations[i - 1].fen if i > 0 else "",
                    prev_move_uci=annotations[i - 1].move_played_uci if i > 0 else "",
                ))

        # ── mistakes ─────────────────────────────────────────────────────────
        if ann.es_loss < MISTAKE_ES or ann.es_before < LOST_ES:
            continue
        threat_line = None
        mech = tag_mechanism(
            board, ann.best_line, ann.move_played_uci, ann.reply_line,
            ann.mate_before, ann.mate_after_opp, prev_board=prev,
            threat_line=None, es_before=ann.es_before, es_after=ann.es_after,
        )
        if mech.direction in ("allowed", "both"):
            threat_line = _threat_line(engine, board, threat_cache, ann.ply)
            if threat_line:
                mech = tag_mechanism(
                    board, ann.best_line, ann.move_played_uci, ann.reply_line,
                    ann.mate_before, ann.mate_after_opp, prev_board=prev,
                    threat_line=threat_line, es_before=ann.es_before, es_after=ann.es_after,
                )
        clock = ann.clock_remaining_ms
        ev = MistakeEvent(
            game_id=gid,
            user_id=names[ann.is_white_move],
            fen=ann.fen,
            move_played_uci=ann.move_played_uci,
            move_played_san=ann.move_played_san,
            best_move_uci=ann.best_move_uci,
            eval_before_cp=ann.eval_before_cp,
            eval_after_cp=ann.eval_after_cp,
            eval_drop_cp=ann.eval_drop_cp,
            threat_type="other",
            game_phase=game_phase(board),
            time_remaining_ms=clock,
            move_number=ann.move_number,
            played_at_unix=played_at_unix,
            eval_drop_category="blunder" if ann.es_loss >= 0.15 else "mistake",
            side=side,
            event_id=uuid.uuid5(uuid.NAMESPACE_URL, f"{gid}:{ann.ply}").hex[:16],
            ply=ann.ply,
            fen_after=ann.fen_after,
            best_line=list(ann.best_line),
            reply_line=list(ann.reply_line),
            refutation_uci=ann.reply_line[0] if ann.reply_line else "",
            opp_reply_played=annotations[i + 1].move_played_uci if i + 1 < len(annotations) else "",
            es_before=ann.es_before, es_after=ann.es_after, es_loss=ann.es_loss,
            judgement=judgement(ann.es_loss),
            direction=mech.direction, allowed_kind=mech.allowed_kind,
            swing_missed_cp=mech.swing_missed_cp, swing_allowed_cp=mech.swing_allowed_cp,
            mate_missed=mech.mate_missed, mate_allowed=mech.mate_allowed,
            think_time_ms=ann.think_time_ms,
            time_trouble=clock is not None and clock < tt_ms,
            eval_bucket="ahead" if ann.es_before >= 0.65 else ("behind" if ann.es_before <= 0.35 else "equal"),
            user_elo=elos[ann.is_white_move], opp_elo=elos[not ann.is_white_move],
            time_control=tc, deep=ann.deep,
            prev_fen=annotations[i - 1].fen if i > 0 else "",
            prev_move_uci=annotations[i - 1].move_played_uci if i > 0 else "",
        )
        ev.incident_id = ev.event_id
        (mistakes if is_user else peer).append(ev)

    if engine is not None and len(threat_cache) != n_cached:
        annotation_cache.put(gid, threat_cache, "threats")
    return GameEvents(mistakes, peer, opps, exposure)


def link_cascades(events: list[MistakeEvent]) -> None:
    """Collapse one root cause counted on consecutive moves into one INCIDENT.

    Event j continues event i (same game, same side) when it comes within two of
    the mover's moves and either the opponent never cashed in i's refutation and
    j allows the same punishment (same refutation move or target square), or j
    fails the same way in the same family right after."""
    by_game: dict[tuple, list[MistakeEvent]] = {}
    for e in events:
        by_game.setdefault((e.game_id, e.side), []).append(e)
    for evs in by_game.values():
        evs.sort(key=lambda e: e.ply)
        for a, b in zip(evs, evs[1:]):
            if b.ply - a.ply > 4:
                continue
            unpunished = bool(a.refutation_uci) and a.opp_reply_played != a.refutation_uci
            same_target = (a.refutation_uci and b.refutation_uci
                           and (a.refutation_uci == b.refutation_uci
                                or a.refutation_uci[2:4] == b.refutation_uci[2:4]))
            same_family = (a.cluster_id or "") == (b.cluster_id or "") and a.direction == b.direction \
                and b.ply - a.ply == 2
            if (unpunished and same_target) or same_family:
                b.cascade = True
                b.incident_id = a.incident_id


def extract_mistakes(
    annotations:         list[PositionAnnotation],
    game_id:             str,
    user_id:             str,
    user_color:          str,                        # "white" or "black"
    eval_drop_threshold: int = MISTAKE_THRESHOLD_CP,
    played_at_unix:      Optional[int] = None,
    exclude_opening:     bool = EXCLUDE_OPENING_MISTAKES,
    classifier=None,
) -> list[MistakeEvent]:
    """Back-compat wrapper: the user's v2 mistakes for one game, labelled with
    the given classifier (or the legacy rule classifier when None)."""
    game = {"game_id": game_id,
            "white_username": user_id if user_color == "white" else "",
            "black_username": user_id if user_color == "black" else ""}
    evs = extract_game_events(annotations, game, user_color, played_at_unix=played_at_unix).mistakes
    if exclude_opening:
        evs = [e for e in evs if e.game_phase != "opening"]
    if classifier is not None:
        from ml.ingestion.classify_events import classify_events
        classify_events(evs, [], classifier)
    else:
        for e in evs:
            e.threat_type = classify_threat(e.fen, e.best_move_uci)
    return evs
