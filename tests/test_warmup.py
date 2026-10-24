"""Warm-Up acceptance tests.

    .venv/Scripts/python -m pytest tests/test_warmup.py -q -p no:cacheprovider
    WARMUP_TEST_N=100 ...   # quicker local run (acceptance uses 1000 items per generator)

Every generated item must be a LEGAL position and its answer must match an INDEPENDENT
re-computation (not the helper that produced it).
"""
from __future__ import annotations

import os
import random
import time

import chess
import pytest

from backend.warmup import composer, games as G, outcomes, store
from backend.warmup.config import BANK_DB, band_for, band_by_id, cfg
from backend.warmup.drills import GENERATORS

N = int(os.getenv("WARMUP_TEST_N", "1000"))
CTX = {"username": "", "rating": 1500, "band": band_for(1500), "seen": set()}
V = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}


def gen(drill: str, n: int = N) -> list[dict]:
    rng = random.Random(1234)
    out = []
    level = 1
    while len(out) < n:
        out += GENERATORS[drill](rng, level, min(50, n - len(out)), CTX)
        level = level % 5 + 1
    return out[:n]


def best_recapture_gain(board: chess.Board, square: int) -> int:
    """Exhaustive minimax over all legal capture sequences on one square (independent of the
    least-valuable-attacker swap list in chesskit.see). Side to move may also stop."""
    caps = [m for m in board.legal_moves if m.to_square == square and board.is_capture(m)]
    best = 0
    for m in caps:
        victim = board.piece_at(square)
        gain = V[chess.PAWN] if victim is None else V[victim.piece_type]
        board.push(m)
        gain -= best_recapture_gain(board, square)
        board.pop()
        best = max(best, gain)
    return best


# ── perception drills ───────────────────────────────────────────────────────

def test_check_flash_legal_and_correct():
    items = gen("check_flash")
    checks = 0
    for it in items:
        b = chess.Board(it["fen"])
        assert b.is_valid(), it
        assert it["answer"] == bool(b.attackers(chess.WHITE, b.king(chess.BLACK)))
        f0, r0, k = it["window"]
        inside = {chess.square(f, r) for f in range(f0, f0 + k) for r in range(r0, r0 + k)}
        for sq, p in b.piece_map().items():      # everything but the white king is inside the shown region
            assert sq in inside or (p.piece_type == chess.KING and p.color == chess.WHITE)
        checks += it["answer"]
    assert .4 < checks / len(items) < .6        # balanced


