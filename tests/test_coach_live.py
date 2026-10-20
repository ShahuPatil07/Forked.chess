"""Voice-turn root correctness, free-mode isolation, and audible move notation."""
from copy import deepcopy

import chess
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.coach import live
from backend.coach.live import LiveTurnRequest, select_position, say_move, speech_text
from backend.coach.router import router


def turn(move="e2e4", **kwargs):
    before = chess.Board()
    after = before.copy(); after.push_uci(move)
    return LiveTurnRequest(fen=after.fen(), before_fen=before.fen(), last_move=move,
                           question=kwargs.pop("question", "Was that a good move?"), **kwargs)


def test_last_move_is_analyzed_from_before_not_opponents_turn():
    board, focus, target = select_position(turn())
    assert board.fen() == chess.STARTING_FEN
    assert focus == "e2e4" and target == "last_move"


@pytest.mark.parametrize("question", ["What should I play now?", "What is the next move?", "Who is better?", "What should black play?"])
def test_current_question_overrides_last_move_context(question):
    request = turn(question=question, previous_target="last_move")
    board, focus, target = select_position(request)
    assert board.fen() == request.fen and focus is None and target == "current"


def test_followup_retains_previous_question_target():
    request = turn(question="Why is that better?", previous_target="current")
    assert select_position(request)[2] == "current"
    request.question = "Why was my move bad?"
    assert select_position(request)[2] == "last_move"


@pytest.mark.parametrize("mutate", [
    {"last_move": "e2e5"}, {"last_move": "0000"}, {"fen": chess.STARTING_FEN},
    {"before_fen": None}, {"last_move": None}, {"fen": "8/8/8/8/8/8/8/8 w - - 0 1"},
])
def test_rejects_stale_or_illegal_transition(mutate):
    req = turn().model_copy(update=mutate)
    with pytest.raises(HTTPException) as error:
        select_position(req)
    assert error.value.status_code == 400


@pytest.mark.parametrize("fen,move", [
    ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1"),
    ("7k/P7/8/8/8/8/8/K7 w - - 0 1", "a7a8n"),
    ("7k/8/8/3pP3/8/8/8/K7 w - d6 0 1", "e5d6"),
])
def test_special_moves_keep_exact_state(fen, move):
    after = chess.Board(fen); after.push_uci(move)
    req = LiveTurnRequest(fen=after.fen(), before_fen=fen, last_move=move, question="Was that good?")
    assert select_position(req)[1] == move


@pytest.mark.parametrize("san,expected", [
    ("Nf6+", "knight to f 6, check"), ("Raxd7#", "rook from a takes on d 7, checkmate"),
    ("exd6", "pawn from e takes on d 6"), ("a8=N", "pawn to a 8, promoting to a knight"),
    ("O-O-O", "castle queenside"), ("O-O+", "castle kingside, check"),
])
def test_spoken_chess_notation(san, expected):
    assert say_move(san) == expected


def test_speech_keeps_evaluation_and_piece_square_context():
    spoken = speech_text("Nf6+ attacks king h7 and queen d7. The gap is 0.25 pawns.")
    assert "king h 7" in spoken and "queen d 7" in spoken and "0.25" in spoken
    assert "pawn to h 7" not in spoken


def evidence():
    def candidate(uci, san, cp):
        return {"id": "move:" + uci, "move_uci": uci, "move_san": san,
                "refined": True, "depth": 18, "score": {"mover_cp": cp, "mover_mate": None},
                "line": {"san": [san]}, "replies": []}
    return {"fen": chess.STARTING_FEN, "side_to_move": "white", "explanation": "factual evidence",
            "source": "stockfish", "status": "complete", "claims": [],
            "candidates": [candidate("d2d4", "d4", 50), candidate("e2e4", "e4", 20)]}


def test_free_endpoint_never_calls_model_and_returns_speech(monkeypatch):
    import backend.coach.agent as agent
    calls = []
    def investigate(*args, **kwargs):
        calls.append((args, kwargs)); return evidence()
    monkeypatch.setattr(live, "explain_position", investigate)
    monkeypatch.setattr(agent, "run_agent", lambda **kw: pytest.fail("The AI coach must be opt-in"))
    app = FastAPI(); app.include_router(router)
    response = TestClient(app).post("/api/coach/live-turn", json=turn(use_llm=False).model_dump())
    assert response.status_code == 200
    result = response.json()
    assert result["source"] == "template" and result["focus_move"] == "e2e4"
    assert "pawn to e 4" in result["speech"] and "0.30 pawns" in result["speech"]
    assert calls[0][0][0] == chess.STARTING_FEN


def test_ai_turn_runs_the_spoken_agent_on_the_last_move(monkeypatch):
    import backend.coach.agent as agent
    seen = {}
    def fake_agent(**kwargs):
        seen.update(kwargs)
        yield {"type": "intent", "intent": "position"}
        yield {"type": "token", "text": "**e4** grabs the centre "}
        yield {"type": "token", "text": "and frees the bishop."}
        yield {"type": "done", "notes": "[x] e4 best", "provider": "deepseek:deepseek-flash"}
    monkeypatch.setattr(agent, "run_agent", fake_agent)
    result = live.live_turn(turn(use_llm=True, profile={"rating_bucket": "800-1200"}))
    assert seen["spoken"] is True and seen["review"]["move"] == "e4" and seen["fen"] == chess.STARTING_FEN
    assert seen["profile"] == {"rating_bucket": "800-1200"} and seen["force_intent"] is None
    assert result["intent"] == "position" and result["events"] == []
    assert result["speech"].startswith("Your last move, pawn to e 4.") and "*" not in result["speech"]
    assert result["notes"] == "[x] e4 best" and result["source"] == "deepseek:deepseek-flash"


def test_unequal_depth_and_mate_never_subtracted_as_pawns():
    result = evidence()
    unequal = deepcopy(result); unequal["candidates"][1]["depth"] = 12
    assert "0.30 pawns" not in live.local_answer(unequal, "e2e4")
    result["candidates"][0]["score"] = {"mover_cp": None, "mover_mate": 3}
    answer = live.local_answer(result, "e2e4")
    assert "precise pawn-loss" in answer and "mating attack" in answer


def test_black_comparison_uses_mover_perspective():
    result = evidence(); result["side_to_move"] = "black"
    result["candidates"][0]["score"]["mover_cp"] = 400
    result["candidates"][1]["score"]["mover_cp"] = -200
    assert "6.00 pawns better for black" in live.local_answer(result, "e2e4")
