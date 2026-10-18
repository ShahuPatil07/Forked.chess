"""The agent's chess tools: schemas, session context and dispatch.

Each tool returns a COMPACT dict for the model (free-tier token budgets are
small) and records UI side effects on the Session (board updates, clickable
lines, notes for the next turn). Tools never raise; errors come back as
{"error": ...} so the model can recover.
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
from dataclasses import dataclass, field

import chess
import chess.pgn
import requests

from backend.coach.agent import engine as E
from backend.coach.agent import features as F

log = logging.getLogger(__name__)
START_FEN = chess.STARTING_FEN
EXPLORER = "https://explorer.lichess.org"


@dataclass
class Session:
    """Everything the tools need about the conversation's board."""
    fen: str = START_FEN
    game_pgn: str | None = None          # a loaded game (PGN), if any
    level: str = ""
    events: list[dict] = field(default_factory=list)   # UI events to stream
    lines: list[dict] = field(default_factory=list)    # clickable lines for this answer
    fens: set[str] = field(default_factory=set)        # every position seen (for the verifier)
    sans: set[str] = field(default_factory=set)        # every move seen in tool output
    notes: list[str] = field(default_factory=list)     # compact facts carried to the next turn

    def emit(self, event: dict):
        self.events.append(event)

    def add_line(self, label: str, start_fen: str, sans: list[str], fens: list[str], ucis: list[str] | None = None):
        if not sans:
            return
        self.lines.append({"label": label, "start_fen": start_fen, "san": sans, "fens": fens, "uci": ucis or []})
        self.fens.update(fens)
        self.sans.update(s.rstrip("+#") for s in sans)

    def note(self, text: str):
        self.notes.append(text)


def _board(session: Session, fen: str | None) -> chess.Board:
    value = (fen or "").strip() or session.fen
    board = chess.Board(value)
    if not board.is_valid():
        raise ValueError("That FEN is not a legal chess position.")
    session.fens.add(board.fen())
    return board


def _parse_move(board: chess.Board, text: str) -> chess.Move:
    t = text.strip().replace("0-0-0", "O-O-O").replace("0-0", "O-O")
    t = re.sub(r"^\d+\.(\.\.)?\s*", "", t)
    try:
        mv = chess.Move.from_uci(t.lower())
        if mv in board.legal_moves:
            return mv
    except ValueError:
        pass
    try:
        return board.parse_san(t)
    except ValueError:
        # Lenient piece-letter case (e.g. 'nf3').
        if t and t[0] in "kqrbn" and len(t) > 2:
            try:
                return board.parse_san(t[0].upper() + t[1:])
            except ValueError:
                pass
        raise ValueError(f"{text} is not a legal move for {'White' if board.turn else 'Black'} here")


def _line_text(board: chess.Board, sans: list[str], plies: int = 8) -> str:
    return E.numbered(board, sans[:plies])


def _material_swing(fens: list[str], mover: chess.Color) -> int:
    def mat(fen):
        b = chess.Board(fen)
        return sum(F.VALUES[p.piece_type] * (1 if p.color == mover else -1)
                   for p in b.piece_map().values() if p.piece_type != chess.KING)
    return mat(fens[-1]) - mat(fens[0]) if len(fens) > 1 else 0


# ── Tools ──────────────────────────────────────────────────────────────────────

