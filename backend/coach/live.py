"""Voice turns for a linked Analysis Board (Share Screen). No audio or screen recording is stored.

Turns run on the same Coach agent as text chat (agent/loop.py), forced to the
position intent and a spoken answer style. Which position is analysed (the
current one vs the one before the last move) is decided deterministically here,
never by the LLM."""
from __future__ import annotations

import re
from typing import Literal

import chess
from fastapi import HTTPException
from pydantic import BaseModel, Field

from backend.coach.explain import explain_position
from backend.coach.teaching import concise_explanation as local_answer


class VoiceMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=2500)
    notes: str | None = Field(default=None, max_length=4000)   # agent analysis notes (follow-ups stay grounded)
    fen: str | None = Field(default=None, max_length=200)


class LiveTurnRequest(BaseModel):
    fen: str = Field(max_length=200)
    before_fen: str | None = Field(default=None, max_length=200)
    last_move: str | None = Field(default=None, max_length=5)
    question: str = Field(min_length=1, max_length=2000)
    previous_target: Literal["current", "last_move"] | None = None
    history: list[VoiceMessage] = Field(default_factory=list, max_length=6)
    budget_seconds: float = Field(default=8, ge=0.25, le=15, allow_inf_nan=False)
    use_llm: bool = True
    profile: dict | None = None   # the Coach questionnaire (language/depth), if the user filled it in
    board_info: dict | None = None    # {"kind": "puzzle", "solved": false} when a puzzle tab is active
    seen_puzzles: list[str] = Field(default_factory=list, max_length=200)
    maia_elo: int | None = Field(default=None, ge=1100, le=1900)


def validated_board(fen: str) -> chess.Board:
    try:
        board = chess.Board(fen)
        if len(fen.split()) != 6 or not board.is_valid():
            raise ValueError()
        return board
    except ValueError as exc:
        raise HTTPException(400, "The linked board supplied an invalid position.") from exc


def select_position(req: LiveTurnRequest) -> tuple[chess.Board, str | None, str]:
    current = validated_board(req.fen)
    before = None
    if bool(req.before_fen) != bool(req.last_move):
        raise HTTPException(400, "The previous position and move must be supplied together.")
    if req.before_fen and req.last_move:
        before = validated_board(req.before_fen)
        try:
            move = chess.Move.from_uci(req.last_move)
            if move not in before.legal_moves or before.is_game_over():
                raise ValueError()
            replay = before.copy()
            replay.push(move)
            if replay.fen() != current.fen():
                raise ValueError()
        except ValueError as exc:
            raise HTTPException(400, "The last move does not lead to the linked position. Reconnect the board.") from exc
    question = req.question.lower()
    # Explicit temporal language wins over follow-up context. No LLM guesses the root.
    current_question = re.search(
        r"\b(now|next|current position|whose turn|who is better|what should (?:i|we|white|black) (?:play|do)|best move here|(?:can|could|should) i play|what if i play)\b", question)
    last_question = re.search(r"\b(last move|just played|that move|this move|my move|was .+ move|(?:was|is) (?:that|this|it) (?:a )?(?:good|bad|mistake|blunder))\b", question)
    target = "current" if current_question else "last_move" if last_question else req.previous_target
    if before is not None and target != "current":
        return before, req.last_move, "last_move"
    return current, None, "current"


PIECES = {"K": "king", "Q": "queen", "R": "rook", "B": "bishop", "N": "knight"}
SAN = re.compile(r"(?<![\w])(?:O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)[+#]?(?![\w])")


def say_move(san: str) -> str:
    suffix = ", checkmate" if san.endswith("#") else ", check" if san.endswith("+") else ""
    move = san.rstrip("+#")
    if move.startswith("O-O"):
        return ("castle queenside" if move == "O-O-O" else "castle kingside") + suffix
    promotion = ""
    if "=" in move:
        move, piece = move.split("=")
        promotion = ", promoting to a " + PIECES[piece]
    piece = PIECES.get(move[0], "pawn")
    prefix = move[1:-2] if move[0] in PIECES else move[:-2]
    disambiguation = prefix.replace("x", "")
    origin = f" from {disambiguation}" if disambiguation else ""
    action = " takes on " if "x" in prefix else " to "
    square = move[-2] + " " + move[-1]
    return piece + origin + action + square + promotion + suffix