def test_double_check_hunt_exactly_one():
    for it in gen("double_check_hunt", max(200, N // 5)):
        counts = []
        for bd in it["boards"]:
            b = chess.Board(bd["fen"])
            assert b.is_valid()
            counts.append(len(b.attackers(chess.WHITE, b.king(chess.BLACK))))
        assert counts.count(2) == 1 and counts.index(2) == it["answer"]


def test_loose_pieces_truth():
    for it in gen("loose_pieces"):
        b = chess.Board(it["fen"])
        assert b.is_valid()
        truth = sorted(chess.square_name(sq) for sq, p in b.piece_map().items()
                       if p.piece_type != chess.KING and (it["include_pawns"] or p.piece_type != chess.PAWN)
                       and not any(b.color_at(a) == p.color for a in b.attackers(p.color, sq)))
        assert truth == sorted(it["answer"]) and it["answer"]


def test_threat_count_truth():
    """In danger = some legal capture nets material (exhaustive exchange search);
    hanging = some legal capture can't be answered by any recapture."""
    for it in gen("threat_count"):
        b = chess.Board(it["fen"])
        assert b.is_valid() and not b.is_check()
        me = b.turn
        opp = b.copy(stack=False)
        opp.push(chess.Move.null())
        n = 0
        for sq, p in b.piece_map().items():
            if p.color != me or p.piece_type in (chess.KING, chess.PAWN):
                continue
            caps = [m for m in list(opp.legal_moves) if m.to_square == sq and opp.is_capture(m)]
            if it["variant"] == "hanging":
                hit = False
                for m in caps:
                    opp.push(m)
                    hit = hit or not any(opp.is_capture(r) and r.to_square == sq for r in opp.legal_moves)
                    opp.pop()
            else:
                hit = any(_net_gain(opp, m) >= 1 for m in caps)
            n += hit
        assert n == it["answer"], it


def test_threat_count_queen_vs_defended_knight_is_no_threat():
    from backend.warmup.chesskit import threatened_squares
    # White Nd4 defended by Pe3, attacked only by the black queen on d8: not a threat
    b = chess.Board("3qk3/8/8/8/3N4/4P3/8/4K3 w - - 0 1")
    assert threatened_squares(b, chess.WHITE) == []
    # the same knight attacked by a pawn IS in danger
    b = chess.Board("4k3/8/8/2p5/3N4/4P3/8/4K3 w - - 0 1")
    assert threatened_squares(b, chess.WHITE) == [chess.D4]


def test_what_changed_one_legal_quiet_move():
    for it in gen("what_changed"):
        a, b = chess.Board(it["fen_a"]), chess.Board(it["fen_b"])
        assert a.is_valid() and b.is_valid()
        mv = chess.Move.from_uci(it["move"])
        assert mv in a.legal_moves and not a.is_capture(mv)
        a.push(mv)
        assert a.board_fen() == b.board_fen()
        diff = [sq for sq in chess.SQUARES if chess.Board(it["fen_a"]).piece_at(sq) != b.piece_at(sq)]
        assert sorted(chess.square_name(s) for s in diff) == sorted(it["answer"])


def test_opponent_threat_truth():
    items = gen("opponent_threat")
    kinds = {"capture": 0, "mate": 0, "none": 0}
    for it in items:
        before = chess.Board(it["before"])
        mv = chess.Move.from_uci(it["last"])
        assert mv in before.legal_moves
        before.push(mv)
        assert before.board_fen() == chess.Board(it["fen"]).board_fen()
        b = chess.Board(it["fen"])
        assert b.is_valid() and not b.is_check()
        null = b.copy(stack=False)
        null.push(chess.Move.null())
        mate = any(_gives_mate(null, m) for m in list(null.legal_moves))
        kinds[it["answer"]["kind"]] += 1
        if it["answer"]["kind"] == "mate":
            assert mate
            continue
        assert not mate
        winners = {chess.square_name(m.to_square) for m in list(null.legal_moves)
                   if null.is_capture(m) and _net_gain(null, m) >= 2}
        if it["answer"]["kind"] == "none":
            assert not winners
            assert not any(null.is_capture(m) and _net_gain(null, m) >= 1 for m in list(null.legal_moves))
        else:
            assert set(it["answer"]["squares"]) == winners
    assert kinds["none"] > len(items) * .15 and kinds["capture"] > len(items) * .3


def _gives_mate(board: chess.Board, move: chess.Move) -> bool:
    board.push(move)
    mate = board.is_checkmate()
    board.pop()
    return mate


def _net_gain(board: chess.Board, move: chess.Move) -> int:
    victim = board.piece_at(move.to_square)
    gain = V[chess.PAWN] if victim is None else V[victim.piece_type]
    board.push(move)
    gain -= best_recapture_gain(board, move.to_square)
    board.pop()
    return gain


# ── thinking drills ─────────────────────────────────────────────────────────

def test_easy_sprint_below_rating_and_legal():
    items = GENERATORS["easy_sprint"](random.Random(3), 3, 40, {**CTX, "rating": 1500})
    assert items
    for it in items:
        b = chess.Board(it["fen"])
        for u in it["moves"].split():
            mv = chess.Move.from_uci(u)
            assert mv in b.legal_moves
            b.push(mv)
        assert it["rating"] < 1500


@pytest.mark.skipif(not BANK_DB.exists(), reason="two-candidates bank not built")
def test_two_candidates_bank_verified_with_multipv():
    from ml.config import STOCKFISH_PATH
    import chess.engine
    items = GENERATORS["two_candidates"](random.Random(9), 3, 8, CTX)
    assert items
    with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as eng:
        for it in items:
            b = chess.Board(it["fen"])
            assert b.is_valid()
            pov = b.turn
            best = [chess.Move.from_uci(u) for u in it["best"]]
            tempting = next(m for m in b.legal_moves if b.san(m) == it["tempting_san"])
            assert tempting not in best and all(m in b.legal_moves for m in best)
            sb = eng.analyse(b, chess.engine.Limit(depth=14), root_moves=best)["score"].pov(pov).score(mate_score=10000)
            st = eng.analyse(b, chess.engine.Limit(depth=14), root_moves=[tempting])["score"].pov(pov).score(mate_score=10000)
            assert sb - st >= 100                       # mined at >= 150 cp; small slack for search noise


# ── tilt gate on fixture histories ──────────────────────────────────────────

def _games(results: list[float], start: float | None = None, gap: float = 900) -> list[dict]:
    t0 = start or time.time()
    return [{"result": r, "played_at": t0 - i * gap, "start_at": t0 - i * gap, "time_control": "blitz"}
            for i, r in enumerate(results)]


@pytest.mark.parametrize("band_id,results,triggered", [
    ("u800", [0, 0, 1], True), ("u800", [0, 1, 0], False), ("800-1200", [0, 0], True),
    ("1200-1600", [0, 0, 1], False), ("1200-1600", [0, 0, 0, 1], True),
    ("1600-2000", [0, 0, 0], True), ("2000+", [0, 0, 0, 0], False), ("2000+", [0] * 5, True),
    ("1200-1600", [0.5, 0, 0, 0], False),
])
def test_tilt_thresholds(band_id, results, triggered):
    t = G.tilt(_games(results), band_by_id(band_id))
    assert t["triggered"] is triggered
    if triggered:
        assert t["break_until"] > time.time()


def test_tilt_ignores_old_streaks():
    old = _games([0, 0, 0, 0, 0, 0], start=time.time() - 3 * 86400)
    assert not G.tilt(old, band_by_id("u800"))["triggered"]


def test_lichess_millisecond_timestamps():
    assert G._seconds(1792318574000) == pytest.approx(1792318574)
    assert G._seconds(1792318574) == 1792318574


# ── composer ────────────────────────────────────────────────────────────────

def test_composer_order_and_budgets(monkeypatch):
    monkeypatch.setattr(G, "band_info", lambda *a, **k: (band_for(1450), {"rating": 1450, "source": "manual"}, []))
    for minutes, n_perception in ((3, 1), (5, 2), (10, 3)):
        plan = composer.compose(username="", platform="chesscom", time_control="blitz", minutes=minutes,
                                fallback_rating=1450, seed=minutes)
        acts = [s["activity"] for s in plan["steps"]]
        assert acts[0] == "setup_check" and acts[-1] == "easy_sprint"
        assert sum(a in composer.PERCEPTION for a in acts) == n_perception
        assert len(set(acts)) == len(acts)
        for s in plan["steps"]:
            if s["kind"] != "state":
                assert s["pools"][str(s["level"])] and s["cap_ms"] > 0
    blitz = composer.compose(username="", platform="chesscom", time_control="blitz", minutes=3, fallback_rating=1450, seed=1)
    classical = composer.compose(username="", platform="chesscom", time_control="classical", minutes=3, fallback_rating=1450, seed=1)
    assert blitz["steps"][-1]["cap_ms"] < classical["steps"][-1]["cap_ms"]


def test_composer_breathing_after_loss_and_routine(monkeypatch):
    lost = _games([0.0, 1.0])
    monkeypatch.setattr(G, "band_info", lambda *a, **k: (band_for(1450), {"rating": 1450, "source": "manual"}, lost))
    plan = composer.compose(username="", platform="chesscom", time_control="rapid", minutes=5, fallback_rating=1450, seed=2)
    assert [s["activity"] for s in plan["steps"]][:2] == ["setup_check", "breathing_reset"]
    plan = composer.compose(username="", platform="chesscom", time_control="rapid", minutes=5, fallback_rating=1450, seed=2,
                            routine=["move_nudge", "check_flash", "worry_dump"])
    assert [s["activity"] for s in plan["steps"]] == ["move_nudge", "check_flash", "worry_dump"]


def test_independent_of_blindspot_profile_and_classifier():
    import pathlib
    src = "\n".join(p.read_text(encoding="utf-8") for p in pathlib.Path("backend/warmup").rglob("*.py"))
    for forbidden in ("ml.clustering", "threat_classifier", "cluster_id", "family_probs", "motif_probs", "maia"):
        assert forbidden not in src, forbidden


# ── outcome linking + experiment (fixtures, temp DB) ────────────────────────

@pytest.fixture()
def tmpdb(tmp_path, monkeypatch):
    path = tmp_path / "warmup.db"
    monkeypatch.setattr(store, "STORE_DB", path)
    return path


def test_outcome_linking_window(tmpdb):
    now = time.time()
    store.write("INSERT INTO moments (id, username, platform, created_at, time_control, band, rating, arm, in_experiment, play_at) "
                "VALUES ('m1','alice','lichess',?, 'blitz','1200-1600',1400,'warmup',1,?)", (now - 3600, now - 3500))
    recent = [
        {"game_id": "before", "start_at": now - 4000, "time_control": "blitz", "pgn": "1. e4 e5", "user_color": "white", "result": 1.0},
        {"game_id": "next", "start_at": now - 3300, "time_control": "blitz", "pgn": "1. e4 e5", "user_color": "white", "result": 0.0},
        {"game_id": "later", "start_at": now - 600, "time_control": "blitz", "pgn": "1. e4 e5", "user_color": "white", "result": 1.0},
    ]
    fake = lambda pgn, color, q: {"accuracy": 80.0, "blunders": 2, "mistakes": 1, "moves": 40, "blunders_per40": 2.0}
    assert outcomes.link_user("alice", "lichess", analyser=fake, recent=recent) == 1
    rows = store.query("SELECT game_id, blunders_per40 FROM outcomes")
    assert rows == [{"game_id": "next", "blunders_per40": 2.0}]
    assert store.one("SELECT linked_at FROM moments WHERE id = 'm1'")["linked_at"]
    assert outcomes.link_user("alice", "lichess", analyser=fake, recent=recent) == 0     # idempotent


def test_randomized_assignment_stored(tmpdb):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.warmup import router as R
    app = FastAPI(); app.include_router(R.router)
    c = TestClient(app)
    orig = G.band_info
    G.band_info = lambda *a, **k: (band_for(1400), {"rating": 1400, "source": "manual"}, [])
    try:
        body = {"username": "bob", "platform": "chesscom", "time_control": "blitz", "rating": 1400}
        assert {c.post("/api/warmup/moment", json=body).json()["arm"] for _ in range(10)} == {"warmup"}   # no consent
        c.post("/api/warmup/consent", json={"username": "bob", "granted": True})
        arms = [c.post("/api/warmup/moment", json=body).json()["arm"] for _ in range(200)]
        assert 60 < arms.count("control") < 140
        stored = store.query("SELECT arm, in_experiment FROM moments WHERE username = 'bob'")
        assert len(stored) == 210 and sum(r["in_experiment"] for r in stored) == 200
    finally:
        G.band_info = orig


def test_config_is_single_source():
    c = cfg()
    assert [b["id"] for b in c["bands"]] == ["u800", "800-1200", "1200-1600", "1600-2000", "2000+"]
    assert [c["time_controls"][t]["multiplier"] for t in ("bullet", "blitz", "rapid", "classical")] == [.6, .8, 1.0, 1.2]
    assert c["flags"]["warmup_puzzles_update_srs"] is False and c["flags"]["warmup_puzzles_update_theme_ratings"] is False