def analyze_position(s: Session, fen: str | None = None, lines: int = 3) -> dict:
    board = _board(s, fen)
    if board.is_game_over():
        o = board.outcome()
        return {"game_over": o.termination.name.lower(), "result": o.result()}
    cands = E.top_lines(board.fen(), max(1, min(5, int(lines or 3))))
    if not cands:
        return {"error": "no engine result"}
    best = cands[0]
    out = {"fen": board.fen(), "side_to_move": F.COLOR[board.turn],
           "evaluation": f"{best['eval'].words()} ({best['eval'].short()})",
           "win_chance_side_to_move": f"{best['eval'].win_chance(board.turn)}%",
           "material": F.material(board)["summary"], "phase": F.phase(board), "candidates": []}
    for i, c in enumerate(cands):
        gap = round((best["eval"].pov(board.turn) - c["eval"].pov(board.turn)) / 100, 2) if c["eval"].mate is None and best["eval"].mate is None else None
        out["candidates"].append({
            "move": c["move_san"], "eval": c["eval"].short(),
            **({"pawns_worse_than_best": gap} if i and gap is not None else {}),
            "line": _line_text(board, c["line_san"]),
            "what_it_does": F.move_effects(board, chess.Move.from_uci(c["move_uci"]))[:3],
        })
        s.add_line(f"{c['move_san']} ({c['eval'].short()})", board.fen(), c["line_san"], c["fens"], c["line_uci"])
    snap = F.tactical_snapshot(board)
    out["tactics_now"] = {k: v for k, v in snap.items() if v and k != "side_to_move"}
    out["key_facts"] = key_facts(board)
    s.sans.update(m.rstrip("+#") for m in snap["checks_available"])
    s.note(f"[{board.fen()}] {best['eval'].words()} {best['eval'].short()}; best "
           + ", ".join(f"{c['move_san']} {c['eval'].short()}" for c in cands)
           + f"; main line {_line_text(board, best['line_san'], 6)}")
    return out


def key_facts(board: chess.Board) -> list[str]:
    """A few exact positional facts so explanations rest on the real board."""
    rep = F.positional_report(board)
    facts = [f"files: {'; '.join(rep['files'])}" if rep["files"] else "no open or half-open files"]
    for side in ("white", "black"):
        facts.append(rep[side]["king"])
        facts.append(f"{side} pawns: {rep[side]['pawns']}")
        if rep[side]["outposts"]:
            facts.append(f"{side} outposts: {', '.join(rep[side]['outposts'][:3])}")
        facts.extend(rep[side]["bishops"][:1])
    return facts


def evaluate_moves(s: Session, moves: list[str], fen: str | None = None) -> dict:
    """Counterfactual comparison: each move vs the engine's best, with the refutation."""
    board = _board(s, fen)
    if not moves:
        return {"error": "pass at least one move"}
    top = E.top_lines(board.fen(), 3)
    if not top:
        return {"error": "position is terminal"}
    best = top[0]
    best_pov = best["eval"].pov(board.turn)
    results = []
    wanted = []
    for text in moves[:4]:
        try:
            wanted.append(_parse_move(board, str(text)))
        except ValueError as exc:
            results.append({"move": text, "error": str(exc)})
    if chess.Move.from_uci(best["move_uci"]) not in wanted:
        wanted.append(chess.Move.from_uci(best["move_uci"]))
    for mv in wanted:
        c = E.move_line(board.fen(), mv.uci())
        pov = c["eval"].pov(board.turn)
        loss_cp = max(0, best_pov - pov) if abs(best_pov) < 50000 and abs(pov) < 50000 else None
        exp_loss = (best["eval"].win_chance(board.turn) - c["eval"].win_chance(board.turn))
        verdict = ("best" if mv.uci() == best["move_uci"] or (loss_cp is not None and loss_cp <= 10) else
                   "excellent" if exp_loss < 2 else "good" if exp_loss < 5 else
                   "inaccuracy" if exp_loss < 10 else "mistake" if exp_loss < 20 else "blunder")
        entry = {"move": c["move_san"], "eval_after": f"{c['eval'].short()} — {c['eval'].words()}",
                 "verdict": verdict, "what_it_does": F.move_effects(board, mv)[:4]}
        if loss_cp is not None and verdict != "best":
            entry["pawns_worse_than_best"] = round(loss_cp / 100, 2)
        if len(c["line_san"]) > 1:
            entry["opponent_best_reply"] = c["line_san"][1]
            entry["line"] = _line_text(board, c["line_san"])
            swing = _material_swing(c["fens"][:7], board.turn)
            if swing:
                entry["material_after_6_plies"] = f"{'+' if swing > 0 else ''}{swing} for {F.COLOR[board.turn]}"
            after = board.copy(); after.push(mv)
            reply = chess.Move.from_uci(c["line_uci"][1])
            entry["reply_does"] = F.move_effects(after, reply)[:2]
        if mv.uci() == best["move_uci"]:
            entry["is_engine_top_choice"] = True
        results.append(entry)
        s.add_line(f"{c['move_san']} ({c['eval'].short()})", board.fen(), c["line_san"], c["fens"], c["line_uci"])
    s.note(f"[{board.fen()}] compared: " + "; ".join(
        f"{r['move']} {r.get('verdict', 'illegal')} {r.get('eval_after', '').split(' —')[0]}"
        + (f" (reply {r['opponent_best_reply']})" if r.get("opponent_best_reply") else "") for r in results))
    return {"side_to_move": F.COLOR[board.turn], "best_eval": best["eval"].short(), "moves": results}


