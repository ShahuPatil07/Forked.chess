"""Unit tests for the board-aware Coach agent (no network; Stockfish only where marked)."""
from __future__ import annotations

import json

import chess
import pytest

from backend.coach.agent import features as F
from backend.coach.agent import intent as I
from backend.coach.agent import llm, loop
from backend.coach.agent import tools as T
from backend.coach.agent.postprocess import AnswerFilter, clean, is_diagram_line
from backend.coach.agent.verify import check_answer

ITALIAN = "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQ1RK1 w - - 1 7"
SCHOLAR = "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4"
START = chess.STARTING_FEN


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


def test_motifs_name_a_winning_fork_only():
    board = chess.Board("4k3/8/8/1q3r2/8/8/2N5/4K3 w - - 0 1")
    ucis = ["c2d4", "e8d7", "d4b5", "f5f1", "e1f1"]
    fens = [board.fen()]
    b = board.copy()
    for u in ucis:
        b.push_uci(u); fens.append(b.fen())
    assert "fork" in T._motifs(board, ucis, fens)
    assert T._motifs(chess.Board(ITALIAN), ["h2h3", "a7a6"], [ITALIAN, ITALIAN, ITALIAN]) == []


# ── Intent router ───────────────────────────────────────────────────────────────

ENDGAME = "8/5pk1/6p1/8/3R4/6P1/5PK1/3r4 w - - 0 40"


@pytest.mark.parametrize("message,fen,prev,kind,sub", [
    ("Give me a fork puzzle", START, None, "create", "puzzle"),
    ("another one", ITALIAN, "create", "create", ""),
    ("Set up a rook pawn endgame for me", START, None, "create", "material"),
    ("Show me the Lucena position", ITALIAN, None, "create", "setup"),
    ("Let's play from here, I'm black", ITALIAN, None, "create", "play"),
    ("What's the best move here?", ITALIAN, None, "position", ""),
    ("Why not Nxe5?", ITALIAN, None, "position", ""),
    ("What is my opponent threatening?", ENDGAME, "general", "position", ""),
    ("Who is Vidit Gujrathi's wife?", ENDGAME, "position", "general", ""),
    ("Who was the first world champion?", ITALIAN, "position", "general", ""),
    ("How do I improve my calculation?", ITALIAN, None, "general", ""),
    ("What are the ideas of the London System?", START, None, "general", ""),
    ("why?", ITALIAN, "position", "position", ""),
    ("simpler please", ITALIAN, "general", "general", ""),
])
def test_rule_intents(message, fen, prev, kind, sub):
    got = I.rule_intent(message, chess.Board(fen), prev=prev)
    assert got is not None and got.kind == kind and (not sub or got.sub == sub)


def test_rules_never_misroute_the_labelled_set():
    """Rules may leave a message to the LLM router, but must never decide it wrongly."""
    from pathlib import Path
    data = json.loads((Path(__file__).parent / "fixtures" / "coach_intents.json").read_text(encoding="utf-8"))
    wrong = []
    for case in data["cases"]:
        got = I.rule_intent(case["msg"], chess.Board(data["boards"][case["board"]]), prev=case.get("prev"))
        if got is not None and got.kind != case["expect"]:
            wrong.append((case["msg"], got.kind, case["expect"]))
    assert wrong == []


def test_ambiguous_message_goes_to_llm_router(monkeypatch):
    assert I.rule_intent("Tell me something interesting about knights", chess.Board(ITALIAN)) is None
    monkeypatch.setattr(I, "llm_intent", lambda *a, **k: I.Intent("general", "", "llm"))
    got = I.classify("Tell me something interesting about knights", chess.Board(ITALIAN))
    assert got.kind == "general" and got.source == "llm"


# ── Post-processing ─────────────────────────────────────────────────────────────

def test_diagrams_are_removed_from_answers_even_when_streamed():
    text = "**Rd8#** wins.\n```\n. . . . . . k .\n8 | r . b q k b . r |\n+---+---+---+\na b c d e f g h\n```\nBlack is mated."
    assert clean(text).replace("\n\n", "\n") == "**Rd8#** wins.\nBlack is mated."
    for size in (1, 4, 9):
        f = AnswerFilter()
        out = "".join(f.feed(text[i:i + size]) for i in range(0, len(text), size)) + f.flush()
        assert "k ." not in out and "a b c" not in out and "Black is mated." in out
    assert not is_diagram_line("1. e4 e5 2. Nf3 Nc6")


def test_notation_words_mode():
    assert clean("Play **Nxe5+**, then 1. e4 e5 2. O-O. The e4 square.", words=True) == (
        "Play **knight takes on e5 with check**, then 1. pawn to e4 pawn to e5 2. castles kingside. The e4 square.")


