"""Request router: what is the user asking for?

  position — a question about the board on screen (best move, why, threats, plans,
             a move they name, the loaded game).
  create   — put something on the board: a puzzle, a named/theory position, a
             material setup ("rook endgame to practise"), or start playing (Maia).
  general  — anything else: history, players, rules, concepts, openings in general,
             training advice, small talk. The board is NOT sent for these, so the
             answer cannot drift onto it.

Clear cases are decided by rules (free, instant). Ambiguous ones go to a fast JSON
call (DeepSeek, thinking off). Short follow-ups ("why?", "simpler") inherit the
previous turn's intent, but any message can switch topic — nothing assumes that a
follow-up relates to the current subtask.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

import chess

log = logging.getLogger(__name__)

KINDS = ("position", "create", "general")


@dataclass
class Intent:
    kind: str                 # position | create | general
    sub: str = ""             # create: puzzle | setup | material | play
    source: str = "rule"      # rule | llm | inherit | default | forced
    reason: str = ""

    def as_event(self) -> dict:
        return {"type": "intent", "intent": self.kind, "sub": self.sub, "source": self.source}


# ── Patterns ───────────────────────────────────────────────────────────────────

PUZZLE_RE = re.compile(
    r"\bpuzzles?\b|\b(quiz|test) me\b|\btactics? (exercise|drill|to solve|training)\b"
    r"|\b(give|show|send) me (a|an|one|some|another) (exercise|problem|tactic|combination)\b", re.I)
PLAY_RE = re.compile(
    r"\blet'?s play\b|\blets play\b|\bplay along\b|\bplay (a game|a match)\b"
    r"|\bplay (against|vs\.?|versus|with) (you|maia|me|the (bot|engine|coach|computer))\b"
    r"|\b(can|could|shall) we play\b|\bplay (this|it|that) (out|position)\b|\bplay (it )?out\b"
    r"|\bplay from (here|this position|this)\b|\bpractice (this|it) (against|vs)\b", re.I)
SETUP_VERB = (r"(set ?up|setup|create|make|generate|build|arrange|load|put|give me|show me|get me|i want|"
              r"i'd like|i would like|can i (get|have)|practi[cs]e)")
SETUP_RE = re.compile(
    rf"\b{SETUP_VERB}\b.{{0,60}}\b(position|endgame|ending|middlegame|structure|scenario|setup|"
    r"lucena|philidor|vancura|saavedra|reti|r[ée]ti|opposition|triangulation)s?\b", re.I)
NAMED_RE = re.compile(r"\b(lucena|philidor|vancura|saavedra|r[ée]ti (study|position|manoeuvre|maneuver))\b", re.I)
# "practise queen vs rook", "load the Najdorf after 6.Bg5", "put the Italian on the board"
PRACTICE_MATERIAL_RE = re.compile(
    r"\b(practi[cs]e|play|train)\b.{0,30}\b(queen|rook|bishop|knight|pawn)s?\b.{0,12}\b(vs\.?|versus|against|ending|endgame)\b", re.I)
LOAD_OPENING_RE = re.compile(
    r"\b(set ?up|load|put)\b.{0,40}\b(after\s+\d|opening|defen[cs]e|gambit|variation|najdorf|dragon|sicilian|"
    r"french|caro|italian|spanish|ruy|london|king'?s indian|queen'?s gambit|english|scotch|petrov|pirc)\b", re.I)
MATERIAL_RE = re.compile(
    r"\b(rook|queen|bishop|knight|pawn|minor[- ]piece|opposite[- ]colou?red bishops?)s?\b.{0,30}\b(endgame|ending|vs\.?|versus|against)\b"
    r"|\b(k|q|r|b|n|p)\s*\+\s*(k|q|r|b|n|p)\b|\b(endgame|ending) with\b", re.I)

POSITION_RE = re.compile(
    r"\b(this|the current|current|my|our|that) (position|move|board|game|line|structure|pawn structure)\b"
    r"|\bhere\b|\bon the board\b|\bbest move\b|\bwhat (should|do|can|would) (i|we|white|black|you) (play|do)\b"
    r"|\bwho('?s| is) (better|winning|worse)\b|\bthreat|\bevaluat|\bcandidate moves?\b|\bwhat now\b"
    r"|\bwhy (did|is|was|not|does|doesn'?t|isn'?t|wasn'?t)\b.{0,40}\b(move|play|good|bad|best|work|lose|win)"
    r"|\bturning point\b|\bwhere did (i|we|white|black) go wrong\b|\b(my|the) (mistake|blunder)s?\b"
    r"|\bhow (do|should|can) (i|we|white|black) (continue|proceed|win this|save this|defend|attack)\b"
    r"|\bis (it|this) (winning|lost|drawn|a draw|equal)\b|\bnext move\b|\bhint\b", re.I)
GENERAL_RE = re.compile(
    r"^\s*(thanks|thank you|thx|ty|cool|great|nice|got it|ok thanks)\b[\s!.]*\w{0,12}[\s!.]*$"
    r"|\b(en passant|castling|touch[- ]move|50[- ]move) rule\b|\bwho won\b"
    r"|\bwho (is|was|were|are)\b|\bwhen (did|was|were)\b|\bhistory\b|\bworld champions?\b|\bwife\b|\bhusband\b"
    r"|\bborn\b|\bbiography\b|\btournament\b|\bfide\b|\brules? (of|for)\b|\bhow (do|can|should) i (improve|study|"
    r"get better|train|learn|prepare|stop)\b|\brecommend (a|some) (book|course|channel)s?\b|\bbooks?\b"
    r"|\bwhat (is|are|does) (a|an|the)? ?(fork|pin|skewer|zugzwang|opposition|outpost|fianchetto|gambit|en passant|"
    r"castling|stalemate|elo|rating|tempo|prophylaxis|isolated pawn|passed pawn|blitz|bullet|rapid)\b"
    r"|\b(ideas?|plans?|theory) (of|behind|in) the\b.{0,40}\b(opening|defen[cs]e|gambit|attack|variation|system)\b"
    r"|\b(opening|defen[cs]e|gambit|variation|system) (for|against) (white|black|1\.?\s?[ed]4)\b", re.I)
FOLLOWUP_RE = re.compile(
    r"^\s*(why|how( so)?|and( then)?|then what|what next|so|really|ok(ay)?|explain( (it|that|more))?|"
    r"simpler|simplify|in simpler words|more|go deeper|deeper|elaborate|continue|go on|what else|and after that|"
    r"what about (it|that|this)|can you explain|i don'?t (understand|get it)|show me|give me (a|an) (example|hint)|"
    r"another( one)?|next( one)?|again|why not|tell me more|more please|(make|say|explain) (it|that) (simpler|shorter|easier|clearer))"
    r"\b[\s\w'?,.!]{0,40}$", re.I)


def _board_is_live(board: chess.Board, has_moves: bool, has_game: bool) -> bool:
    """Is there a meaningful position on screen (not just the untouched start)?"""
    return has_game or has_moves or board.board_fen() != chess.Board().board_fen()


def _mentions_move(board: chess.Board, text: str) -> bool:
    from backend.coach.agent.loop import MOVE_WORD_RE
    from backend.coach.agent.tools import _parse_move
    for token in MOVE_WORD_RE.findall(text):
        # Bare squares ("e4") are often square names in prose; count piece moves/captures.
        if not re.match(r"^(O-O|[KQRBN]|[a-h]x)", token):
            continue
        try:
            _parse_move(board, token)
            return True
        except ValueError:
            continue
    return False


def rule_intent(message: str, board: chess.Board, *, has_moves: bool = False, has_game: bool = False,
                review: dict | None = None, prev: str | None = None, pasted: bool = False) -> Intent | None:
    text = message.strip()
    live = _board_is_live(board, has_moves, has_game)
    if review:
        return Intent("position", "review", "rule", "game review move")
    if PUZZLE_RE.search(text):
        return Intent("create", "puzzle", "rule", "puzzle request")
    if PLAY_RE.search(text):
        return Intent("create", "play", "rule", "play request")
    if NAMED_RE.search(text) and re.search(SETUP_VERB + r"|\bshow\b|\bposition\b", text, re.I):
        return Intent("create", "setup", "rule", "named position")
    if SETUP_RE.search(text) or PRACTICE_MATERIAL_RE.search(text):
        return Intent("create", "material" if MATERIAL_RE.search(text) else "setup", "rule", "setup request")
    if LOAD_OPENING_RE.search(text):
        return Intent("create", "setup", "rule", "opening position")
    if prev == "create" and re.search(r"^\s*(give me |another |one more )?(a |an )?(harder|easier|different|new|tougher|simpler) one\b", text, re.I):
        return Intent("create", "", "inherit", "another of the same")
    if pasted:
        return Intent("position", "", "rule", "pasted FEN/PGN")
    if text and FOLLOWUP_RE.match(text) and prev in KINDS and len(text.split()) <= 8:
        # "another one" after a puzzle → another puzzle; "why?" after an answer → same topic.
        return Intent(prev, "", "inherit", "short follow-up")
    if live and (POSITION_RE.search(text) or _mentions_move(board, text)):
        return Intent("position", "", "rule", "refers to the board")
    if GENERAL_RE.search(text) and not POSITION_RE.search(text):
        return Intent("general", "", "rule", "general knowledge")
    if not live:
        # Untouched start position, nothing loaded: there's no position to talk about.
        return Intent("general", "", "rule", "no position on screen")
    return None


ROUTER_PROMPT = """You route messages in a chess coaching app. The user has a chess board on screen.
Decide what the CURRENT message asks for:
- "position": a question about the position currently on the board (or the game loaded on it): best move,
  why a move is good/bad, threats, plans for this position, evaluating moves, what to do here.