def opponent_threats(s: Session, fen: str | None = None) -> dict:
    board = _board(s, fen)
    me, opp = F.COLOR[board.turn], F.COLOR[not board.turn]
    out: dict = {"side_to_move": me}
    if board.is_check():
        out["in_check"] = f"{me} is in check; legal replies: " + ", ".join(board.san(m) for m in board.legal_moves)
    threat = E.null_move_threat(board.fen())
    if threat:
        flipped = chess.Board(threat["fens"][0])
        current = E.evaluate(board.fen())["eval"]
        swing = current.pov(board.turn) - threat["eval"].pov(board.turn)
        serious = threat["eval"].mate is not None and threat["eval"].pov(not board.turn) > 0 or swing > 120
        out["main_threat"] = {
            "if_it_were_opponents_move": threat["move_san"],
            "line": _line_text(flipped, threat["line_san"], 6),
            "effect": F.move_effects(flipped, chess.Move.from_uci(threat["move_uci"]))[:3],
            "serious": bool(serious),
            "eval_if_ignored": threat["eval"].short(),
        }
        out["assessment"] = (
            f"REAL THREAT: if {me} ignores it, {opp} plays {threat['move_san']} and the evaluation swings by "
            f"{abs(swing) / 100:.1f} pawns." if serious and threat["eval"].mate is None else
            f"REAL THREAT: {opp} threatens a forced mate starting with {threat['move_san']}." if serious else
            f"No serious threat right now: even with a free move {opp}'s best is {threat['move_san']}, which barely "
            f"changes the evaluation. Talk about {opp}'s long-term plans instead of a threat.")
        s.add_line(f"Threat: {threat['move_san']}", flipped.fen(), threat["line_san"], threat["fens"], threat["line_uci"])
        s.note(f"[{board.fen()}] {opp} threatens {threat['move_san']} ({'serious' if serious else 'not serious'}; "
               f"{_line_text(flipped, threat['line_san'], 4)})")
    loose = F.loose_pieces(board, board.turn)
    if loose:
        out["your_pieces_en_prise"] = [f"{x['piece']} ({x['capture']} wins {x['wins']})" for x in loose[:3]]
    p = F.pins(board, board.turn)
    if p:
        out["pins_against_you"] = p
    opp_checks = []
    probe = board.copy(stack=False); probe.turn = not board.turn; probe.ep_square = None
    if probe.is_valid():
        opp_checks = [probe.san(m) for m in probe.legal_moves if probe.gives_check(m)][:6]
        s.sans.update(opp_checks)
    if opp_checks:
        out["opponent_checks_available"] = opp_checks
    return out


def position_features(s: Session, fen: str | None = None) -> dict:
    board = _board(s, fen)
    rep = F.positional_report(board)
    s.note(f"[{board.fen()}] features: {rep['material']}; {rep['phase']}; W pawns {rep['white']['pawns']}; B pawns {rep['black']['pawns']}")
    return rep


