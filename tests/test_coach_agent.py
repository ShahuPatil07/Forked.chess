"""Unit tests for the board-aware Coach agent (no network; Stockfish only where marked)."""
from __future__ import annotations

import json

import chess
import pytest

from backend.coach.agent import features as F
from backend.coach.agent import llm, loop
from backend.coach.agent import tools as T
from backend.coach.agent.verify import check_answer

ITALIAN = "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQ1RK1 w - - 1 7"
SCHOLAR = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4"


# ── Verifier ────────────────────────────────────────────────────────────────────

def test_verifier_flags_unreachable_moves_wrong_pieces_files_and_pins():
    issues = check_answer("**Re1** uses the open e-file; the knight on f6 is pinned. Then Qh8 and the "
                          "bishop on g5 decides.", {ITALIAN}, set())
    text = " ".join(issues)
    assert "Qh8" in text and "bishop on g5" in text and "open e-file" in text and "knight on f6" in text


def test_verifier_accepts_true_facts_plans_and_lines():
    answer = ("The pawn on f2 is pinned. Aim to get a knight on d5 later. After 7. Re1 a5 8. h3 "
              "White keeps a small edge.")
    assert check_answer(answer, {ITALIAN}, {"Re1", "a5", "h3"}) == []


def test_verifier_flags_generic_open_file_when_all_files_closed():
    assert any("open/half-open file" in i for i in check_answer("The rook goes to an open file.", {ITALIAN}, set()))


# ── Board facts ─────────────────────────────────────────────────────────────────

def test_loose_pieces_find_the_hanging_queen():
    board = chess.Board(SCHOLAR)
    loose = F.loose_pieces(board, chess.WHITE)
    assert loose[0]["piece"] == "queen on h5" and loose[0]["wins"] == 9


def test_move_effects_closed_file_rook_and_mate():
    board = chess.Board(ITALIAN)
    effects = " ".join(F.move_effects(board, board.parse_san("Re1")))
    assert "closed" in effects and "open file" in effects and "takes the" not in effects
    assert F.move_effects(chess.Board(SCHOLAR), chess.Board(SCHOLAR).parse_san("Qxf7#")) == ["Qxf7# is checkmate"]


def test_move_effects_detects_fork():
    board = chess.Board("4k3/8/8/1q3r2/8/8/2N5/4K3 w - - 0 1")
    effects = " ".join(F.move_effects(board, board.parse_san("Nd4")))
    assert "two targets" in effects and "queen on b5" in effects and "rook on f5" in effects


def test_positional_report_pawn_weaknesses():
    board = chess.Board("4k3/p4ppp/8/3p4/8/8/PP3PPP/4K3 w - - 0 1")
    ps = F.pawn_structure(board, chess.BLACK)
    assert ps["isolated"] == ["a7", "d5"] and "d5" in ps["passed"]


# ── Agent loop (stubbed LLM + tools) ────────────────────────────────────────────

def _events(gen):
    return list(gen)


def test_agent_tool_round_then_verifier_repair(monkeypatch):
    replies = iter([
        llm.LLMReply("", [{"id": "c1", "name": "position_features", "arguments": "{}"}], "stub"),
        llm.LLMReply("Play **Qh8** now.", [], "stub"),               # illegal: must be repaired
        llm.LLMReply("Play **h3**: it is a calm, useful move.", [], "stub"),
    ])
    seen = []

    def fake_complete(messages, tools=None, **kw):
        seen.append(messages)
        return next(replies)
    monkeypatch.setattr(llm, "complete", fake_complete)
    monkeypatch.setattr(llm, "critic_enabled", lambda: False)
    monkeypatch.setitem(T.HANDLERS, "analyze_position", lambda s, **kw: (s.note("[x] stub analysis"), {"candidates": []})[1])
    events = _events(loop.run_agent(message="What should White do?", history=[], fen=ITALIAN, level="1200-1600"))
    kinds = [e["type"] for e in events]
    assert kinds[0] == "meta" and kinds[-1] == "done"
    assert any(e["type"] == "tool_done" and e["name"] == "position_features" for e in events)
    assert any(e["type"] == "tool" and e["name"] == "verify" for e in events)
    assert "".join(e["text"] for e in events if e["type"] == "token") == "Play **h3**: it is a calm, useful move."
    assert "[verifier" in seen[-1][-1]["content"]


