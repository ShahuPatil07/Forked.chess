"""Voice turns for a linked Analysis Board. No audio or screen recording is stored."""
from __future__ import annotations

import re
from typing import Literal

import chess
from fastapi import HTTPException
from pydantic import BaseModel, Field

from backend.coach.explain import explain_position, narrate_evidence


class VoiceMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=2500)


class LiveTurnRequest(BaseModel):
    fen: str = Field(max_length=200)
    before_fen: str | None = Field(default=None, max_length=200)
    last_move: str | None = Field(default=None, max_length=5)
    question: str = Field(min_length=1, max_length=2000)
    previous_target: Literal["current", "last_move"] | None = None
    history: list[VoiceMessage] = Field(default_factory=list, max_length=6)
    budget_seconds: float = Field(default=5, ge=0.25, le=10, allow_inf_nan=False)
    # Never call a metered provider implicitly. Local speech/evidence is the default.
    use_llm: bool = False


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


def local_answer(result: dict, focus: str | None) -> str:
    """Short spoken evidence summary with mover-relative, depth-qualified comparison."""
    candidates = result.get("candidates", [])
    if not candidates:
        return result["explanation"]
    best = candidates[0]
    played = next((c for c in candidates if c["move_uci"] == focus), None)
    relevant = played or best
    parts = []
    if focus and not played:
        parts.append("I haven't completed a search of your move, so I cannot judge it yet.")
    if played:
        if played.get("immediate_mate"):
            return (f"{played['move_san'].rstrip('+#')} is checkmate. "
                    "The opposing king is in check and has no legal move to escape it. Well spotted.")
        elif played == best:
            parts.append(f"{played['move_san']} is the strongest move I found in this search.")
        else:
            top_cp, played_cp = best["score"]["mover_cp"], played["score"]["mover_cp"]
            comparable = best["refined"] and played["refined"] and best["depth"] == played["depth"]
            if top_cp is not None and played_cp is not None and comparable:
                gap = max(0, top_cp - played_cp) / 100
                verdict = "very close to my top choice" if gap < .3 else "a small concession" if gap < 1 else "a significant concession"
                parts.append(f"{played['move_san']} is {verdict}. {best['move_san']} scores about {gap:.2f} pawns better for {result['side_to_move']} in this search. That's evaluation, not material lost.")
            else:
                parts.append(f"I would investigate {best['move_san']} instead of {played['move_san']}. These searches don't support a precise pawn-loss comparison.")
            mate = played["score"]["mover_mate"]
            best_mate = best["score"]["mover_mate"]
            if mate is not None:
                parts.append(f"The engine reports {'a mating attack' if mate > 0 else 'an opponent mating attack'} in this line.")
            elif best_mate is not None and best_mate > 0:
                parts.append("The alternative has a mating attack according to the engine search.")
    else:
        parts.append(f"For {result['side_to_move']}, the strongest move I found is {best['move_san']}.")
    claims = [c for c in result.get("claims", []) if c["candidate_id"] == relevant["id"]
              and c["status"] in ("verified", "likely") and "search scores" not in c["hypothesis"].lower()]
    # Exact terminal consequences matter more than generic 'wins material'.
    claims.sort(key=lambda c: ("ends the game" not in c["hypothesis"], c["status"] != "verified"))
    for claim in claims[:2]:
        parts.append(("In the sampled lines, " if claim["status"] == "likely" else "") + claim["hypothesis"])
    if not claims:
        parts.append("I don't have a verified positional reason yet; the score alone doesn't explain why.")
    replies = relevant.get("replies", [])
    if replies:
        parts.append("One defense I checked is " + replies[0]["move_san"] + ".")
    if played and played != best:
        parts.append("The alternative line begins " + ", ".join(best["line"]["san"][:3]) + ".")
    if result.get("status") == "partial" or result.get("warnings"):
        parts.append("This was a short search; the ranking and unproven ideas may change with deeper analysis.")
    return " ".join(parts)


def live_turn(req: LiveTurnRequest) -> dict:
    board, focus, target = select_position(req)
    question = normalize_question(req.question)
    result = explain_position(board.fen(), question, focus, budget_seconds=req.budget_seconds)
    if result.get("source") == "error":
        raise HTTPException(400, result["explanation"])
    effective_focus = focus or result.get("focus_move")
    answer, source = local_answer(result, effective_focus), "template"
    if req.use_llm:
        # Explicit opt-in uses only the existing Groq integration, never C1.
        answer, source = narrate_evidence(result, [m.model_dump() for m in req.history],
                                         force_groq=True, spoken=True)
        if source == "template":
            answer = "I'll use the local engine explanation for this answer. " + local_answer(result, effective_focus)
    anchor = (f"Reviewing the last move played, by {'White' if board.turn else 'Black'}. "
              if focus else f"Looking at the current position, with {result.get('side_to_move', 'the next side')} to move. ")
    return {"speech": speech_text(anchor + answer), "target": target,
            "analyzed_fen": board.fen(), "focus_move": focus, "source": source,
            "status": result.get("status"), "evidence": result}
