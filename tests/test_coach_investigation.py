"""Chess correctness and bounded investigation tests; no LLM/network needed."""
from __future__ import annotations

import importlib
import json
from dataclasses import asdict
import threading
from pathlib import Path

import chess
import chess.engine
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.coach.investigation import (
    InvestigationRequest, Reply, build_claims, candidate_from, investigate,
    moves_in_question, parse_move, replay_line, score_from, score_key, score_label,
)
from ml.config import STOCKFISH_PATH

MATE = "7k/6pp/8/8/8/8/R7/K7 w - - 0 1"
FORK = "8/3q3k/8/3N4/8/8/8/6K1 w - - 0 1"


class FakeEngine:
    id = {"name": "test engine"}

    def __init__(self, clock=None, elapsed=0):
        self.calls = []
        self.clock = clock
        self.elapsed = elapsed

    def analyse(self, board, limit, multipv=1, root_moves=None):
        self.calls.append((board.fen(), root_moves, limit))
        if self.clock:
            self.clock.value += self.elapsed
        moves = list(root_moves or []) or [
            m for u in ["e2e4", "d2d4", "g1f3"]
            if (m := chess.Move.from_uci(u)) in board.legal_moves]
        moves = moves or list(board.legal_moves)
        out = []
        for move in moves[:multipv]:
            after = board.copy()
            after.push(move)
            pv = [move]
            if not after.is_game_over():
                pv.append(next(iter(after.legal_moves)))
            out.append({"pv": pv, "depth": limit.depth,
                        "score": chess.engine.PovScore(chess.engine.Cp(30), chess.WHITE)})
        return out


class FakeClock:
    value = 0.0

    def __call__(self):
        return self.value


@pytest.fixture(scope="module")
def engine():
    if not STOCKFISH_PATH.exists():
        pytest.skip("Stockfish binary not installed")
    with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as sf:
        yield sf


@pytest.mark.parametrize("fen", ["bad fen", "8/8/8/8/8/8/8/8 w - - 0 1", "8/8/8/8/8/8/8/Kk6 w - - 0 1", "8/8/8/8/8/8/8/K6k w"])
def test_invalid_position_rejected_before_search(fen):
    fake = FakeEngine()
    with pytest.raises(ValueError):
        investigate(InvestigationRequest(fen), engine=fake)
    assert not fake.calls


@pytest.mark.parametrize("move", ["e2e5", "e7e5", "Ka9", "0000", "Qh5"])
def test_illegal_move_rejected(move):
    with pytest.raises(ValueError, match="legal move"):
        parse_move(chess.Board(), move)


def test_san_and_uci_promotion():
    b = chess.Board("7k/P7/8/8/8/8/8/K7 w - - 0 1")
    assert parse_move(b, "a8=N") == parse_move(b, "a7a8n")