def explore_line(s: Session, moves: list[str] | None = None, fen: str | None = None, show: bool = True,
                 label: str = "") -> dict:
    """Play a sequence (a what-if) legally, then evaluate where it lands."""
    board = _board(s, fen)
    start = board.fen()
    sans, ucis, fens = [], [], [start]
    for text in (moves or [])[:16]:
        try:
            mv = _parse_move(board, str(text))
        except ValueError as exc:
            return {"error": f"Stopped after {' '.join(sans) or 'no moves'}: {exc}",
                    "legal_moves_here": [board.san(m) for m in list(board.legal_moves)[:30]]}
        sans.append(board.san(mv)); ucis.append(mv.uci()); board.push(mv); fens.append(board.fen())
    out = {"line": _line_text(chess.Board(start), sans, 16) if sans else "(no moves)", "final_fen": board.fen()}
    if board.is_game_over():
        o = board.outcome()
        out["result"] = f"game over: {o.termination.name.lower()} {o.result()}"
    else:
        ev = E.evaluate(board.fen())
        out["evaluation_at_end"] = f"{ev['eval'].words()} ({ev['eval'].short()})"
        if ev["best"]:
            out["best_continuation"] = _line_text(board, ev["best"]["line_san"], 6)
            s.add_line(f"After {' '.join(sans[-2:]) or 'position'}: best play", board.fen(),
                       ev["best"]["line_san"], ev["best"]["fens"], ev["best"]["line_uci"])
        out["material"] = F.material(board)["summary"]
        snap = F.tactical_snapshot(board)
        hanging = snap["your_loose_pieces"] + snap["opponent_loose_pieces"]
        if hanging:
            out["pieces_en_prise"] = [x["piece"] + f" ({x['capture']})" for x in hanging[:3]]
    if sans:
        s.add_line(label or ("What if " + " ".join(sans[:3]) + ("…" if len(sans) > 3 else "")), start, sans, fens, ucis)
        s.note(f"[{start}] line {out['line']} → {out.get('evaluation_at_end') or out.get('result')}")
    if show:
        s.emit({"type": "board", "fen": start, "line": {"san": sans, "uci": ucis, "fens": fens},
                "label": label or (("Line: " + " ".join(sans[:4])) if sans else "Position")})
    return out


