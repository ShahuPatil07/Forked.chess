"""The investigate → verify → explain loop behind the Coach chat.

  1. Context: system prompt (rules + audience + the user's CURRENT BOARD) and the
     conversation, where earlier assistant turns carry compact analysis notes so
     follow-ups stay grounded without re-running everything.
  2. Kickoff evidence: obvious first steps (analyse a new board, evaluate moves the
     user names, evaluate the move under review) run deterministically and are
     injected as tool results — saving an LLM round trip on free-tier budgets.
  3. Agentic rounds: the LLM calls tools (engine, board facts, databases) until it
     can answer. Tool side effects (board updates, puzzles, lines) stream to the UI.
  4. Verification: the draft is checked for illegal/unreached moves and wrong piece
     placements; one repair round fixes them before anything is shown.
"""
from __future__ import annotations

import io
import json
import logging
import re
import uuid
from typing import Iterator

import chess
import chess.pgn

from backend.coach.agent import llm
from backend.coach.agent.prompt import system_prompt
from backend.coach.agent.tools import LABELS, Session, run_tool, select_tools, _load_game_pgn, _parse_move
from backend.coach.agent.verify import check_answer

log = logging.getLogger(__name__)
MAX_ROUNDS = 6
MAX_HISTORY = 8
FEN_RE = re.compile(r"([prnbqkPRNBQK1-8]+(?:/[prnbqkPRNBQK1-8]+){7}\s+[wb]\s+(?:-|[KQkq]+)\s+(?:-|[a-h][36])(?:\s+\d+\s+\d+)?)")
PGN_RE = re.compile(r"(\[Event |(?:^|\s)1\.\s*(?:[a-h][34]|N[a-h]3)\s)")
MOVE_WORD_RE = re.compile(r"(?<![\w/])(O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?)[+#!?]*(?![\w])")


def _mentioned_moves(board: chess.Board, text: str) -> list[chess.Move]:
    found = []
    for token in MOVE_WORD_RE.findall(text):
        try:
            mv = _parse_move(board, token)
        except ValueError:
            continue
        if mv not in found:
            found.append(mv)
    return found[:3]


def _compact(result: dict, limit: int = 2600) -> str:
    text = json.dumps(result, separators=(",", ":"), ensure_ascii=False)
    return text if len(text) <= limit else text[:limit] + '..."(truncated)"'


def _history(items: list[dict]) -> tuple[list[dict], str]:
    """Recent turns + the analysis notes of the last two answers (kept out of the
    visible transcript so the model never imitates them in its own answer)."""
    items = [m for m in items if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()][-MAX_HISTORY:]
    out = [{"role": m["role"], "content": m["content"].strip()[: 1500 if m["role"] == "assistant" else 3000]}
           for m in items]
    notes = [m["notes"][:900] for m in items if m["role"] == "assistant" and m.get("notes")][-2:]
    return out, "\n".join(f"- {n}" for n in notes)


NOTES_LEAK_RE = re.compile(r"\[(?:my )?analysis notes[^\]]*\]?", re.I | re.S)


def _wants_fresh_analysis(message: str) -> bool:
    return bool(re.search(r"best move|candidate|what should|plan|evaluat|who is better|deeper|analy[sz]e|position|threat|why", message, re.I))


def _fallback(session: Session, kickoff: list[tuple[str, dict]], reason: str) -> str:
    """Deterministic answer when no LLM is reachable: still grounded, still short."""
    for name, res in kickoff:
        if name == "evaluate_moves" and res.get("moves"):
            parts = []
            for m in res["moves"]:
                if m.get("error"):
                    parts.append(m["error"] + ".")
                    continue
                s = f"**{m['move']}**: {m['verdict']} ({m['eval_after']})."
                if m.get("what_it_does"):
                    s += " It " + "; ".join(m["what_it_does"][:2]) + "."
                if m.get("opponent_best_reply"):
                    s += f" Best reply: {m['opponent_best_reply']} ({m.get('line', '')})."
                parts.append(s)
            return " ".join(parts) + f"\n\n_(Engine summary — AI explanation unavailable: {reason})_"
        if name == "analyze_position" and res.get("candidates"):
            c = res["candidates"][0]
            s = f"{res['evaluation'].capitalize()}. The best move is **{c['move']}**"
            if c.get("what_it_does"):
                s += " — it " + "; ".join(c["what_it_does"][:2])
            s += f". Main line: {c['line']}."
            if len(res["candidates"]) > 1:
                s += " Alternatives: " + ", ".join(f"{x['move']} ({x['eval']})" for x in res["candidates"][1:]) + "."
            return s + f"\n\n_(Engine summary — AI explanation unavailable: {reason})_"
    return f"The AI coach is unavailable right now ({reason}). The board and engine tools still work — try again in a minute."


