"""
Unit tests for the Stage-1/2 v2 building blocks (no Stockfish / model needed).

    .venv/Scripts/python -m pytest tests/test_stage12.py -q -p no:cacheprovider
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import chess

from ml.ingestion.winprob import expected_score, es_loss, MISTAKE_ES
from ml.ingestion.mechanism import tag_mechanism, opportunity_gain, settled_gain
from ml.ingestion.mistake_extractor import MistakeEvent, link_cascades, game_phase
from ml.classifier.verifier import verify
from ml.classifier.label_map_v2 import themes_to_classes, threats_of
from ml.clustering.families import family_distribution, family_of
from ml.clustering.profile import build_profile


# ── win probability ─────────────────────────────────────────────────────────

def test_expected_score_basics():
    assert abs(expected_score(0) - 0.5) < 1e-9
    assert expected_score(30_000) == 1.0 and expected_score(-30_000) == 0.0
    assert expected_score(300) > expected_score(100) > expected_score(-100)


def test_winning_slip_is_not_a_mistake_but_equal_blunder_is():
    assert es_loss(900, 600) < MISTAKE_ES          # +9 -> +6 changes nothing
    assert es_loss(0, -200) >= MISTAKE_ES          # equal -> -2 is a mistake
    assert es_loss(30_000, 900) < MISTAKE_ES       # missed mate while still totally winning


# ── mechanism ───────────────────────────────────────────────────────────────

def test_walking_into_a_pawn_capture_is_allowed():
    # Nd5?? steps onto a square the c6 pawn covers; the refutation cxd5 wins the knight.
    blunder = chess.Board("4k3/8/2p5/8/8/2N5/8/4K3 w - - 0 1")
    m = tag_mechanism(blunder, best_line=["c3e4"], played_uci="c3d5",
                      reply_line=["c6d5", "e1d2"], mate_before=None, mate_after_opp=None)
    assert m.direction == "allowed" and m.swing_allowed_cp >= 300


def test_settled_gain_ignores_an_exchange_cut_by_the_horizon():
    # Real case: 19.Qxd6 wins a bishop; the PV ends on ...Qxe3+ with the
    # recapture past the 10-ply horizon. Must read +3, not -6.
    b = chess.Board("r2q1rk1/pp1n1ppp/2nb2b1/2p5/4PP2/PP4PP/1BPQ2B1/RN2R1K1 w - - 1 19")
    line = ["d2d6", "f7f6", "d6d3", "g6f7", "d3e3", "d8b6", "b1c3", "c5c4", "c3d5", "b6e3"]
    assert settled_gain(b, line) == 300


def test_sacrificial_attack_counts_as_allowed():
    # Greek gift: no material is won inside the horizon, but the forcing line
    # takes the opponent from worse to clearly winning.
    b = chess.Board("r1bq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R2QK2R b KQ - 0 8")
    m = tag_mechanism(b, best_line=["c7c5", "a2a3"], played_uci="a7a6",
                      reply_line=["d3h7", "g8h7", "f3g5", "h7g8", "d1h5", "f8e8"],
                      mate_before=None, mate_after_opp=None, es_before=0.55, es_after=0.15)
    assert m.direction in ("allowed", "both")


def test_harmless_move_is_quiet():
    before = chess.Board("4k3/8/2p5/8/8/2N5/8/4K3 w - - 0 1")
    m = tag_mechanism(before, best_line=["c3e4", "e8d7"], played_uci="e1d2",
                      reply_line=["e8d7", "c3e4"], mate_before=None, mate_after_opp=None)
    assert m.direction == "quiet"


def test_missing_a_free_queen_is_missed():
    before = chess.Board("4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1")
    m = tag_mechanism(before, best_line=["c3d5", "e8d7"], played_uci="e1e2",
                      reply_line=["d5d2", "e2f3"], mate_before=None, mate_after_opp=None)
    assert m.direction in ("missed", "both") and m.swing_missed_cp >= 800


def test_recapture_is_not_an_opportunity():
    # Black just played Nxc3 (knight for knight); bxc3 only restores the balance.
    prev = chess.Board("4k3/8/8/3n4/8/2N5/1P6/4K3 b - - 0 1")
    board = chess.Board("4k3/8/8/8/8/2n5/1P6/4K3 w - - 0 1")
    has, gain = opportunity_gain(board, ["b2c3", "e8d7"], None, prev_board=prev)
    assert not has and gain <= 0


# ── verifier (ported lichess-puzzler detectors) ─────────────────────────────

def test_verifier_back_rank_mate():
    b = chess.Board("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1")
    assert {"mate", "backRankMate"} <= verify(b, ["a1a8"])


def test_verifier_knight_fork():
    b = chess.Board("r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1")
    assert "fork" in verify(b, ["b5c7", "e8d7", "c7a8"])


def test_verifier_hanging_piece():
    b = chess.Board("4k3/8/8/3r4/8/8/3Q4/4K3 w - - 0 1")
    assert "hangingPiece" in verify(b, ["d2d5"])


# ── label map v2 ────────────────────────────────────────────────────────────

def test_endgame_is_a_phase_not_a_motif():
    assert themes_to_classes("endgame fork short") == ["fork"]
    assert themes_to_classes("advantage endgame short") == ["endgame"]
    assert set(themes_to_classes("intermezzo fork middlegame")) == {"fork", "intermezzo"}
    assert threats_of(["intermezzo", "defensiveMove"]) == set()
    assert "king_attack" in threats_of(themes_to_classes("exposedKing crushing"))


def test_family_distribution():
    fp = family_distribution({"fork": 0.9, "discoveredAttack": 0.4})
    assert max(fp, key=fp.get) == "loose_pieces" and "defender_disruption" in fp
    assert max(family_distribution({"fork": 0.05}, p_none=0.9), key=lambda k: family_distribution(
        {"fork": 0.05}, p_none=0.9)[k]) == "unclassified"


# ── structured multi-type description ───────────────────────────────────────

def test_fork_with_check_is_loose_pieces_and_king_safety():
    from ml.ingestion.classify_events import describe
    # The opponent's refutation Nc7+ forks king and rook: primary stays
    # loose_pieces (Lichess convention), king safety is attached as well.
    m = MistakeEvent(game_id="g", user_id="u", fen=chess.STARTING_FEN, move_played_uci="e2e4",
                     move_played_san="e4", best_move_uci="d2d4", eval_before_cp=0, eval_after_cp=-400,
                     eval_drop_cp=400, threat_type="fork", game_phase="middlegame", time_remaining_ms=None,
                     move_number=20, direction="allowed", cluster_id="loose_pieces", swing_allowed_cp=500,
                     fen_after="r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", reply_line=["b5c7", "e8d7", "c7a8"],
                     family_probs={"loose_pieces": 0.8, "unclassified": 0.2}, judgement="blunder")
    d = describe(m, {"probs": {"fork": 0.9}, "verified": ["fork"]}, None)
    fams = [f["family"] for f in d["families"]]
    assert d["primary_family"] == "loose_pieces" and fams[0] == "loose_pieces" and "king_safety" in fams
    assert {"involves_king", "check", "wins_material"} <= set(d["tags"])


# ── cascades & phase ────────────────────────────────────────────────────────

def _ev(ply, refut, opp_played, fam="loose_pieces", direction="allowed", game="g1"):
    e = MistakeEvent(game_id=game, user_id="u", fen=chess.STARTING_FEN, move_played_uci="e2e4",
                     move_played_san="e4", best_move_uci="d2d4", eval_before_cp=0, eval_after_cp=-200,
                     eval_drop_cp=200, threat_type="hanging_piece", game_phase="middlegame",
                     time_remaining_ms=None, move_number=10 + ply // 2, ply=ply, refutation_uci=refut,
                     opp_reply_played=opp_played, direction=direction, cluster_id=fam,
                     event_id=f"{game}:{ply}")
    e.incident_id = e.event_id
    return e


def test_unpunished_repeat_is_one_incident():
    a, b = _ev(20, "d6e5", "h7h6"), _ev(22, "d6e5", "d6e5")
    link_cascades([a, b])
    assert b.cascade and b.incident_id == a.incident_id


def test_unrelated_mistakes_stay_separate():
    a, b = _ev(20, "d6e5", "d6e5", fam="alignment"), _ev(30, "a2a3", "b7b6")
    link_cascades([a, b])
    assert not b.cascade


def test_game_phase_is_not_move_number_based():
    b = chess.Board("4k3/pp4pp/8/8/8/8/PP4PP/4K3 w - - 0 15")
    assert game_phase(b) == "endgame"
    b = chess.Board("r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 15")
    assert game_phase(b) == "middlegame"


# ── Stage-2 profile ─────────────────────────────────────────────────────────

def _m(game, ply, fam, side="user", es=0.2):
    threat = {"loose_pieces": "hanging_piece", "alignment": "pin"}.get(fam, "other")
    return {"game_id": game, "ply": ply, "side": side, "event_id": f"{game}:{ply}:{side}",
            "incident_id": f"{game}:{ply}:{side}", "cascade": False, "es_loss": es, "eval_drop_cp": 300,
            "threat_type": threat, "family_probs": {fam: 1.0}, "personal_weight": 1.0,
            "game_phase": "middlegame", "direction": "allowed", "played_at_unix": 1_700_000_000 + ply}


def test_peer_relative_profile_flags_a_real_blindspot():
    games = [f"g{i}" for i in range(60)]
    exposure = [{"game_id": g, "played_at_unix": 1_700_000_000 + i, "user_moves": 35, "opp_moves": 35}
                for i, g in enumerate(games)]
    user = [_m(g, 20, "loose_pieces") for g in games[:30]] + [_m("g1", 40, "alignment")]
    peers = [_m(g, 21, "loose_pieces", side="opponent") for g in games[:6]] + \
            [_m(g, 41, "alignment", side="opponent") for g in games[:3]]
    prof = build_profile(user, "u", peers, [], exposure)
    rows = {r["family"]: r for r in prof["families"]}
    assert prof["clusters"][0].cluster_id == "loose_pieces"
    assert rows["loose_pieces"]["status"] == "confirmed"
    assert rows["loose_pieces"]["relative_rate"] > 2
    assert rows["alignment"]["status"] == "insufficient_data"


def test_missing_available_tactics_flags_a_blindspot_even_at_a_typical_mistake_rate():
    games = [f"g{i}" for i in range(60)]
    exposure = [{"game_id": g, "played_at_unix": 1_700_000_000 + i, "user_moves": 35, "opp_moves": 35}
                for i, g in enumerate(games)]
    user = [_m(g, 20, "alignment") for g in games[:6]]
    peers = [_m(g, 21, "alignment", side="opponent") for g in games[:6]]
    opp = lambda g, side, found: {"game_id": g, "side": side, "found": found, "es_loss": 0.0 if found else 0.3,
                                  "family_probs": {"alignment": 1.0}}
    opps = [opp(g, "user", i % 3 == 0) for i, g in enumerate(games[:30])] + \
           [opp(g, "opponent", i % 10 != 0) for i, g in enumerate(games[:30])]
    row = {r["family"]: r for r in build_profile(user, "u", peers, opps, exposure)["families"]}["alignment"]
    assert row["status"] == "confirmed"
    assert "finds fewer of these tactics than peers" in row["status_reasons"]
    assert row["excess_from_missed_tactics"] > 0