def test_agent_falls_back_to_engine_summary_without_llm(monkeypatch):
    def unavailable(*a, **k):
        raise llm.LLMUnavailable("All free LLM providers are busy")
    monkeypatch.setattr(llm, "complete", unavailable)
    fake = {"evaluation": "white is slightly better (+0.40)", "candidates": [
        {"move": "h3", "eval": "+0.40", "line": "7. h3 a6", "what_it_does": ["quiet move"]}]}
    monkeypatch.setitem(T.HANDLERS, "analyze_position", lambda s, **kw: fake)
    events = _events(loop.run_agent(message="Best move?", history=[], fen=ITALIAN))
    text = "".join(e["text"] for e in events if e["type"] == "token")
    assert "**h3**" in text and "AI explanation unavailable" in text
    assert events[-1]["provider"] == "fallback"


def test_followup_notes_go_to_system_prompt_not_transcript(monkeypatch):
    captured = {}

    def fake_complete(messages, tools=None, **kw):
        captured["messages"] = messages
        return llm.LLMReply("Simpler: h3 stops a pin.", [], "stub")
    monkeypatch.setattr(llm, "complete", fake_complete)
    history = [{"role": "user", "content": "Best move?"},
               {"role": "assistant", "content": "h3 is best.", "notes": f"[{ITALIAN}] best h3 +0.30", "fen": ITALIAN}]
    _events(loop.run_agent(message="make it simpler", history=history, fen=ITALIAN))
    msgs = captured["messages"]
    assert "best h3 +0.30" in msgs[0]["content"]
    assert all("analysis notes" not in m["content"] for m in msgs[1:] if isinstance(m.get("content"), str))
    # Same board, follow-up wording: no fresh engine kickoff needed.
    assert not any(m.get("role") == "tool" for m in msgs)


def test_pasted_fen_becomes_the_board(monkeypatch):
    monkeypatch.setattr(llm, "complete", lambda *a, **k: llm.LLMReply("Mate in one with Qxf7#.", [], "stub"))
    monkeypatch.setitem(T.HANDLERS, "analyze_position", lambda s, **kw: {"candidates": []})
    events = _events(loop.run_agent(message=f"What now? {SCHOLAR}", history=[], fen=None))
    board = next(e for e in events if e["type"] == "board")
    assert board["fen"] == SCHOLAR and events[-1]["fen"] == SCHOLAR


# ── Provider chain ──────────────────────────────────────────────────────────────

class _Resp:
    def __init__(self, status, body, headers=None):
        self.status_code, self._body, self.headers = status, body, headers or {}
        self.text = json.dumps(body)

    def json(self):
        return self._body


def test_llm_fails_over_on_rate_limit(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "k")
    monkeypatch.setenv("COACH_LLM_CHAIN", "groq:model-a,groq:model-b")
    llm._cooldown.clear()
    calls = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(json["model"])
        if json["model"] == "model-a":
            return _Resp(429, {"error": {"message": "rate"}}, {"x-ratelimit-reset-tokens": "40s"})
        return _Resp(200, {"choices": [{"message": {"content": "<think>x</think>Hello"}}], "usage": {}})
    monkeypatch.setattr(llm.requests, "post", fake_post)
    reply = llm.complete([{"role": "user", "content": "hi"}])
    assert reply.content == "Hello" and reply.provider == "groq:model-b" and calls == ["model-a", "model-b"]
    # model-a is now cooling down and skipped.
    calls.clear()
    llm.complete([{"role": "user", "content": "hi"}])
    assert calls == ["model-b"]
    llm._cooldown.clear()


def test_tool_dispatch_never_raises():
    s = T.Session(fen=ITALIAN)
    assert "error" in T.run_tool(s, "explore_line", {"moves": ["Qh8"]})
    assert "error" in T.run_tool(s, "nope", {})
    assert "error" in T.run_tool(s, "evaluate_moves", "not json")


def test_explore_line_shows_board(monkeypatch):
    monkeypatch.setattr(T.E, "evaluate", lambda fen, **kw: {"eval": T.E.Eval(20, None), "best": None, "terminal": None})
    s = T.Session(fen=ITALIAN)
    out = T.run_tool(s, "explore_line", {"moves": "7. h3 a6"})
    assert out["line"] == "7. h3 a6" and s.events[0]["type"] == "board" and s.events[0]["line"]["san"] == ["h3", "a6"]