CRITIC_PROMPT = """You are a strict chess fact-checker. You get EVIDENCE (tool results from Stockfish and exact
board analysis) and a DRAFT answer. List every concrete statement in the DRAFT about THIS position that the
EVIDENCE does not support or contradicts: moves or lines, evaluations, who is better, threats, piece locations,
open/closed files, pins, what a move prevents or allows, material won. Ignore general chess principles that
make no factual claim about the position. Reply with JSON only: {"problems": ["..."]} — an empty list if none."""


def _critic(messages: list[dict], draft: str) -> list[str]:
    evidence = "\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "tool")[-7000:]
    board = messages[0]["content"].split("CURRENT BOARD", 1)[-1][:700]
    try:
        reply = llm.complete([{"role": "system", "content": CRITIC_PROMPT},
                              {"role": "user", "content": f"BOARD:{board}\n\nEVIDENCE:\n{evidence}\n\nDRAFT:\n{draft}"}],
                             max_tokens=700, temperature=0)
        data = json.loads(re.search(r"\{.*\}", reply.content, re.S).group(0))
        return [f"Fact-check: {p}" for p in data.get("problems", [])[:4] if isinstance(p, str) and p.strip()]
    except Exception as exc:   # the critic is best-effort; never block an answer on it
        log.info("coach critic skipped: %s", exc)
        return []


def _summary(session: Session, before: int) -> str:
    new = session.notes[before:]
    if not new:
        return ""
    return re.sub(r"^\[[^\]]*\]\s*", "", new[-1])[:160]