# ── Agent loop (stubbed LLM + tools) ────────────────────────────────────────────

def _events(gen):
    return list(gen)


def _stub(monkeypatch, fn):
    """Patch the streaming LLM call: `fn(messages, tools, **kw)` returns an LLMReply (or raises)."""
    def fake_stream(messages, tools=None, *a, live=True, **kw):
        reply = fn(messages, tools, **kw)
        if live and reply.content and not reply.tool_calls:
            for i in range(0, len(reply.content), 5):
                yield "text", reply.content[i:i + 5]
        yield "reply", reply
    monkeypatch.setattr(llm, "stream", fake_stream)
    monkeypatch.setattr(loop, "llm_intent", lambda *a, **k: None)


def test_agent_tool_round_then_verifier_repair(monkeypatch):
    replies = iter([
        llm.LLMReply("", [{"id": "c1", "name": "position_features", "arguments": "{}"}], "stub"),
        llm.LLMReply("Play **Qh8** now.", [], "stub"),               # illegal: must be repaired
        llm.LLMReply("Play **h3**: it is a calm, useful move.", [], "stub"),
    ])
    seen = []

    def fake(messages, tools=None, **kw):
        seen.append(messages)
        return next(replies)
    _stub(monkeypatch, fake)
    monkeypatch.setattr(llm, "critic_enabled", lambda: False)
    monkeypatch.setitem(T.HANDLERS, "analyze_position", lambda s, **kw: (s.note("[x] stub analysis"), {"candidates": []})[1])
    events = _events(loop.run_agent(message="What should White do?", history=[], fen=ITALIAN, level="1200-1600"))
    kinds = [e["type"] for e in events]
    assert kinds[0] == "intent" and events[0]["intent"] == "position" and kinds[-1] == "done"
    assert any(e["type"] == "tool_done" and e["name"] == "position_features" for e in events)
    assert any(e["type"] == "tool" and e["name"] == "repair" for e in events)
    assert "".join(e["text"] for e in events if e["type"] == "token") == "Play **h3**: it is a calm, useful move."
    assert "[verifier" in seen[-1][-1]["content"]


def test_agent_falls_back_to_engine_summary_without_llm(monkeypatch):
    def unavailable(*a, **k):
        raise llm.LLMUnavailable("All providers are busy")
    _stub(monkeypatch, unavailable)
    fake = {"evaluation": "white is slightly better (+0.40)", "candidates": [
        {"move": "h3", "eval": "+0.40", "line": "7. h3 a6", "what_it_does": ["quiet move"]}]}
    monkeypatch.setitem(T.HANDLERS, "analyze_position", lambda s, **kw: fake)
    events = _events(loop.run_agent(message="Best move?", history=[], fen=ITALIAN))
    text = "".join(e["text"] for e in events if e["type"] == "token")
    assert "**h3**" in text and "AI explanation unavailable" in text
    assert events[-1]["provider"] == "fallback"


def test_followup_notes_go_to_system_prompt_not_transcript(monkeypatch):
    captured = {}

    def fake(messages, tools=None, **kw):
        captured["messages"] = messages
        return llm.LLMReply("Simpler: h3 stops a pin.", [], "stub")
    _stub(monkeypatch, fake)
    history = [{"role": "user", "content": "Best move?"},
               {"role": "assistant", "content": "h3 is best.", "notes": f"[{ITALIAN}] best h3 +0.30", "fen": ITALIAN,
                "intent": "position"}]
    _events(loop.run_agent(message="make it simpler", history=history, fen=ITALIAN))
    msgs = captured["messages"]
    assert "best h3 +0.30" in msgs[0]["content"]
    assert all("analysis notes" not in m["content"] for m in msgs[1:] if isinstance(m.get("content"), str))
    # Same board, follow-up wording: no fresh engine kickoff needed.
    assert not any(m.get("role") == "tool" for m in msgs)


def test_pasted_fen_becomes_the_board(monkeypatch):
    _stub(monkeypatch, lambda *a, **k: llm.LLMReply("Mate in one with Qxf7#.", [], "stub"))
    monkeypatch.setitem(T.HANDLERS, "analyze_position", lambda s, **kw: {"candidates": []})
    events = _events(loop.run_agent(message=f"What now? {SCHOLAR}", history=[], fen=None))
    board = next(e for e in events if e["type"] == "board")
    assert board["fen"] == SCHOLAR and events[-1]["fen"] == SCHOLAR


