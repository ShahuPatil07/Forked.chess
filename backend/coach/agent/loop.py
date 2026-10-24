"""The Coach agent: route → investigate → verify → explain.

  0. Route: the intent router decides position / create / general. When it needs
     the LLM, Stockfish warms the cache for the board in parallel, so a position
     question pays no extra latency.
  1. Context: system prompt = persona + task rules for the intent + AUDIENCE (the
     7-question profile) + the board (position/create only — a general question
     never sees the board, so the answer can't drift onto it) + analysis notes of
     earlier turns.
  2. Kickoff evidence (position): the obvious first tool calls run deterministically.
  3. Agentic rounds: the LLM calls tools until it can answer. Tool side effects
     (board updates, puzzles, editor, play mode, lines) stream to the UI.
  4. Answer:
       position → drafted, checked (illegal moves, wrong piece placements, false
                  file/pin claims, then a claim-by-claim fact check), repaired once,
                  then shown with arrows for the key moves;
       create / general → streamed token by token as it is written.
     Every answer passes the post-processor (no ASCII boards; moves in words if asked).
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Iterator

import chess
import chess.pgn

from backend.coach.agent import llm
from backend.coach.agent import engine as E
from backend.coach.agent.intent import Intent, classify, llm_intent, rule_intent, board_description
from backend.coach.agent.postprocess import AnswerFilter, clean
from backend.coach.agent.prompt import normalize_profile, puzzle_rating, system_prompt
from backend.coach.agent.tools import LABELS, Session, run_tool, select_tools, _load_game_pgn, _parse_move
from backend.coach.agent.verify import check_answer

log = logging.getLogger(__name__)
MAX_ROUNDS = {"position": 6, "create": 3, "general": 4}
# DeepSeek reasoning effort for position answers (low = faster; high = more careful first drafts).
ANSWER_EFFORT = os.getenv("COACH_ANSWER_EFFORT", "low")
# Answers are ≤ ~250 words, but DeepSeek's reasoning counts against the cap too (up to ~1,500 tokens seen);
# 3,000 leaves room for both while still stopping a rare repetition loop.
ANSWER_TOKENS = 3000
MAX_HISTORY = 8
_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="coach")
FEN_RE = re.compile(r"([prnbqkPRNBQK1-8]+(?:/[prnbqkPRNBQK1-8]+){7}\s+[wb]\s+(?:-|[KQkq]+)\s+(?:-|[a-h][36])(?:\s+\d+\s+\d+)?)")
PGN_RE = re.compile(r"(\[Event |(?:^|\s)1\.\s*(?:[a-h][34]|N[a-h]3)\s)")
MOVE_WORD_RE = re.compile(r"(?<![\w/])(O-O-O|O-O|0-0-0|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?)[+#!?]*(?![\w])")
NOTES_LEAK_RE = re.compile(r"\[(?:my )?analysis notes[^\]]*\]?", re.I | re.S)


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


def _compact(result: dict, limit: int = 3600) -> str:
    text = json.dumps(result, separators=(",", ":"), ensure_ascii=False)
    return text if len(text) <= limit else text[:limit] + '..."(truncated)"'


def _history(items: list[dict], with_notes: bool = True) -> tuple[list[dict], str]:
    """Recent turns + the analysis notes of the last two answers (kept out of the
    visible transcript so the model never imitates them in its own answer)."""
    items = [m for m in items if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()][-MAX_HISTORY:]
    out = [{"role": m["role"], "content": m["content"].strip()[: 1800 if m["role"] == "assistant" else 3000]}
           for m in items]
    notes = [m["notes"][:2500] for m in items if m["role"] == "assistant" and m.get("notes")][-2:] if with_notes else []
    return out, "\n".join(f"- {n}" for n in notes)


CREATE_HINTS = {
    "puzzle": "a puzzle — use get_puzzle.",
    "material": "they described MATERIAL (e.g. 'a rook endgame'), not a specific famous position — open the "
                "editor with material_setup. Use setup_position only if they named a famous position.",
    "setup": "they named a position, an opening or gave a FEN — use setup_position.",
    "play": "they want to play — use start_game (from the current board if they said 'here'/'this position').",
}


def _misdescribes_material(text: str, session: Session) -> bool:
    """The confirmation is written alongside material_setup, before its result: catch "one pawn each side"
    when the counts it actually passed are unbalanced."""
    ev = next((e for e in reversed(session.events_log) if e.get("type") == "configurator"), None)
    if not ev or ev["white"] == ev["black"]:
        return False
    return bool(re.search(r"\beach( side)?\b|\bper side\b|\bboth sides\b|\bapiece\b|\bsymmetric", text, re.I))


def _anchored(text: str) -> tuple[set[str], set[str]]:
    """Lines written from move 1 ("1. e4 e5 2. Nf3 …") that replay legally from the start count as
    checked: they need no tool call. Returns the positions and moves they reach."""
    fens, sans = {chess.STARTING_FEN}, set()
    for m in re.finditer(r"(?<![\w.])1\.\s*[^\n]*", text):
        b = chess.Board()
        for token in MOVE_WORD_RE.findall(m.group(0)):
            try:
                mv = _parse_move(b, token)
            except ValueError:
                break
            sans.add(b.san(mv).rstrip("+#")); b.push(mv); fens.add(b.fen())
    return fens, sans


def _general_issues(text: str, fens: set[str], sans: set[str]) -> list[str]:
    """General answers: check concrete examples only — moves inside numbered lines ("1. Kd4 Kc6"), piece
    placements and pins. Loose mentions ("a setup with Bf4, e3 and c3") and concepts ("rooks belong on open
    files") are fine without a board."""
    issues = [i for i in check_answer(text, fens, sans)
              if not i.startswith(("These moves", "File claims", "You mention an open"))]
    numbered = " ".join(m.group(0) for m in re.finditer(r"(?<![\w.])\d+\.(?:\.\.)?\s*[^\n;:]*", text))
    if numbered:
        issues = [i for i in check_answer(numbered, fens, sans) if i.startswith("These moves")] + issues
    return issues


GENERAL_REPAIR = ("\nIf an example needs moves or a position, put it on the board first — show_line (moves from the "
                  "start) or setup_position (a named position or FEN) — and use only those verified moves; otherwise "
                  "explain it in words without concrete moves or piece squares. Give the corrected final answer only "
                  "(same style, don't mention the verifier).")


def _quiet_best(board: chess.Board, analysis: dict) -> bool:
    """Best move is neither a capture nor a check (its point is usually prophylactic/positional)."""
    try:
        move = board.parse_san(analysis["candidates"][0]["move"])
    except Exception:
        return False
    return not board.is_capture(move) and not board.gives_check(move) and not move.promotion


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


CRITIC_PROMPT = """You are a precise chess fact-checker. You get the BOARD (FEN + piece list), EVIDENCE (Stockfish
and exact board analysis) and a DRAFT answer. Find the claims in the DRAFT that are WRONG:
- contradicted by the EVIDENCE: a wrong evaluation or verdict, wrong side better, wrong best move, a line or
  reply that differs from the analysed one, wrong material (count it from the piece list if needed);
- impossible on the BOARD: a piece on the wrong square, an attack/defence/pin/check that the geometry does
  not allow, an "open file" with pawns on it;
- invented: a tactic (fork, pin, skewer, mate…) or threat that no evidence shows.
Do NOT list claims that are merely not mentioned in the evidence but plausible — plans, general principles,
standard concepts you can confirm on the board (e.g. kings in opposition), or style. Only list a claim if you
are sure it is wrong, and say why in a few words.
Reply with JSON only: {"wrong": ["<claim> — <why>"]} — an empty list if nothing is wrong."""


def _critic(messages: list[dict], draft: str) -> list[str]:
    evidence = "\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "tool")[-9000:]
    board = messages[0]["content"].split("CURRENT BOARD", 1)[-1][:700]
    try:
        reply = llm.complete([{"role": "system", "content": CRITIC_PROMPT},
                              {"role": "user", "content": f"BOARD:{board}\n\nEVIDENCE:\n{evidence}\n\nDRAFT:\n{draft}"}],
                             max_tokens=900, temperature=0, thinking=False, json_mode=True)
        data = json.loads(re.search(r"\{.*\}", reply.content, re.S).group(0))
        found = data.get("wrong", data.get("problems", []))
        # The checker occasionally lists a claim and then concludes it is fine; that must not cost a repair.
        not_wrong = re.compile(r"\bno error\b|\bis fine\b|\bis correct\b|\bnot wrong\b|\bthis is accurate\b", re.I)
        return [f"Fact-check: {p}" for p in found[:4] if isinstance(p, str) and p.strip() and not not_wrong.search(p)]
    except Exception as exc:   # the critic is best-effort; never block an answer on it
        log.info("coach critic skipped: %s", exc)
        return []


def _summary(session: Session, before: int) -> str:
    new = session.notes[before:]
    if not new:
        return ""
    return re.sub(r"^\[[^\]]*\]\s*", "", new[-1])[:160]


def _arrows(session: Session, text: str) -> list[dict]:
    """Arrows for the moves the answer actually talks about, on the board now shown."""
    here = " ".join(session.fen.split()[:4])
    picked, seen = [], set()
    bold = set(re.findall(r"\*\*([^*]+)\*\*", text))
    candidates = [a for a in session.arrows if " ".join(a["fen"].split()[:4]) == here]
    candidates.sort(key=lambda a: (not any(a["san"] in b for b in bold), a["kind"] != "best"))
    for a in candidates:
        if a["uci"] in seen or not re.search(rf"(?<![\w]){re.escape(a['san'])}(?![\w])", text):
            continue
        seen.add(a["uci"])
        picked.append({"from": a["uci"][:2], "to": a["uci"][2:4], "kind": a["kind"], "san": a["san"]})
        if len(picked) == 3:
            break
    return picked


def _route(message: str, board: chess.Board, *, has_moves: bool, has_game: bool, review: dict | None,
           prev: str | None, pasted: bool, history: list[dict], board_info: dict | None,
           force: str | None) -> Intent:
    if force:
        return classify(message, board, force=force)
    intent = rule_intent(message, board, has_moves=has_moves, has_game=has_game, review=review, prev=prev, pasted=pasted)
    if intent:
        return intent
    # Ambiguous: ask the router while Stockfish pre-computes the board (cached for the kickoff).
    if not board.is_game_over():
        _POOL.submit(E.top_lines, board.fen(), 3)
    future = _POOL.submit(llm_intent, message, board_description(board, has_moves, has_game, board_info), prev, history)
    try:
        intent = future.result(timeout=12)
    except Exception:
        intent = None
    return intent or Intent("position", "", "default", "router unavailable")


def run_agent(*, message: str, history: list[dict], fen: str | None, moves_context: list[str] | None = None,
              game_pgn: str | None = None, level: str = "", style: str = "balanced",
              review: dict | None = None, profile: dict | None = None, spoken: bool = False,
              board_info: dict | None = None, seen_puzzles: list[str] | None = None,
              maia_elo: int | None = None, force_intent: str | None = None, username: str = "") -> Iterator[dict]:
    profile = normalize_profile(profile, level, style)
    session = Session(fen=chess.STARTING_FEN, game_pgn=game_pgn or None, level=profile.get("rating_bucket", ""),
                      puzzle_rating=puzzle_rating(profile), seen_puzzles=set(seen_puzzles or []),
                      maia_elo=max(600, min(2800, int(maia_elo or 1900))), username=username or "")
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
    pasted = False
    pasted_fen = FEN_RE.search(message)
    if pasted_fen and not review:
        text = pasted_fen.group(1).strip()
        if len(text.split()) == 4:
            text += " 0 1"
        try:
            b = chess.Board(text)
            if b.is_valid():
                session.fen = b.fen(); session.fens.add(b.fen()); board = b; moves_context = []; pasted = True
                yield {"type": "board", "fen": b.fen(), "line": {"san": [], "uci": [], "fens": [b.fen()]}, "label": "Pasted position"}
        except ValueError:
            pass
    elif PGN_RE.search(message) and not review:
        start = PGN_RE.search(message).start()
        game = _load_game_pgn(session, message[start:].strip(), "Pasted game")
        if game is not None:
            session.fen = game.end().board().fen(); board = chess.Board(session.fen); pasted = True
            yield from session.events; session.events.clear()

    user_text = message.strip() or "Explain this move."
    prev_intent = next((m.get("intent") for m in reversed(history) if m.get("role") == "assistant" and m.get("intent")), None)
    intent = _route(user_text, board, has_moves=bool(moves_context), has_game=bool(session.game_pgn), review=review,
                    prev=prev_intent, pasted=pasted, history=history, board_info=board_info, force=force_intent)
    kind = intent.kind
    yield intent.as_event()
    yield {"type": "meta", "mode": "agent", "intent": kind}

    user_board_fen = session.fen
    if kind == "general":
        session.fen = chess.STARTING_FEN   # tools default to the start, never to the user's board
        session.fens = {chess.STARTING_FEN}
    past, notes = _history(history, with_notes=kind != "general")
    system = system_prompt(kind, profile, user_board_fen, " ".join(moves_context or [])[-400:],
                           bool(session.game_pgn), review, spoken, board_info)
    if notes:
        system += ("\n\nANALYSIS NOTES FROM EARLIER TURNS (verified tool facts; the [FEN] says which "
                   "position each is about; never quote this block verbatim):\n" + notes)
    if kind == "create" and intent.sub in CREATE_HINTS:
        system += "\n\nREQUEST TYPE (from the router): " + CREATE_HINTS[intent.sub]
    messages = [{"role": "system", "content": system}] + past
    messages.append({"role": "user", "content": user_text})

    # ── Kickoff evidence (position questions) ─────────────────────────────────
    kickoff: list[tuple[str, dict]] = []
    plan: list[tuple[str, dict]] = []
    if kind == "position":
        if review and review.get("move"):
            moves = [review["move"]] + ([review["best"]] if review.get("best") and review["best"] != review["move"] else [])
            plan.append(("evaluate_moves", {"moves": moves}))
        elif not board.is_game_over():
            mentioned = _mentioned_moves(board, user_text)
            last_fen = next((m.get("fen") for m in reversed(history) if m.get("role") == "assistant"), None)
            is_start = board.board_fen() == chess.Board().board_fen()
            threat_q = re.search(r"threat|danger|attack(ing)? me|what does (he|she|they|black|white) want|defend", user_text, re.I)
            if mentioned:
                plan.append(("evaluate_moves", {"moves": [board.san(m) for m in mentioned]}))
            elif (not is_start and not session.game_pgn
                  and (last_fen != session.fen or _wants_fresh_analysis(user_text))):
                # Also for threat questions: "what does White threaten?" needs "and how do I meet it?".
                plan.append(("analyze_position", {}))
            if threat_q:
                plan.append(("opponent_threats", {}))
            if len(board.piece_map()) <= 7 and (board_info or {}).get("kind") != "puzzle":
                plan.append(("tablebase", {}))
    if plan:
        calls = []
        for name, args in plan:
            cid = f"kick_{uuid.uuid4().hex[:8]}"
            yield {"type": "tool", "name": name, "label": LABELS[name], "status": "running"}
            before = len(session.notes)
            result = run_tool(session, name, args)
            kickoff.append((name, result))
            calls.append((cid, name, args, result))
            yield {"type": "tool_done", "name": name, "label": LABELS[name], "summary": result.get("error") or _summary(session, before)}
            # A quiet best move needs its purpose checked, not guessed: what does the opponent want?
            if (name == "analyze_position" and not any(n == "opponent_threats" for n, _ in plan)
                    and _quiet_best(board, result)):
                plan.append(("opponent_threats", {}))
        messages.append({"role": "assistant", "content": "", "tool_calls": [
            {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
            for cid, name, args, _ in calls]})
        for cid, name, _, result in calls:
            messages.append({"role": "tool", "tool_call_id": cid, "name": name, "content": _compact(result)})

    # ── Agentic rounds ────────────────────────────────────────────────────────
    words = profile.get("notation") == "words"
    # "Set up X" alone ends with a streamed confirmation; "set up X and explain…" is a position answer
    # about the new board, so it is checked before it is shown, like any position answer.
    asks_more = kind == "create" and bool(re.search(
        r"\?|\b(explain|why|how|what|teach|walk me|tell me|show me how|analy[sz]e|evaluate|plan|idea)", user_text, re.I))
    checked = kind == "position" or asks_more
    live = not checked and not spoken
    final, raw_final, repaired, provider = "", "", False, ""
    tools = select_tools(user_text, session, kind)
    max_rounds = MAX_ROUNDS[kind] + (2 if asks_more else 0)
    for round_no in range(max_rounds):
        last = round_no == max_rounds - 1
        filt = AnswerFilter(words)
        shown: list[str] = []
        reply = None
        try:
            # The last round keeps the tool schemas (so the model doesn't write tool syntax as text) but forbids calls.
            for part, value in llm.stream(messages, tools, max_tokens=ANSWER_TOKENS, temperature=0.2,
                                          effort=ANSWER_EFFORT if kind == "position" else "low", live=live,
                                          tool_choice="none" if last else "auto"):
                if part == "text":
                    out = filt.feed(value)
                    if out:
                        shown.append(out)
                        yield {"type": "token", "text": out}
                else:
                    reply = value
        except llm.LLMUnavailable as exc:
            if shown:
                yield {"type": "retract"}
            final = _fallback(session, kickoff, str(exc)[:140])
            provider = "fallback"
            break
        provider = reply.provider
        if reply.tool_calls and not last:
            keep_text = kind == "create" and bool(reply.content.strip()) and not asks_more
            messages.append(reply.assistant_message())
            errors = False
            for call in reply.tool_calls[:4]:
                yield {"type": "tool", "name": call["name"], "label": LABELS.get(call["name"], call["name"]), "status": "running"}
                before = len(session.notes)
                result = run_tool(session, call["name"], call["arguments"])
                errors = errors or bool(result.get("error")) or result.get("found") is False
                for ev in session.events:
                    yield ev
                session.events.clear()
                yield {"type": "tool_done", "name": call["name"], "label": LABELS.get(call["name"], call["name"]),
                       "summary": result.get("error") or result.get("message") or _summary(session, before)}
                messages.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"], "content": _compact(result)})
            for call in reply.tool_calls[4:]:
                messages.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"],
                                 "content": '{"error":"too many parallel calls; call again if needed"}'})
            if keep_text and _misdescribes_material(reply.content, session):
                keep_text = False   # its sentence contradicts the counts it set: rewrite after seeing the result
            if keep_text and session.created and not errors:
                # The short confirmation was written alongside the create tool call: done.
                tail = filt.flush()
                if tail:
                    yield {"type": "token", "text": tail}
                final, raw_final = clean(reply.content, words), reply.content
                break
            if shown:
                yield {"type": "retract"}   # a preamble before tool calls; the real answer follows
            continue
        if live:
            tail = filt.flush()
            if tail:
                yield {"type": "token", "text": tail}
            if kind == "general" and not repaired and not last:
                # Streamed already; if it states moves/placements no tool checked, retract and redo once (checked).
                af, asans = _anchored(reply.content)
                issues = _general_issues(reply.content, session.fens | af, session.sans | asans)
                if issues:
                    repaired, live = True, False
                    yield {"type": "retract"}
                    yield {"type": "tool", "name": "repair", "label": "Checking the example", "status": "running"}
                    messages.append({"role": "assistant", "content": reply.content,
                                     **({"reasoning_content": reply.reasoning} if reply.reasoning else {})})
                    messages.append({"role": "user", "content": "[verifier — not from the user] Your answer states moves "
                                     "or piece placements that no tool checked:\n- " + "\n- ".join(issues) + GENERAL_REPAIR})
                    yield {"type": "tool_done", "name": "repair", "label": "Checking the example",
                           "summary": "re-checking the moves in the example"}
                    continue
            final, raw_final = clean(reply.content, words), reply.content
            break
        # Position answers (and explanations of a position just set up) are checked before anyone sees them.
        draft = NOTES_LEAK_RE.sub("", reply.content).strip()
        if kind == "general":
            af, asans = _anchored(draft)
            issues = _general_issues(draft, session.fens | af, session.sans | asans)
        else:
            issues = check_answer(draft, session.fens, session.sans) if (session.notes or kickoff) else []
        if reply.finish == "length":
            issues = ["The draft was cut off because it ran far too long (it may repeat itself). Rewrite it "
                      "concisely within the length the AUDIENCE block asks for."] + issues
            draft = draft[:1500]
        if not issues and not repaired and not last and session.notes and llm.critic_enabled() and not spoken:
            yield {"type": "tool", "name": "verify", "label": "Fact-checking the answer", "status": "running"}
            issues = _critic(messages, draft)
            yield {"type": "tool_done", "name": "verify", "label": "Fact-checking the answer",
                   "summary": "every claim matches the analysis" if not issues else f"{len(issues)} claim(s) to fix"}
        if issues and not repaired and not last:
            repaired = True
            log.info("Coach draft failed grounding checks: %s", issues)
            yield {"type": "tool", "name": "repair", "label": "Correcting the answer", "status": "running"}
            messages.append({"role": "assistant", "content": draft,
                             **({"reasoning_content": reply.reasoning} if reply.reasoning else {})})
            messages.append({"role": "user", "content": "[verifier — not from the user] Your draft has problems:\n- "
                             + "\n- ".join(issues) + "\nFix or drop only those claims (verify with a tool if needed). Keep "
                             "everything the evidence supports and still teach the concrete idea — what the move does "
                             "(what_it_does, motifs, threats, structure) — rather than retreating into vague advice. Give "
                             "the corrected final answer only (same style, don't mention the verifier)."})
            yield {"type": "tool_done", "name": "repair", "label": "Correcting the answer",
                   "summary": "fixed " + "; ".join(i.split(":")[0] for i in issues)[:120]}
            continue
        final, raw_final = clean(draft, words), draft
        for i in range(0, len(final), 40):
            yield {"type": "token", "text": final[i:i + 40]}
        break
    if not final:
        final = _fallback(session, kickoff, "no answer produced")
        yield {"type": "token", "text": final}
    elif provider == "fallback":
        yield {"type": "token", "text": final}

    if kind != "general" and raw_final:
        arrows = _arrows(session, raw_final)
        if arrows:
            yield {"type": "arrows", "fen": session.fen, "arrows": arrows}
    if session.lines:
        yield {"type": "lines", "lines": session.lines[-12:]}
    notes = " | ".join(session.notes)[-2500:]
    yield {"type": "done", "notes": notes, "fen": session.fen if kind != "general" else user_board_fen,
           "provider": provider, "intent": kind}
