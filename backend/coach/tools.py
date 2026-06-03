"""
Coach agent tools — schemas (Groq/OpenAI function-calling format) + dispatch.

Six tools the coach can call mid-conversation. Each handler is synchronous and
returns a JSON-serialisable dict; the router runs them off the event loop and
feeds the result back to Groq. Everything is grounded in the user's real data or
the curated knowledge bases — no fabrication.
"""
from __future__ import annotations

import io
import json
import logging
from pathlib import Path

import chess
import chess.pgn

from ml.config import DATA_DIR
from backend.coach.explain import explain_position
from backend.coach.context import top_cluster_id

OUTPUT_DIR = DATA_DIR / "output"
log = logging.getLogger(__name__)


# ── Schemas (advertised to Groq) ───────────────────────────────────────────────

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_mistake_positions",
            "description": ("Fetch the user's REAL board positions where they made mistakes "
                            "belonging to a specific blindspot cluster. Use when the user wants "
                            "to see their own mistakes, or a concrete example would help. "
                            "cluster_id is the family key shown in the user context (e.g. "
                            "'loose_pieces', 'king_safety')."),
            "parameters": {
                "type": "object",
                "properties": {
                    "cluster_id": {"type": "string", "description": "Blindspot cluster_id from the user context."},
                    "limit": {"type": "integer", "description": "How many positions (default 3, max 10)."},
                },
                "required": ["cluster_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "explain_position",
            "description": ("Get a grounded chess explanation for a specific FEN: the best move, the "
                            "evaluation, and the key idea. Use whenever a concrete position or move is "
                            "being discussed. Do NOT calculate variations yourself — call this."),
            "parameters": {
                "type": "object",
                "properties": {
                    "fen": {"type": "string", "description": "Position in FEN notation."},
                    "question": {"type": "string", "description": "Optional focus, e.g. 'why is Rd8 better than Qe4?'"},
                },
                "required": ["fen"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_puzzle",
            "description": ("Fetch one tactics puzzle for the user to solve inline. Defaults to their top "
                            "blindspot. Pass a theme (e.g. 'fork', 'backRankMate') or a cluster_id to target "
                            "a specific weakness. Returns FEN + solution for an interactive board."),
            "parameters": {
                "type": "object",
                "properties": {
                    "theme": {"type": "string", "description": "Optional Lichess theme tag."},
                    "cluster_id": {"type": "string", "description": "Optional blindspot cluster_id."},
                    "difficulty_elo": {"type": "integer", "description": "Optional target rating (default = user's elo)."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "analyze_pgn",
            "description": ("Analyse a game (PGN) or single position (FEN) the user pasted. Runs Stockfish to "
                            "find the biggest mistakes with their eval drops and tactical themes. Use when the "
                            "user pastes a game or position."),
            "parameters": {
                "type": "object",
                "properties": {
                    "pgn_or_fen": {"type": "string", "description": "A full PGN or a single FEN string."},
                },
                "required": ["pgn_or_fen"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_opening_theory",
            "description": ("Query the curated opening knowledge base for theory about an opening (plans, ideas, "
                            "typical structures). Use for opening questions. Answers are universal, not personalised."),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The opening question or opening name."},
                    "eco_hint": {"type": "string", "description": "Optional ECO code, e.g. 'B20'."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_endgame_theory",
            "description": ("Query the curated endgame knowledge base for theory (key positions, technique, rules). "
                            "Use for endgame questions."),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The endgame question or endgame name."},
                },
                "required": ["query"],
            },
        },
    },
]


def _read_json(path: Path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


# ── Tool handlers ──────────────────────────────────────────────────────────────

def _tool_get_mistake_positions(username: str, args: dict) -> dict:
    cluster_id = str(args.get("cluster_id", ""))
    limit = max(1, min(10, int(args.get("limit", 3) or 3)))
    mistakes = _read_json(OUTPUT_DIR / f"{username}_mistakes.json", [])
    hits = [m for m in mistakes if str(m.get("cluster_id")) == cluster_id]
    hits.sort(key=lambda m: -(m.get("eval_drop_cp", 0)))
    out = [{
        "fen":            m.get("fen"),
        "move_played":    m.get("move_played_san"),
        "best_move":      m.get("best_move_uci"),
        "eval_drop_cp":   m.get("eval_drop_cp"),
        "threat_type":    m.get("threat_type"),
        "game_phase":     m.get("game_phase"),
        "move_number":    m.get("move_number"),
    } for m in hits[:limit]]
    return {"cluster_id": cluster_id, "count": len(out), "positions": out}


def _tool_explain_position(username: str, args: dict) -> dict:
    return explain_position(str(args.get("fen", "")), str(args.get("question", "")))


def _tool_get_puzzle(username: str, args: dict) -> dict:
    from ml.puzzles.retriever import get_index
    from ml.clustering.families import family_lichess_themes, family_of

    settings = _read_json(OUTPUT_DIR / f"{username}_settings.json", {}) or {}
    elo = int(args.get("difficulty_elo") or settings.get("elo") or 1500)

    themes: list[str] = []
    if args.get("theme"):
        themes = [str(args["theme"])]
    else:
        cid = str(args.get("cluster_id") or (top_cluster_id(username) or ""))
        if cid:
            fam = cid if cid in family_lichess_themes() else family_of(cid)
            themes = family_lichess_themes().get(fam, [])

    index = get_index()
    results = index.query_by_themes(
        themes=themes or ["fork", "pin", "hangingPiece"],
        min_rating=max(600, elo - 250), max_rating=min(3000, elo + 250),
        top_k=1,
    )
    if not results:
        return {"found": False, "message": "No matching puzzle found."}

    p = results[0]
    # Lichess puzzle FEN is BEFORE the opponent's setup move; moves[0] is that
    # move, the user must find moves[1]. Show the position after moves[0].
    uci = (p.moves or "").split()
    board = chess.Board(p.fen)
    puzzle_fen = p.fen
    solution = ""
    if uci:
        try:
            board.push_uci(uci[0]); puzzle_fen = board.fen()
            solution = uci[1] if len(uci) > 1 else ""
        except Exception:
            pass
    return {
        "found": True,
        "puzzle_id": p.puzzle_id,
        "fen": puzzle_fen,           # position the user solves from
        "side_to_move": "white" if chess.Board(puzzle_fen).turn else "black",
        "solution_uci": solution,    # the move they must find
        "full_line_uci": uci,        # full solution sequence
        "rating": p.rating,
        "themes": p.themes,
        "game_url": p.game_url,
    }


def _looks_like_fen(s: str) -> bool:
    s = s.strip()
    if "\n" in s or "[" in s or "1." in s:
        return False
    parts = s.split()
    return len(parts) >= 2 and parts[0].count("/") == 7


def _tool_analyze_pgn(username: str, args: dict, max_plies: int = 80) -> dict:
    from backend.main import _sf_lock, _ensure_engine
    import chess.engine

    raw = str(args.get("pgn_or_fen", "")).strip()
    if not raw:
        return {"ok": False, "message": "Nothing to analyse."}

    # Single FEN → explain the position.
    if _looks_like_fen(raw):
        exp = explain_position(raw, "What is the best move and the key idea?")
        return {"ok": True, "kind": "fen", "fen": raw, "explanation": exp}

    # PGN → scan for the biggest mistakes.
    try:
        game = chess.pgn.read_game(io.StringIO(raw))
        if game is None:
            raise ValueError("could not parse PGN")
    except Exception as exc:
        return {"ok": False, "message": f"Couldn't parse that as PGN or FEN: {exc}"}

    board = game.board()
    mistakes = []
    ply = 0
    with _sf_lock:
        engine = _ensure_engine()
        prev_best_cp = None
        for move in game.mainline_moves():
            if ply >= max_plies:
                break
            # Eval before the move (side to move perspective).
            info_b = engine.analyse(board, chess.engine.Limit(depth=12))
            sc_b = info_b["score"].pov(board.turn)
            best = (info_b.get("pv") or [None])[0]
            cp_before = sc_b.score(mate_score=10000)
            fen_before = board.fen()
            san = board.san(move)
            mover = board.turn
            move_no = board.fullmove_number
            board.push(move)
            # Eval after, from the same mover's perspective.
            info_a = engine.analyse(board, chess.engine.Limit(depth=12))
            cp_after = info_a["score"].pov(mover).score(mate_score=10000)
            if cp_before is not None and cp_after is not None:
                drop = cp_before - cp_after
                if drop >= 100 and best is not None:
                    mistakes.append({
                        "move_number": move_no,
                        "side": "white" if mover == chess.WHITE else "black",
                        "move_played": san,
                        "best_move_uci": best.uci(),
                        "eval_drop_cp": int(drop),
                        "fen_before": fen_before,
                    })
            ply += 1

    mistakes.sort(key=lambda m: -m["eval_drop_cp"])
    return {
        "ok": True,
        "kind": "pgn",
        "plies_analysed": ply,
        "mistakes_found": len(mistakes),
        "top_mistakes": mistakes[:5],
    }


def _tool_get_opening_theory(username: str, args: dict) -> dict:
    from backend.opening_chat import _knowledge_lookup, _format_knowledge_entry
    entries = _knowledge_lookup(
        eco=str(args.get("eco_hint", "")),
        opening_name=str(args.get("query", "")),
        user_message=str(args.get("query", "")),
        max_entries=2,
    )
    if not entries:
        return {"found": False, "message": "No curated opening entry matched; answer from general knowledge but say so."}
    return {"found": True, "knowledge": [_format_knowledge_entry(e) for e in entries],
            "sources": [{"name": e.get("name", ""), "eco": e.get("eco", "")} for e in entries]}


def _tool_get_endgame_theory(username: str, args: dict) -> dict:
    from backend.endgames import _knowledge_lookup as _eg_lookup, _format_knowledge_entry as _eg_fmt
    entries = _eg_lookup(user_message=str(args.get("query", "")), max_entries=2)
    if not entries:
        return {"found": False, "message": "No curated endgame entry matched; answer from general knowledge but say so."}
    return {"found": True, "knowledge": [_eg_fmt(e) for e in entries],
            "sources": [{"name": e.get("name", "")} for e in entries]}


_HANDLERS = {
    "get_mistake_positions": _tool_get_mistake_positions,
    "explain_position":      _tool_explain_position,
    "get_puzzle":            _tool_get_puzzle,
    "analyze_pgn":           _tool_analyze_pgn,
    "get_opening_theory":    _tool_get_opening_theory,
    "get_endgame_theory":    _tool_get_endgame_theory,
}


def dispatch_tool(username: str, name: str, args: dict) -> dict:
    """Execute a tool by name. Always returns a dict (errors are captured, never raised)."""
    handler = _HANDLERS.get(name)
    if handler is None:
        return {"error": f"unknown tool {name!r}"}
    try:
        return handler(username, args or {})
    except Exception as exc:
        log.error("coach tool %s failed: %s", name, exc, exc_info=True)
        return {"error": f"{name} failed: {exc}"}