def test_general_question_never_sees_the_board_and_streams(monkeypatch):
    captured = {}

    def fake(messages, tools=None, **kw):
        captured["system"], captured["tools"] = messages[0]["content"], [t["function"]["name"] for t in tools or []]
        return llm.LLMReply("Vidit Gujrathi is an Indian grandmaster.", [], "stub")
    _stub(monkeypatch, fake)
    events = _events(loop.run_agent(message="Who is Vidit Gujrathi's wife?", history=[], fen=ENDGAME))
    assert events[0]["intent"] == "general"
    assert "CURRENT BOARD" not in captured["system"] and ENDGAME.split()[0] not in captured["system"]
    assert "analyze_position" not in captured["tools"]
    tokens = [e for e in events if e["type"] == "token"]
    assert len(tokens) > 1 and "".join(t["text"] for t in tokens) == "Vidit Gujrathi is an Indian grandmaster."
    assert events[-1]["intent"] == "general" and events[-1]["fen"] == ENDGAME   # the user's board is untouched


def test_create_confirmation_written_with_the_tool_call_needs_no_second_round(monkeypatch):
    calls = []

    def fake(messages, tools=None, **kw):
        calls.append(1)
        return llm.LLMReply("I've put the Lucena position on your board.",
                            [{"id": "c1", "name": "setup_position", "arguments": '{"name": "Lucena"}'}], "stub")
    _stub(monkeypatch, fake)
    monkeypatch.setattr(T, "tablebase", lambda s, fen=None: {"verdict_for_side_to_move": "win"})
    events = _events(loop.run_agent(message="Set up the Lucena position", history=[], fen=ITALIAN))
    pos = next(e for e in events if e["type"] == "position")
    assert pos["fen"].startswith("1K1k4/1P6") and pos["offer"] == ["play", "explain"]
    assert len(calls) == 1 and events[-1]["fen"] == pos["fen"]


def test_general_preamble_before_tool_call_is_retracted(monkeypatch):
    replies = iter([
        llm.LLMReply("Let me check that…", [{"id": "c1", "name": "opening_theory", "arguments": '{"query": "London"}'}], "stub"),
        llm.LLMReply("The London System aims for a solid setup with Bf4, e3 and c3.", [], "stub"),
    ])
    def fake(messages, tools=None, **kw):
        return next(replies)

    def fake_stream(messages, tools=None, *a, live=True, **kw):
        reply = fake(messages, tools)
        for i in range(0, len(reply.content), 6):
            yield "text", reply.content[i:i + 6]
        yield "reply", reply
    monkeypatch.setattr(llm, "stream", fake_stream)
    monkeypatch.setitem(T.HANDLERS, "opening_theory", lambda s, **kw: {"found": True, "knowledge": ["London: Bf4, e3, c3"]})
    events = _events(loop.run_agent(message="What are the ideas of the London System?", history=[], fen=START))
    kinds = [e["type"] for e in events]
    assert "retract" in kinds
    after = "".join(e["text"] for e in events[kinds.index("retract"):] if e["type"] == "token")
    assert after.startswith("The London System")


def test_general_answer_with_unchecked_moves_is_retracted_and_repaired(monkeypatch):
    replies = iter([
        llm.LLMReply("Zugzwang example: 1. Kd4 Kc6 2. Kd5 and the king on c6 must give way.", [], "stub"),
        llm.LLMReply("Zugzwang means every move makes your position worse, so you would rather pass.", [], "stub"),
    ])
    seen = []

    def fake(messages, tools=None, **kw):
        seen.append(messages)
        return next(replies)
    _stub(monkeypatch, fake)
    events = _events(loop.run_agent(message="What is zugzwang? Give me an example.", history=[], fen=START))
    kinds = [e["type"] for e in events]
    assert "retract" in kinds and any(e["type"] == "tool" and e["name"] == "repair" for e in events)
    final = "".join(e["text"] for e in events[kinds.index("retract"):] if e["type"] == "token")
    assert final.startswith("Zugzwang means") and "[verifier" in seen[-1][-1]["content"]


def test_opening_lines_from_move_one_count_as_checked(monkeypatch):
    _stub(monkeypatch, lambda *a, **k: llm.LLMReply("The Ruy Lopez: 1. e4 e5 2. Nf3 Nc6 3. Bb5, pressuring the c6 knight.", [], "stub"))
    events = _events(loop.run_agent(message="What are the ideas of the Ruy Lopez?", history=[], fen=START))
    assert "retract" not in [e["type"] for e in events]
    fens, sans = loop._anchored("1. e4 e5 2. Nf3 Nc6 3. Bb5 a6")
    assert {"Bb5", "a6"} <= sans and len(fens) == 7