- "create": the user wants something PUT ON the board or to start playing: a puzzle, a named/theory position
  (Lucena, an opening position...), a position with certain material (e.g. "rook endgame"), or to play a game.
- "general": anything else — chess history, players' lives, rules, concepts in general, an opening's ideas in
  general, training advice, non-chess chat. Questions that do not need the current board are "general",
  even if the previous turns were about the board. Topics can switch at any moment.
For "create" also give "sub": "puzzle" | "setup" (named position / FEN / opening moves) | "material" | "play".
Reply with JSON only: {"intent": "position|create|general", "sub": "", "reason": "<5 words>"}"""


def llm_intent(message: str, board_desc: str, prev: str | None, last_turns: list[dict]) -> Intent | None:
    from backend.coach.agent import llm
    ctx = "\n".join(f"{m['role']}: {str(m.get('content') or '')[:220]}" for m in last_turns[-2:])
    user = (f"BOARD ON SCREEN: {board_desc}\nPREVIOUS INTENT: {prev or 'none'}\n"
            f"RECENT TURNS:\n{ctx or '(none)'}\n\nCURRENT MESSAGE: {message.strip()[:800]}")
    try:
        reply = llm.complete([{"role": "system", "content": ROUTER_PROMPT}, {"role": "user", "content": user}],
                             max_tokens=80, temperature=0, thinking=False, json_mode=True)
        data = json.loads(re.search(r"\{.*\}", reply.content, re.S).group(0))
    except Exception as exc:
        log.info("intent router LLM failed: %s", exc)
        return None
    kind = str(data.get("intent", "")).lower()
    if kind not in KINDS:
        return None
    sub = str(data.get("sub") or "").lower() if kind == "create" else ""
    return Intent(kind, sub if sub in ("puzzle", "setup", "material", "play") else "", "llm",
                  str(data.get("reason") or "")[:60])


def board_description(board: chess.Board, has_moves: bool, has_game: bool, board_info: dict | None = None) -> str:
    if board_info and board_info.get("kind") == "puzzle":
        return "a tactics puzzle the user is solving"
    if has_game:
        return "a loaded game"
    if not _board_is_live(board, has_moves, has_game):
        return "the untouched starting position (nothing set up)"
    phase = "endgame" if len(board.piece_map()) <= 12 else "middlegame/opening"
    return f"a {phase} position, {'White' if board.turn else 'Black'} to move"


def classify(message: str, board: chess.Board, *, has_moves: bool = False, has_game: bool = False,
             review: dict | None = None, prev: str | None = None, pasted: bool = False,
             history: list[dict] | None = None, board_info: dict | None = None,
             force: str | None = None, use_llm: bool = True) -> Intent:
    if force in KINDS:
        return Intent(force, "", "forced", "caller")
    intent = rule_intent(message, board, has_moves=has_moves, has_game=has_game, review=review,
                         prev=prev, pasted=pasted)
    if intent:
        return intent
    if use_llm:
        intent = llm_intent(message, board_description(board, has_moves, has_game, board_info), prev, history or [])
        if intent:
            return intent
    # No LLM: a live board makes "position" the safer default.
    return Intent("position", "", "default", "fallback")