def test_question_extracts_castle_and_two_moves_without_inventing_illegal_moves():
    b = chess.Board()
    assert [m.uci() for m in moves_in_question(b, "Why e2e4 instead of d4? Does Qh5 work?")] == ["e2e4", "d2d4"]
    b = chess.Board("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
    assert moves_in_question(b, "Compare O-O and O-O-O") == [parse_move(b, "O-O"), parse_move(b, "O-O-O")]


def test_outside_multipv_alternative_is_explicitly_searched():
    fake = FakeEngine()
    result = investigate(InvestigationRequest(chess.STARTING_FEN, focus_move="e4", alternative_move="a3"), engine=fake)
    alt = next(c for c in result.candidates if c.move_uci == "a2a3")
    assert "alternative" in alt.roles and alt.refined
    assert any(roots == [chess.Move.from_uci("a2a3")] for _, roots, _ in fake.calls)
    assert alt.replies  # A separate search is made AFTER the alternative.


def test_black_score_perspective_and_mate_ordering():
    score = score_from({"score": chess.engine.PovScore(chess.engine.Cp(-250), chess.WHITE)}, chess.BLACK)
    assert score.white_cp == -250 and score.mover_cp == 250
    win = score_from({"score": chess.engine.PovScore(chess.engine.Mate(-3), chess.WHITE)}, chess.BLACK)
    assert win.white_mate == -3 and win.mover_mate == 3
    assert "Black mates in 3" == score_label(win)
    assert score_key(win) > score_key(score)
    loss = score_from({"score": chess.engine.PovScore(chess.engine.Mate(2), chess.WHITE)}, chess.BLACK)
    assert score_key(loss) < score_key(score)
    assert loss.white_cp is None and loss.mover_cp is None


def test_replay_rejects_illegal_pv():
    with pytest.raises(ValueError, match="illegal move"):
        replay_line(chess.Board(), [chess.Move.from_uci("e2e5")], chess.WHITE)


def test_replay_stops_at_dead_position_and_counts_full_material():
    b = chess.Board(FORK)
    line = replay_line(b, [parse_move(b, "Nf6+")], chess.WHITE)
    after = chess.Board(line.fens[-1])
    reply = parse_move(after, "Kg6")
    after.push(reply)
    capture = parse_move(after, "Nxd7")
    line = replay_line(b, [parse_move(b, "Nf6+"), reply, capture], chess.WHITE)
    assert line.material_change == 9
    assert line.terminal == "insufficient_material (1/2-1/2)"


def test_sacrifice_material_includes_first_move_and_recapture():
    b = chess.Board("6k1/8/3p4/4r3/4Q3/8/8/6K1 w - - 0 1")
    first = parse_move(b, "Qxe5")
    after = b.copy(); after.push(first)
    second = parse_move(after, "dxe5")
    line = replay_line(b, [first, second], chess.WHITE)
    assert line.material_change == -4  # +5 rook, -9 queen, not just the recapture.
    c = candidate_from(b, {"pv": [first, second], "depth": 12,
                           "score": chess.engine.PovScore(chess.engine.Cp(-300), chess.WHITE)}, ["focus"])
    c.replies = [Reply(second.uci(), after.san(second), c.score, 16, line)]
    claims = build_claims(b, [c])
    assert any(cl.status == "rejected" and "wins material" in cl.hypothesis for cl in claims)
    assert not any(cl.status == "verified" and "wins material" in cl.hypothesis for cl in claims)


def test_terminal_position_never_runs_engine():
    board = chess.Board(MATE); board.push_san("Ra8#")
    fake = FakeEngine()
    result = investigate(InvestigationRequest(board.fen()), engine=fake)
    assert result.status == "terminal" and result.terminal == "checkmate"
    assert not result.candidates and not fake.calls


def test_budget_stops_new_searches_and_preserves_partial_evidence():
    clock = FakeClock()
    fake = FakeEngine(clock=clock, elapsed=0.3)
    result = investigate(InvestigationRequest(chess.STARTING_FEN, budget_seconds=0.25), engine=fake, clock=clock)
    assert len(fake.calls) == 1
    assert result.status == "partial" and result.budget["exhausted"]
    assert result.candidates
    assert all(not c.replies for c in result.candidates)


def test_busy_engine_obeys_wait_budget():
    lock = threading.Lock(); lock.acquire()
    fake = FakeEngine()
    try:
        result = investigate(InvestigationRequest(chess.STARTING_FEN, budget_seconds=0.25), engine=fake, lock=lock)
    finally:
        lock.release()
    assert result.status == "partial" and not fake.calls
    assert result.budget["elapsed_seconds"] < 0.5


def test_identical_moves_and_nonfinite_budgets_rejected():
    for req in [InvestigationRequest(chess.STARTING_FEN, focus_move="e4", alternative_move="e2e4"),
                InvestigationRequest(chess.STARTING_FEN, budget_seconds=float("nan"))]:
        with pytest.raises(ValueError):
            investigate(req, engine=FakeEngine())


def test_real_engine_mate_is_verified_and_every_pv_replays(engine):
    result = investigate(InvestigationRequest(MATE, focus_move="Ra8#", alternative_move="Ra3", budget_seconds=3), engine=engine)
    assert result.candidates[0].move_uci == "a2a8"
    assert any(c.status == "verified" and "is checkmate" in c.hypothesis for c in result.claims)
    for c in result.candidates:
        assert replay_line(chess.Board(MATE), [chess.Move.from_uci(u) for u in c.line.uci], chess.WHITE).fens == c.line.fens


def test_real_engine_fork_independent_reply_checks(engine):
    result = investigate(InvestigationRequest(FORK, "Why Nf6+ instead of Ne3?", budget_seconds=4), engine=engine)
    focus = next(c for c in result.candidates if "focus" in c.roles)
    assert focus.move_uci == "d5f6" and focus.replies
    assert {"queen on d7", "king on h7"} <= set(focus.attacked_targets)
    assert any(c.status == "likely" and "wins material" in c.hypothesis for c in result.claims)
    assert result.budget["elapsed_seconds"] < 4.75
    assert set(focus.legal_replies) == {"Kg6", "Kh6", "Kg7", "Kh8"}
    assert any(c.status == "verified" and "After every legal first reply" in c.hypothesis
               and "insufficient material" in c.hypothesis for c in result.claims)


def test_real_engine_black_mate_keeps_original_mover_perspective(engine):
    b = chess.Board(MATE).mirror()
    result = investigate(InvestigationRequest(b.fen(), focus_move="Ra1#", budget_seconds=2), engine=engine)
    best = result.candidates[0]
    assert best.move_san == "Ra1#"
    assert best.score.white_mate == -1 and best.score.mover_mate == 1
    assert result.side_to_move == "black"


def test_en_passant_and_promotion_are_exact_board_facts():
    b = chess.Board("6k1/8/8/3pP3/8/8/8/6K1 w - d6 0 1")
    c = candidate_from(b, {"pv": [parse_move(b, "exd6")], "depth": 12}, ["focus"])
    assert c.captured_piece == "pawn (en passant)"
    assert c.line.material_change == 1
    b = chess.Board("7k/P7/8/8/8/8/8/K7 w - - 0 1")
    c = candidate_from(b, {"pv": [parse_move(b, "a8=N")], "depth": 12}, ["focus"])
    assert c.line.material_change == 2  # knight replaces pawn.
    assert c.line.terminal == "insufficient_material (1/2-1/2)"


def test_missing_llm_key_uses_evidence_template(monkeypatch):
    explain = importlib.import_module("backend.coach.explain")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("C1_ENDPOINT", raising=False)
    result = {"explanation": "Local facts.", "source": "stockfish", "candidates": []}
    assert explain.narrate_evidence(result) == ("Local facts.", "template")


def test_narration_failure_never_discards_checked_evidence(monkeypatch):
    import groq
    explain = importlib.import_module("backend.coach.explain")
    monkeypatch.setenv("GROQ_API_KEY", "test-only")
    monkeypatch.delenv("C1_ENDPOINT", raising=False)
    monkeypatch.setattr(groq, "Groq", lambda **kwargs: (_ for _ in ()).throw(RuntimeError("unavailable")))
    c = candidate_from(chess.Board(), {"pv": [chess.Move.from_uci("e2e4")], "depth": 12}, ["candidate"])
    result = {"explanation": "Local facts.", "source": "stockfish", "candidates": [asdict(c)]}
    assert explain.narrate_evidence(result) == ("Local facts.", "template")


def test_narration_overclaims_are_rejected_against_board_evidence():
    explain = importlib.import_module("backend.coach.explain")
    b = chess.Board(FORK)
    first = parse_move(b, "Nf6+"); after = b.copy(); after.push(first)
    reply = parse_move(after, "Kg6"); after.push(reply)
    capture = parse_move(after, "Nxd7")
    focus = candidate_from(b, {"pv": [first, reply, capture], "depth": 18,
                              "score": chess.engine.PovScore(chess.engine.Cp(0), chess.WHITE)}, ["focus"])
    alt = candidate_from(b, {"pv": [parse_move(b, "Ne3")], "depth": 18,
                            "score": chess.engine.PovScore(chess.engine.Cp(-436), chess.WHITE)}, ["alternative"])
    result = {"explanation": "Checked facts.", "candidates": [asdict(focus), asdict(alt)]}
    assert explain.narration_issues("The only legal replies are Kg6 and Kh6.", result)
    assert explain.narration_issues("The insufficient material draw can be won if the opponent makes a mistake.", result)
    assert explain.narration_issues("The evaluation gap is small.", result)
    assert explain.narration_issues("White should play Qh5 next.", result)
    assert explain.narration_issues("The resulting material is a knight versus a queen and king.", result)
    assert explain.narration_issues("Ne3 scores -4.36 cp.", result)
    assert explain.narration_issues("This is the only move that secures a draw.", result)
    assert explain.narration_issues("Ne3 loses material because its evaluation is negative.", result)
    result["candidates"][1]["line"]["material_balance"] = -6
    assert explain.narration_issues("White ends up down about 6.8 pawns.", result)
    assert explain.checked_narration("It may still be a draw unless Black makes a mistake.", result, "groq") == ("Checked facts.", "template")
    assert not explain.narration_issues("Nf6+ checks the king and attacks the queen. Nxd7 ends in an insufficient-material draw.", result)


def test_minimal_single_pv_baseline_remains_valid_narrator_input():
    explain = importlib.import_module("backend.coach.explain")
    result = {"candidates": [{"move_san": "Ra8#", "roles": ["candidate"],
                              "score": {"white_cp": None, "white_mate": 1},
                              "line": {"san": ["Ra8#"], "material_change": None}, "replies": []}]}
    assert not explain.narration_issues("Ra8# mates immediately.", result)


def test_position_chat_without_llm_always_emits_evidence_and_finishes(monkeypatch):
    router = importlib.import_module("backend.coach.router")
    result = {"source": "stockfish", "fen": MATE, "explanation": "Checked mate.", "candidates": []}
    monkeypatch.setattr(router, "explain_position", lambda *args: result)
    monkeypatch.setattr(router, "_groq_client", lambda: pytest.fail("Local analysis must not need Groq"))
    events = [json.loads(s.removeprefix("data: ").strip()) for s in router._chat_stream(
        router.CoachChatRequest(username="test", mode="position", message="Why?", position_fen=MATE, use_llm=False))]
    assert any(e["type"] == "tool_result" and e["payload"]["fen"] == MATE for e in events)
    assert events[-1]["type"] == "done"
    assert "Checked mate." == "".join(e["text"] for e in events if e["type"] == "token")


def test_api_validates_budget_and_returns_invalid_position_as_400(monkeypatch):
    router = importlib.import_module("backend.coach.router")
    app = FastAPI(); app.include_router(router.router)
    client = TestClient(app)
    assert client.post("/api/coach/investigate", json={"fen": MATE, "budget_seconds": 100}).status_code == 422
    assert client.post("/api/coach/investigate", json={"fen": "invalid"}).status_code == 400


def test_benchmark_seed_has_30_legal_cases():
    cases = json.loads((Path(__file__).parent / "fixtures/coach_positions.json").read_text(encoding="utf-8"))["positions"]
    assert len(cases) == 30
    for case in cases:
        b = chess.Board(case["fen"])
        assert b.is_valid(), case["id"]
        for key in ("focus_move", "alternative_move"):
            if case.get(key):
                parse_move(b, case[key])