def test_arrows_follow_the_moves_the_answer_names(monkeypatch):
    _stub(monkeypatch, lambda *a, **k: llm.LLMReply("**Rd8#** is mate at once.", [], "stub"))
    monkeypatch.setattr(llm, "critic_enabled", lambda: False)
    mate = "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1"

    def fake_analyze(s, **kw):
        s.note("[x] analysis")
        s.arrow(mate, "d1d8", "Rd8#", "best")
        s.arrow(mate, "g1f1", "Kf1", "alt")
        return {"candidates": [{"move": "Rd8#"}]}
    monkeypatch.setitem(T.HANDLERS, "analyze_position", fake_analyze)
    events = _events(loop.run_agent(message="What's the best move here?", history=[], fen=mate))
    arrows = next(e for e in events if e["type"] == "arrows")
    assert arrows["arrows"] == [{"from": "d1", "to": "d8", "kind": "best", "san": "Rd8"}]


# ── Create tools ────────────────────────────────────────────────────────────────

def test_get_puzzle_matches_all_themes_and_never_repeats():
    s = T.Session(fen=START)
    out = T.run_tool(s, "get_puzzle", {"themes": ["fork", "middlegame"], "rating": 1500})
    payload = s.events[0]["payload"]
    assert out["found"] and {"fork", "middlegame"} <= set(payload["themes"].split())
    assert chess.Board(payload["fen"]).is_valid() and payload["full_line_uci"]
    first = payload["puzzle_id"]
    T.run_tool(s, "get_puzzle", {"themes": "fork"})
    assert s.events[1]["payload"]["puzzle_id"] != first


def test_named_positions_and_material_editor(monkeypatch):
    monkeypatch.setattr(T, "tablebase", lambda s, fen=None: {"verdict_for_side_to_move": "draw"})
    s = T.Session(fen=ITALIAN)
    out = T.run_tool(s, "setup_position", {"name": "Philidor"})
    assert out["label"] == "Philidor position" and s.fen == out["fen"] and chess.Board(out["fen"]).is_valid()
    out = T.run_tool(s, "setup_position", {"moves": ["e4", "e5", "Nf3", "Nc6", "Bc4"]})
    assert s.events[-1]["line"]["san"] == ["e4", "e5", "Nf3", "Nc6", "Bc4"]
    assert "error" in T.run_tool(s, "setup_position", {"moves": ["e4", "Ke2"]})
    out = T.run_tool(s, "material_setup", {"white": {"R": 1, "P": 2}, "black": {"R": 1, "P": 2}})
    ev = s.events[-1]
    assert ev["type"] == "configurator" and ev["white"]["R"] == 1 and ev["black"]["P"] == 2 and out["balanced"]


def test_start_game_is_always_maia():
    s = T.Session(fen=ITALIAN, maia_elo=1900)
    T.run_tool(s, "start_game", {"user_color": "black", "from_current_board": True})
    ev = s.events[-1]
    assert ev["type"] == "play" and ev["engine"] == "maia" and ev["elo"] == 1900 and ev["fen"] == ITALIAN


@pytest.fixture
def stockfish():
    """The shared engine runs a non-daemon thread; quit it so the test process can exit."""
    yield
    import backend.main as M
    if M._sf_engine is not None:
        M._sf_engine.quit()
        M._sf_engine = None


def test_balanced_material_gives_an_equal_position(stockfish):
    from backend.coach.positions import generate_position
    out = generate_position({"R": 1, "P": 3}, {"R": 1, "P": 3}, "black")
    board = chess.Board(out["fen"])
    assert out["balanced"] and board.turn == chess.BLACK and board.is_valid()
    assert out["mate"] is None and abs(out["eval_cp"]) <= 80


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

    def fake_post(url, json=None, headers=None, timeout=None, stream=False):
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


def test_deepseek_cost_and_reasoning_replay():
    usage = {"prompt_tokens": 1000, "prompt_cache_hit_tokens": 600, "prompt_cache_miss_tokens": 400, "completion_tokens": 500}
    assert llm.cost_of("deepseek", usage) == pytest.approx((400 * 0.30 + 600 * 0.006 + 500 * 1.20) / 1e6)
    assert llm.cost_of("groq", usage) == 0
    msg = llm.LLMReply("", [{"id": "a", "name": "x", "arguments": "{}"}], "deepseek:deepseek-flash", "think").assistant_message()
    assert msg["reasoning_content"] == "think" and msg["tool_calls"][0]["function"]["name"] == "x"
    assert "reasoning_content" not in llm._messages_for("groq", [msg])[0]


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