def _explorer(path: str, params: dict) -> dict:
    headers = {"User-Agent": "Forked-Coach/1.0"}
    token = os.getenv("LICHESS_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    key = ("explorer", path, json.dumps(params, sort_keys=True))
    return E._cached(key, lambda: requests.get(f"{EXPLORER}/{path}", params=params, headers=headers, timeout=8).json())


def opening_explorer(s: Session, fen: str | None = None) -> dict:
    board = _board(s, fen)
    try:
        masters = _explorer("masters", {"fen": board.fen(), "moves": 6, "topGames": 4})
        club = _explorer("lichess", {"fen": board.fen(), "moves": 4, "topGames": 0, "recentGames": 0,
                                     "speeds": "blitz,rapid,classical", "ratings": "1600,1800,2000,2200"})
    except Exception as exc:
        return {"error": f"Opening explorer unavailable: {exc}"}

    def rows(data):
        out = []
        for m in data.get("moves", [])[:6]:
            n = m["white"] + m["draws"] + m["black"]
            if not n:
                continue
            out.append({"move": m["san"], "games": n, "white_win": f"{round(100 * m['white'] / n)}%",
                        "draw": f"{round(100 * m['draws'] / n)}%", "black_win": f"{round(100 * m['black'] / n)}%"})
            s.sans.add(m["san"].rstrip("+#"))
        return out
    opening = masters.get("opening") or club.get("opening")
    out = {"opening": f"{opening['eco']} {opening['name']}" if opening else "unnamed / out of book",
           "master_moves": rows(masters), "club_moves_1600_2200": rows(club),
           "famous_games_here": [f"{g['white']['name']} – {g['black']['name']}, {g.get('year')} "
                                 f"({'1-0' if g.get('winner') == 'white' else '0-1' if g.get('winner') == 'black' else '½-½'}) id={g['id']}"
                                 for g in masters.get("topGames", [])[:4]]}
    s.note(f"[{board.fen()}] opening: {out['opening']}; masters play " + ", ".join(m["move"] for m in out["master_moves"][:4]))
    return out


def _load_game_pgn(s: Session, pgn: str, label: str) -> chess.pgn.Game | None:
    game = chess.pgn.read_game(io.StringIO(pgn))
    if game is None:
        return None
    board = game.board()
    sans, ucis, fens = [], [], [board.fen()]
    for mv in game.mainline_moves():
        sans.append(board.san(mv)); ucis.append(mv.uci()); board.push(mv); fens.append(board.fen())
    s.game_pgn = pgn
    s.fens.update(fens); s.sans.update(x.rstrip("+#") for x in sans)
    s.emit({"type": "board", "fen": fens[0], "line": {"san": sans, "uci": ucis, "fens": fens},
            "label": label, "game": {"pgn": pgn, "headers": dict(game.headers)}})
    return game


def find_master_game(s: Session, white: str = "", black: str = "", year: int | None = None,
                     moves: list[str] | None = None) -> dict:
    """Verify a historical game against the Lichess Masters database (never invent games)."""
    names = [n.lower().split()[-1].strip(",") for n in (white, black) if n and n.strip()]
    if not names:
        return {"error": "Give at least one player's surname."}
    board = chess.Board()
    path = []
    for text in (moves or [])[:40]:
        try:
            mv = _parse_move(board, str(text))
        except ValueError:
            break
        path.append(mv.uci()); board.push(mv)

    def matches(g):
        players = (g["white"]["name"] + " " + g["black"]["name"]).lower()
        ok = all(n in players for n in names)
        if year:
            ok = ok and abs(int(g.get("year") or 0) - int(year)) <= 1
        return ok
    # Deep positions are near-unique, so check from the deepest prefix backwards.
    checkpoints = sorted({len(path), *range(len(path), -1, -6), 0}, reverse=True)
    seen = []
    for depth in checkpoints:
        try:
            data = _explorer("masters", {"play": ",".join(path[:depth]), "topGames": 15, "moves": 0})
        except Exception as exc:
            return {"error": f"Masters database unavailable: {exc}"}
        for g in data.get("topGames", []):
            seen.append(f"{g['white']['name']} – {g['black']['name']} {g.get('year')}")
            if matches(g):
                try:
                    pgn = E._cached(("pgn", g["id"]), lambda: requests.get(f"{EXPLORER}/masters/pgn/{g['id']}", timeout=8).text)
                except Exception as exc:
                    return {"error": f"Found game {g['id']} but could not download it: {exc}"}
                game = _load_game_pgn(s, pgn, f"{g['white']['name']} – {g['black']['name']}, {g.get('year')}")
                if game is None:
                    break
                h = game.headers
                s.note(f"loaded game {h.get('White')} – {h.get('Black')}, {h.get('Event')} {h.get('Date')} {h.get('Result')}")
                return {"found": True, "white": h.get("White"), "black": h.get("Black"), "event": h.get("Event"),
                        "date": h.get("Date"), "result": h.get("Result"), "moves": len(list(game.mainline_moves())),
                        "opening_moves": E.numbered(game.board(), [m for m in _first_sans(game, 12)]),
                        "loaded_on_board": True}
    return {"found": False, "message": "No matching game in the Lichess Masters database reached via those moves. "
            "Ask the user for the PGN or more opening moves; do not invent the game.",
            "games_checked_sample": seen[:6]}


def _first_sans(game: chess.pgn.Game, n: int) -> list[str]:
    b = game.board(); out = []
    for mv in list(game.mainline_moves())[:n]:
        out.append(b.san(mv)); b.push(mv)
    return out


def tablebase(s: Session, fen: str | None = None) -> dict:
    board = _board(s, fen)
    if len(board.piece_map()) > 7:
        return {"error": "Tablebases cover positions with 7 or fewer pieces."}
    try:
        data = E._cached(("tb", board.fen()), lambda: requests.get(
            "https://tablebase.lichess.ovh/standard", params={"fen": board.fen()}, timeout=8).json())
    except Exception as exc:
        return {"error": f"Tablebase unavailable: {exc}"}
    cat = data.get("category")
    moves = [{"move": m["san"], "result_for_mover": {"win": "loss", "loss": "win"}.get(m["category"], m["category"]),
              **({"dtm": m["dtm"]} if m.get("dtm") is not None else {})} for m in data.get("moves", [])[:5]]
    s.sans.update(m["move"].rstrip("+#") for m in moves)
    s.note(f"[{board.fen()}] tablebase: {cat} for side to move; best {moves[0]['move'] if moves else '-'}")
    return {"verdict_for_side_to_move": cat, "dtm": data.get("dtm"), "dtz": data.get("dtz"), "moves": moves,
            "note": "Perfect play result (Syzygy). This is proven, not an estimate."}


def review_game(s: Session, pgn: str | None = None) -> dict:
    from backend.game_review import review_rows, summarize, REVIEW_SLOT
    from ml.config import STOCKFISH_PATH
    import chess.engine
    text = (pgn or s.game_pgn or "").strip()
    if not text:
        return {"error": "No game loaded. Ask the user to paste a PGN."}
    game = chess.pgn.read_game(io.StringIO(text))
    if game is None or game.errors or not list(game.mainline_moves()):
        return {"error": "Could not parse that PGN."}
    if pgn:
        _load_game_pgn(s, text, "Game")
    if not REVIEW_SLOT.acquire(timeout=30):
        return {"error": "Another game review is running; try again shortly."}
    try:
        with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as engine:
            engine.configure({"Threads": 1, "Hash": 64})
            rows = list(review_rows(game, engine, "quick"))
    finally:
        REVIEW_SLOT.release()
    summary = summarize(rows)
    key = [r for r in rows if r["classification"] in ("blunder", "mistake", "miss", "brilliant", "great")]
    key.sort(key=lambda r: -r["expected_loss"] if r["classification"] not in ("brilliant", "great") else -0.5)
    moments = []
    for r in sorted(key[:6], key=lambda r: r["ply"]):
        before = chess.Board(r["before_fen"])
        moments.append({
            "move": f"{r['move_number']}{'.' if r['color'] == 'white' else '...'} {r['san']}",
            "ply": r["ply"], "type": r["classification"],
            "eval_before": E.Eval(r["best_score"]["white_cp"], r["best_score"]["white_mate"]).short(),
            "eval_after": E.Eval(r["played_score"]["white_cp"], r["played_score"]["white_mate"]).short(),
            **({"better_was": r["best_san"], "better_line": E.numbered(before, r["best_line"]["san"][:5])}
               if r["best_san"] != r["san"] else {}),
            "what_it_did": F.move_effects(before, chess.Move.from_uci(r["uci"]))[:2],
        })
        s.add_line(f"{r['move_number']}{'.' if r['color'] == 'white' else '...'} {r['best_san']} (better)",
                   r["before_fen"], r["best_line"]["san"], r["best_line"]["fens"], r["best_line"]["uci"])
    swings = []
    for r in rows:
        e = E.Eval(r["played_score"]["white_cp"], r["played_score"]["white_mate"])
        swings.append(e.words())
    h = game.headers
    opening = next((r["opening"] for r in reversed(rows) if r.get("opening")), None)
    out = {"players": f"{h.get('White', '?')} – {h.get('Black', '?')}", "result": h.get("Result", "*"),
           "opening": f"{opening['eco']} {opening['name']}" if opening else None,
           "accuracy": {"white": summary["white"]["accuracy"], "black": summary["black"]["accuracy"]},
           "counts": {"white": summary["white"]["counts"], "black": summary["black"]["counts"]},
           "critical_moments": moments,
           "eval_story": {"after_move_10": swings[min(19, len(swings) - 1)], "after_move_25": swings[min(49, len(swings) - 1)],
                          "final": swings[-1]}}
    s.sans.update(r["san"].rstrip("+#") for r in rows)
    s.note("game review: " + "; ".join(f"{m['move']} {m['type']}" + (f" (better {m['better_was']})" if m.get("better_was") else "") for m in moments))
    s.emit({"type": "moments", "moments": [{"ply": m["ply"], "type": m["type"], "move": m["move"]} for m in moments]})
    return out


def opening_theory(s: Session, query: str, eco: str = "") -> dict:
    from backend.opening_chat import _knowledge_lookup, _format_knowledge_entry
    entries = _knowledge_lookup(eco=eco, opening_name=query, user_message=query, max_entries=2)
    if not entries:
        return {"found": False, "message": "No curated entry; use opening_explorer for real statistics and say theory is from general knowledge."}
    return {"found": True, "knowledge": [_format_knowledge_entry(e)[:1200] for e in entries]}


def endgame_theory(s: Session, query: str) -> dict:
    from backend.endgames import _knowledge_lookup, _format_knowledge_entry
    entries = _knowledge_lookup(user_message=query, max_entries=2)
    if not entries:
        return {"found": False, "message": "No curated entry matched."}
    return {"found": True, "knowledge": [_format_knowledge_entry(e)[:1200] for e in entries]}


def get_puzzle(s: Session, theme: str = "", rating: int = 1500) -> dict:
    from backend.coach.tools import _tool_get_puzzle
    data = _tool_get_puzzle("", {"theme": theme or None, "difficulty_elo": rating})
    if data.get("found"):
        s.emit({"type": "puzzle", "payload": data})
        return {"found": True, "side_to_move": data["side_to_move"], "rating": data["rating"],
                "themes": data["themes"], "shown_to_user": True,
                "instruction": "Do NOT reveal the solution; invite the user to solve it on the inline board."}
    return data


def start_game(s: Session, user_color: str = "white", strength: str = "intermediate", fen: str | None = None) -> dict:
    board = _board(s, fen) if fen else chess.Board()
    color = "black" if str(user_color).lower().startswith("b") else "white"
    strength = strength if strength in ("beginner", "intermediate", "advanced", "strong", "engine") else "intermediate"
    s.emit({"type": "play", "fen": board.fen(), "user_color": color, "strength": strength})
    return {"started": True, "user_plays": color, "coach_strength": strength, "fen": board.fen(),
            "instruction": "The board is now in play mode. Tell the user to make their move on the board."
                           if (board.turn == chess.WHITE) == (color == "white") else
                           "The coach moves first automatically on the board."}


HANDLERS = {
    "analyze_position": analyze_position, "evaluate_moves": evaluate_moves,
    "opponent_threats": opponent_threats, "position_features": position_features,
    "explore_line": explore_line, "opening_explorer": opening_explorer,
    "find_master_game": find_master_game, "tablebase": tablebase, "review_game": review_game,
    "opening_theory": opening_theory, "endgame_theory": endgame_theory,
    "get_puzzle": get_puzzle, "start_game": start_game,
}

LABELS = {
    "analyze_position": "Analysing the position", "evaluate_moves": "Comparing moves",
    "opponent_threats": "Checking the opponent's threats", "position_features": "Reading the structure",
    "explore_line": "Playing out the line", "opening_explorer": "Checking the opening database",
    "find_master_game": "Searching master games", "tablebase": "Consulting the tablebase",
    "review_game": "Reviewing the game", "opening_theory": "Checking opening theory",
    "endgame_theory": "Checking endgame theory", "get_puzzle": "Finding a puzzle", "start_game": "Setting up a game",
}


def _fn(name, desc, props=None, required=None):
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
        "type": "object", "properties": props or {}, "required": required or []}}}