def run_agent(*, message: str, history: list[dict], fen: str | None, moves_context: list[str] | None = None,
              game_pgn: str | None = None, level: str = "", style: str = "balanced",
              review: dict | None = None) -> Iterator[dict]:
    session = Session(fen=chess.STARTING_FEN, game_pgn=game_pgn or None, level=level)
    try:
        board = chess.Board(fen) if fen else chess.Board()
        if not board.is_valid():
            raise ValueError
        session.fen = board.fen()
    except ValueError:
        board = chess.Board()
    session.fens.add(session.fen)
    if moves_context:
        session.sans.update(m.rstrip("+#") for m in moves_context)

    # A FEN or PGN pasted into the message becomes the board.
    pasted_fen = FEN_RE.search(message)
    if pasted_fen and not review:
        text = pasted_fen.group(1).strip()
        if len(text.split()) == 4:
            text += " 0 1"
        try:
            b = chess.Board(text)
            if b.is_valid():
                session.fen = b.fen(); session.fens.add(b.fen()); board = b; moves_context = []
                yield {"type": "board", "fen": b.fen(), "line": {"san": [], "uci": [], "fens": [b.fen()]}, "label": "Pasted position"}
        except ValueError:
            pass
    elif PGN_RE.search(message) and not review:
        start = PGN_RE.search(message).start()
        game = _load_game_pgn(session, message[start:].strip(), "Pasted game")
        if game is not None:
            session.fen = game.end().board().fen(); board = chess.Board(session.fen)
            yield from session.events; session.events.clear()

    yield {"type": "meta", "mode": "agent"}
    past, notes = _history(history)
    system = system_prompt(level, style, session.fen, " ".join(moves_context or [])[-400:],
                           bool(session.game_pgn), review)
    if notes:
        system += ("\n\nANALYSIS NOTES FROM EARLIER TURNS (verified tool facts; the [FEN] says which "
                   "position each is about; never quote this block verbatim):\n" + notes)
    messages = [{"role": "system", "content": system}] + past
    user_text = message.strip() or "Explain this move."
    messages.append({"role": "user", "content": user_text})

    # ── Kickoff evidence (deterministic first steps) ──────────────────────────
    kickoff: list[tuple[str, dict]] = []
    plan: list[tuple[str, dict]] = []
    if review and review.get("move"):
        moves = [review["move"]] + ([review["best"]] if review.get("best") and review["best"] != review["move"] else [])
        plan.append(("evaluate_moves", {"moves": moves}))
    elif not board.is_game_over() and not re.search(r"puzzle|exercise|let'?s play|play (me|you|against)", user_text, re.I):
        mentioned = _mentioned_moves(board, user_text)
        last_fen = next((m.get("fen") for m in reversed(history) if m.get("role") == "assistant"), None)
        is_start = board.board_fen() == chess.Board().board_fen()
        threat_q = re.search(r"threat|danger|attack(ing)? me|what does (he|she|they|black|white) want|defend", user_text, re.I)
        if mentioned:
            plan.append(("evaluate_moves", {"moves": [board.san(m) for m in mentioned]}))
        elif (not is_start and not threat_q and not session.game_pgn
              and (last_fen != session.fen or _wants_fresh_analysis(user_text))):
            plan.append(("analyze_position", {}))
        if threat_q:
            plan.append(("opponent_threats", {}))
    if plan:
        calls = []
        for name, args in plan:
            cid = f"kick_{uuid.uuid4().hex[:8]}"
            yield {"type": "tool", "name": name, "label": LABELS[name], "status": "running"}
            before = len(session.notes)
            result = run_tool(session, name, args)
            kickoff.append((name, result))
            calls.append((cid, name, args, result))
            yield {"type": "tool_done", "name": name, "label": LABELS[name], "summary": _summary(session, before)}
        messages.append({"role": "assistant", "content": None, "tool_calls": [
            {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
            for cid, name, args, _ in calls]})
        for cid, name, _, result in calls:
            messages.append({"role": "tool", "tool_call_id": cid, "name": name, "content": _compact(result)})

    # ── Agentic rounds ────────────────────────────────────────────────────────
    final, repaired, provider = "", False, ""
    tools = select_tools(user_text, session)
    for round_no in range(MAX_ROUNDS):
        last = round_no == MAX_ROUNDS - 1
        try:
            reply = llm.complete(messages, None if last else tools,
                                 max_tokens=1800, temperature=0.2)
        except llm.LLMUnavailable as exc:
            final = _fallback(session, kickoff, "free LLM quota busy" if "busy" in str(exc) else str(exc)[:120])
            provider = "fallback"
            break
        provider = reply.provider
        if reply.tool_calls and not last:
            messages.append({"role": "assistant", "content": reply.content or None, "tool_calls": [
                {"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}}
                for c in reply.tool_calls]})
            for call in reply.tool_calls[:4]:
                yield {"type": "tool", "name": call["name"], "label": LABELS.get(call["name"], call["name"]), "status": "running"}
                before = len(session.notes)
                result = run_tool(session, call["name"], call["arguments"])
                for ev in session.events:
                    yield ev
                session.events.clear()
                yield {"type": "tool_done", "name": call["name"], "label": LABELS.get(call["name"], call["name"]),
                       "summary": result.get("error") or _summary(session, before)}
                messages.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"], "content": _compact(result)})
            for call in reply.tool_calls[4:]:
                messages.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"],
                                 "content": '{"error":"too many parallel calls; call again if needed"}'})
            continue
        draft = NOTES_LEAK_RE.sub("", reply.content).strip()
        issues = check_answer(draft, session.fens, session.sans) if (session.notes or kickoff) else []
        if not issues and not repaired and not last and session.notes and llm.critic_enabled():
            issues = _critic(messages, draft)
        if issues and not repaired and not last:
            repaired = True
            log.info("Coach draft failed grounding checks: %s", issues)
            yield {"type": "tool", "name": "verify", "label": "Double-checking the moves", "status": "running"}
            messages.append({"role": "assistant", "content": draft})
            messages.append({"role": "user", "content": "[verifier — not from the user] Your draft has problems:\n- "
                             + "\n- ".join(issues) + "\nVerify with tools if needed, then give the corrected final answer "
                             "only (same style, don't mention the verifier)."})
            yield {"type": "tool_done", "name": "verify", "label": "Double-checking the moves",
                   "summary": "fixed " + "; ".join(i.split(":")[0] for i in issues)[:120]}
            continue
        final = draft
        break
    if not final:
        final = _fallback(session, kickoff, "no answer produced")

    if session.lines:
        yield {"type": "lines", "lines": session.lines[-12:]}
    for i in range(0, len(final), 48):
        yield {"type": "token", "text": final[i:i + 48]}
    notes = " | ".join(session.notes)[-900:]
    yield {"type": "done", "notes": notes, "fen": session.fen, "provider": provider}