def speech_text(text: str) -> str:
    def expand(match):
        # In a board fact such as "king h7", h7 is a square, not a pawn move.
        if re.fullmatch(r"[a-h][1-8]", match.group()) and re.search(
                r"\b(?:king|queen|rook|bishop|knight|pawn)(?: on)?\s+$", text[:match.start()], re.I):
            return match.group()[0] + " " + match.group()[1]
        return say_move(match.group())
    text = SAN.sub(expand, text)
    text = text.replace("1/2-1/2", "a draw").replace("1-0", "White wins").replace("0-1", "Black wins")
    text = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", text)
    return re.sub(r"\s+", " ", re.sub(r"[*_`#>]", "", text)).strip()


def normalize_question(question: str) -> str:
    """Only normalize explicit piece + square phrases; do not guess homophones."""
    for letter, name in PIECES.items():
        question = re.sub(rf"\b{name}\s+(?:to\s+)?([a-h])\s*([1-8])\b",
                          lambda m: letter + m[1].lower() + m[2], question, flags=re.I)
    question = re.sub(r"\bpawn\s+(?:to\s+)?([a-h])\s*([1-8])\b", r"\1\2", question, flags=re.I)
    return question



def live_turn(req: LiveTurnRequest) -> dict:
    board, focus, target = select_position(req)
    question = normalize_question(req.question)
    if not req.use_llm:
        return _local_turn(req, board, focus, target, question)
    import backend.coach.agent as agent
    from backend.coach.agent.intent import rule_intent
    # "Give me a puzzle" / "set up a rook endgame" / a general question beats the last-move context.
    pre = rule_intent(question, validated_board(req.fen), pasted=False)
    if pre is not None and pre.kind != "position" and focus:
        board, focus, target = validated_board(req.fen), None, "current"
    review = None
    if focus:
        move = chess.Move.from_uci(focus)
        review = {"move": board.san(move), "color": "white" if board.turn else "black",
                  "move_number": board.fullmove_number}
    parts, notes, provider, intent, events = [], "", "", "position", []
    for event in agent.run_agent(message=question, history=[m.model_dump() for m in req.history], fen=board.fen(),
                                 review=review, spoken=True, force_intent=None, profile=req.profile,
                                 board_info=req.board_info, seen_puzzles=req.seen_puzzles, maia_elo=req.maia_elo):
        kind = event["type"]
        if kind == "token":
            parts.append(event["text"])
        elif kind == "retract":
            parts = []
        elif kind == "intent":
            intent = event["intent"]
        elif kind == "done":
            notes, provider = event.get("notes") or "", event.get("provider") or ""
        elif kind in BOARD_EVENTS:
            events.append(event)   # puzzles, positions, the editor, play mode, arrows → the call's board
    answer = "".join(parts).strip()
    anchor = (f"Your last move, {say_move(review['move'])}. " if review else "")
    return {"speech": speech_text(anchor + answer), "target": target, "analyzed_fen": board.fen(),
            "focus_move": focus, "source": provider or "agent", "status": "complete", "intent": intent,
            "events": events, "notes": notes, "evidence": {"notes": notes}}


BOARD_EVENTS = {"puzzle", "position", "configurator", "play", "board", "arrows"}


def _local_turn(req: LiveTurnRequest, board: chess.Board, focus: str | None, target: str, question: str) -> dict:
    """Engine-only voice answer (no LLM), kept for the 'AI wording off' setting."""
    result = explain_position(board.fen(), question, focus, budget_seconds=req.budget_seconds)
    if result.get("source") == "error":
        raise HTTPException(400, result["explanation"])
    answer = local_answer(result, focus or result.get("focus_move"))
    anchor = (f"Reviewing the last move played, by {'White' if board.turn else 'Black'}. "
              if focus else f"Looking at the current position, with {result.get('side_to_move', 'the next side')} to move. ")
    return {"speech": speech_text(anchor + answer), "target": target,
            "analyzed_fen": board.fen(), "focus_move": focus, "source": "template",
            "status": result.get("status"), "evidence": result}