FEN = {"type": "string", "description": "FEN; omit to use the user's current board"}
MOVES = {"type": "array", "items": {"type": "string"}, "description": "SAN moves, e.g. [\"Nf3\",\"d5\"]"}
SCHEMAS = {
    "analyze_position": _fn("analyze_position", "Stockfish MultiPV: evaluation, top candidate moves with lines and what each does, current tactics (loose pieces, pins, checks).",
                            {"fen": FEN, "lines": {"type": "integer", "description": "candidates 1-5, default 3"}}),
    "evaluate_moves": _fn("evaluate_moves", "Judge specific moves vs the engine's best: verdict, eval after, opponent's best reply/refutation, what each move does. Use for 'why is X good/bad', 'X or Y?', and to test the natural alternative (counterfactual).",
                          {"moves": MOVES, "fen": FEN}, ["moves"]),
    "opponent_threats": _fn("opponent_threats", "What the opponent threatens if ignored (null-move probe), your pieces en prise, pins, opponent checks. Use for prophylaxis/defence questions.", {"fen": FEN}),
    "position_features": _fn("position_features", "Exact positional facts: pawn weaknesses, passed pawns, king safety, open files, outposts, bad bishops, space, mobility, development.", {"fen": FEN}),
    "explore_line": _fn("explore_line", "Play a legal sequence from the board (what-if), evaluate the end position and show it on the user's board. Also use with no moves to display a position.",
                        {"moves": MOVES, "fen": FEN, "show": {"type": "boolean"}, "label": {"type": "string"}}),
    "opening_explorer": _fn("opening_explorer", "Opening name and real statistics from Lichess masters and club games for this position, plus famous games that reached it.", {"fen": FEN}),
    "find_master_game": _fn("find_master_game", "Find and load a real historical game from the Masters database. Give surnames, year, and the opening moves you believe were played (verification walks them).",
                            {"white": {"type": "string"}, "black": {"type": "string"}, "year": {"type": "integer"}, "moves": MOVES}, []),
    "tablebase": _fn("tablebase", "Perfect-play Syzygy result for positions with <=7 pieces.", {"fen": FEN}),
    "review_game": _fn("review_game", "Engine review of a whole game (PGN or the loaded game): accuracy, critical moments, better moves. Takes ~10-20 s.", {"pgn": {"type": "string"}}),
    "opening_theory": _fn("opening_theory", "Curated opening knowledge (plans, structures, typical ideas).", {"query": {"type": "string"}, "eco": {"type": "string"}}, ["query"]),
    "endgame_theory": _fn("endgame_theory", "Curated endgame technique (key positions, rules of thumb).", {"query": {"type": "string"}}, ["query"]),
    "get_puzzle": _fn("get_puzzle", "Show an inline tactics puzzle (Lichess themes like fork, pin, mateIn2, backRankMate).",
                      {"theme": {"type": "string"}, "rating": {"type": "integer"}}),
    "start_game": _fn("start_game", "Start a game against the coach on the board (from the start or the current board).",
                      {"user_color": {"type": "string", "enum": ["white", "black"]},
                       "strength": {"type": "string", "enum": ["beginner", "intermediate", "advanced", "strong", "engine"]},
                       "fen": FEN}),
}
CORE = ["analyze_position", "evaluate_moves", "opponent_threats", "position_features", "explore_line"]


def select_tools(message: str, session: Session) -> list[dict]:
    """Send only relevant schemas: free-tier token budgets are tiny."""
    m = message.lower()
    names = list(CORE)
    board = chess.Board(session.fen)
    if board.fullmove_number <= 15 or re.search(r"opening|defen[cs]e|gambit|attack\b|variation|theory|repertoire|famous|master|played", m):
        names += ["opening_explorer", "opening_theory"]
    if re.search(r"game|karpov|kasparov|carlsen|fischer|tal\b|vs\.?|versus|famous|historical|\b1[89]\d\d\b|\b20\d\d\b", m):
        names += ["find_master_game", "opening_explorer"]
    if session.game_pgn or re.search(r"review|analy[sz]e (my|this|the) game|pgn|\[event|1\.\s*[a-h1-8nbrqk]", m):
        names.append("review_game")
    if len(board.piece_map()) <= 7 or "endgame" in m or "tablebase" in m:
        names += ["tablebase", "endgame_theory"]
    if re.search(r"puzzle|exercise|train|drill|test me|quiz", m):
        names.append("get_puzzle")
    if re.search(r"\bplay\b|game against|let'?s play|play (me|you|against)|spar", m):
        names.append("start_game")
    return [SCHEMAS[n] for n in dict.fromkeys(names)]


def run_tool(session: Session, name: str, raw_args: str | dict) -> dict:
    handler = HANDLERS.get(name)
    if handler is None:
        return {"error": f"unknown tool {name}"}
    try:
        args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args or {})
        if not isinstance(args, dict):
            args = {}
    except Exception:
        args = {}
    if isinstance(args.get("moves"), str):
        args["moves"] = [t for t in re.split(r"[\s,]+", args["moves"]) if t and not re.fullmatch(r"\d+\.+", t)]
    try:
        return handler(session, **{k: v for k, v in args.items() if v is not None})
    except TypeError as exc:
        return {"error": f"bad arguments for {name}: {exc}"}
    except ValueError as exc:
        return {"error": str(exc)}
    except Exception as exc:
        log.error("agent tool %s failed: %s", name, exc, exc_info=True)
        return {"error": f"{name} failed: {type(exc).__name__}"}
