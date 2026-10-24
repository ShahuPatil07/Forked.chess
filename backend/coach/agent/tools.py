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
    arrows: list[dict] = field(default_factory=list)   # {"fen","uci","san","kind"} candidates for board arrows
    puzzle_rating: int = 1400                          # default puzzle difficulty (from the profile)
    seen_puzzles: set[str] = field(default_factory=set)
    maia_elo: int = 1900                               # play-along strength (Lichess scale, 600-2800)
    created: bool = False                              # a create tool put something on the board
    events_log: list[dict] = field(default_factory=list)   # every UI event of this turn (events is drained)
    username: str = ""                                 # for per-user tools (warm-up plan / stats)

    def emit(self, event: dict):
        self.events.append(event)
        self.events_log.append(event)

    def arrow(self, fen: str, uci: str, san: str, kind: str):
        if not any(a["fen"] == fen and a["uci"] == uci for a in self.arrows):
            self.arrows.append({"fen": fen, "uci": uci, "san": san.rstrip("+#"), "kind": kind})

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


MOTIF_NAMES = {
    "mate": "forced mate", "backRankMate": "back-rank mate", "hangingPiece": "wins a hanging piece",
    "fork": "fork", "discoveredAttack": "discovered attack", "skewer": "skewer", "pin": "pin",
    "capturingDefender": "captures the defender", "advancedPawn": "advanced pawn / promotion",
}


def _motifs(board: chess.Board, ucis: list[str], fens: list[str]) -> list[str]:
    """Board-verified tactic names for a line (port of the Lichess puzzle tagger).
    Only for lines that actually win material or mate: the tagger is built for
    winning puzzle solutions and would over-tag quiet lines."""
    if not ucis:
        return []
    end = chess.Board(fens[-1]) if fens else None
    mating = bool(end and end.is_checkmate())
    if not mating and _material_swing(fens[:9], board.turn) < 2:
        return []
    try:
        from ml.classifier.verifier import verify
        found = verify(board, ucis)
    except Exception:
        return []
    order = list(MOTIF_NAMES)
    return [MOTIF_NAMES[m] for m in sorted(found, key=order.index) if m in MOTIF_NAMES]


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
        motifs = _motifs(board, c["line_uci"], c["fens"])
        out["candidates"].append({
            "move": c["move_san"], "eval": c["eval"].short(),
            **({"pawns_worse_than_best": gap} if i and gap is not None else {}),
            "line": _line_text(board, c["line_san"]),
            "what_it_does": F.move_effects(board, chess.Move.from_uci(c["move_uci"]))[:3],
            **({"motifs": motifs} if motifs else {}),
        })
        s.add_line(f"{c['move_san']} ({c['eval'].short()})", board.fen(), c["line_san"], c["fens"], c["line_uci"])
        s.arrow(board.fen(), c["move_uci"], c["move_san"], "best" if i == 0 else "alt")
    snap = F.tactical_snapshot(board)
    # Name every fact by colour: "checks_available" alone was misread as the opponent's threat.
    me, opp = F.COLOR[board.turn], F.COLOR[not board.turn]
    named = {"in_check": f"{me} is in check" if snap["in_check"] else None,
             f"checks_{me}_can_give_now": snap["checks_available"],
             f"{me}_pieces_en_prise": [x["piece"] for x in snap["your_loose_pieces"]],
             f"{opp}_pieces_en_prise": [x["piece"] for x in snap["opponent_loose_pieces"]],
             "pins": snap["pins"]}
    out["tactics_now"] = {k: v for k, v in named.items() if v}
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
    facts.extend(f"STRUCTURE (theory): {s}" for s in rep.get("structures", []))
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
        motifs = _motifs(board, c["line_uci"], c["fens"])
        if motifs:
            entry["motifs"] = motifs
        if loss_cp is not None and verdict != "best":
            entry["pawns_worse_than_best"] = round(loss_cp / 100, 2)
        if len(c["line_san"]) > 1:
            entry["opponent_best_reply"] = c["line_san"][1]
            entry["line"] = _line_text(board, c["line_san"])
            swing = _material_swing(c["fens"][:7], board.turn)
            if swing:
                # Two separate facts: what the line wins, and where material stands afterwards.
                # (A single "+5" was read as the final balance when the side started 2 points down.)
                entry["material_won_in_line"] = f"{'+' if swing > 0 else ''}{swing} points for {F.COLOR[board.turn]} compared with now"
                entry["material_balance_after_line"] = F.material(chess.Board(c["fens"][:7][-1]))["summary"]
            after = board.copy(); after.push(mv)
            reply = chess.Move.from_uci(c["line_uci"][1])
            entry["reply_does"] = F.move_effects(after, reply)[:2]
            refutation = _motifs(after, c["line_uci"][1:], c["fens"][1:])
            if refutation and verdict in ("inaccuracy", "mistake", "blunder"):
                entry["refutation_motifs"] = refutation
        if mv.uci() == best["move_uci"]:
            entry["is_engine_top_choice"] = True
        results.append(entry)
        s.add_line(f"{c['move_san']} ({c['eval'].short()})", board.fen(), c["line_san"], c["fens"], c["line_uci"])
        s.arrow(board.fen(), mv.uci(), c["move_san"],
                "best" if mv.uci() == best["move_uci"] else "bad" if verdict in ("mistake", "blunder") else "alt")
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
        if serious:   # same squares on the real board: show it as a red arrow
            s.arrow(board.fen(), threat["move_uci"], threat["move_san"], "threat")
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


# ── Create tools (puzzle / named position / material editor / play vs Maia) ─────

THEME_ALIASES = {
    "mate in 1": "mateIn1", "mate in one": "mateIn1", "mate in 2": "mateIn2", "mate in two": "mateIn2",
    "mate in 3": "mateIn3", "mate in three": "mateIn3", "mate": "mate", "checkmate": "mate",
    "back rank": "backRankMate", "back-rank": "backRankMate", "smothered": "smotheredMate",
    "discovered": "discoveredAttack", "discovery": "discoveredAttack", "double check": "doubleCheck",
    "hanging": "hangingPiece", "free piece": "hangingPiece", "x-ray": "xRayAttack", "xray": "xRayAttack",
    "zwischenzug": "intermezzo", "in-between": "intermezzo", "trapped": "trappedPiece",
    "rook endgame": "rookEndgame", "rook ending": "rookEndgame", "pawn endgame": "pawnEndgame",
    "pawn ending": "pawnEndgame", "queen endgame": "queenEndgame", "bishop endgame": "bishopEndgame",
    "knight endgame": "knightEndgame", "under promotion": "underPromotion", "en passant": "enPassant",
    "quiet": "quietMove", "defensive": "defensiveMove", "defence": "defensiveMove", "defense": "defensiveMove",
}


def _theme_names(raw) -> list[str]:
    from ml.puzzles.retriever import get_index
    idx = get_index(); idx._load()
    if not hasattr(get_index, "_vocab"):
        get_index._vocab = {t.lower(): t for ts in idx._theme_sets for t in ts}
    vocab = get_index._vocab
    items = raw if isinstance(raw, list) else re.split(r"[,;/]| and ", str(raw or ""))
    out = []
    for item in items:
        t = str(item).strip()
        if not t:
            continue
        name = vocab.get(t.lower()) or vocab.get(t.replace(" ", "").lower()) or THEME_ALIASES.get(t.lower())
        if not name:
            for alias, theme in THEME_ALIASES.items():
                if alias in t.lower():
                    name = theme
                    break
        if name and name not in out:
            out.append(name)
    return out


def get_puzzle(s: Session, themes: list[str] | str | None = None, theme: str = "", rating: int | None = None) -> dict:
    """Pick a Lichess puzzle matching ALL requested themes near the target rating."""
    import random
    from ml.puzzles.retriever import get_index
    want = _theme_names(themes or []) + [t for t in _theme_names(theme) if t not in _theme_names(themes or [])]
    target = int(rating or s.puzzle_rating)
    idx = get_index(); idx._load()
    pool: list[int] = []
    for width in (150, 300, 600, 3000):
        pool = [i for i in range(len(idx._meta))
                if abs(int(idx._ratings[i]) - target) <= width and idx._ids[i] not in s.seen_puzzles
                and (not want or set(want) <= idx._theme_sets[i])]
        if pool:
            break
    note = ""
    if not pool and want:   # nothing has every theme: fall back to any of them
        pool = [i for i in range(len(idx._meta)) if idx._theme_sets[i] & set(want) and abs(int(idx._ratings[i]) - target) <= 400]
        note = "No puzzle had all requested themes together; this one has at least one."
    if not pool:
        return {"found": False, "message": f"No puzzle found for themes {want or 'any'} near {target}."}
    m = idx._meta[random.choice(pool)]
    uci = (m["moves"] or "").split()
    board = chess.Board(m["fen"])
    if uci:
        board.push_uci(uci[0])   # Lichess FEN is before the opponent's setup move
    payload = {"found": True, "puzzle_id": m["puzzle_id"], "fen": board.fen(),
               "side_to_move": "white" if board.turn else "black", "solution_uci": uci[1] if len(uci) > 1 else "",
               "full_line_uci": uci, "rating": m["rating"], "themes": m["themes"], "game_url": m.get("game_url")}
    s.seen_puzzles.add(m["puzzle_id"])
    s.fens.add(board.fen())
    s.created = True
    s.emit({"type": "puzzle", "payload": payload})
    s.note(f"[{board.fen()}] puzzle {m['puzzle_id']} rating {m['rating']} themes {m['themes']} "
           f"(solution {' '.join(uci[1:3])} — never reveal unless asked)")
    return {"found": True, "shown_on_board": True, "side_to_move": payload["side_to_move"], "rating": m["rating"],
            "themes": m["themes"], **({"note": note} if note else {}),
            "instruction": "The puzzle is on the user's board. Do NOT reveal or hint the solution unless asked."}


# Famous positions. Every FEN and every move of every line was checked against the Syzygy
# tablebase (the side named in the description never spoils its result along the line).
NAMED_POSITIONS = [
    (r"lucena", "1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1", "Lucena position",
     "Rook + pawn on the 7th vs rook: White cuts the king off, then builds a bridge with the rook on the 4th rank "
     "to shield the king from checks. Win for White.",
     ["Rd1+", "Ke7", "Rd4", "Ra1", "Kc7", "Rc1+", "Kb6", "Rb1+", "Kc6", "Rc1+", "Kb5", "Rb1+", "Rb4"]),
    (r"philidor", "4k3/R7/1r6/3KP3/8/8/8/8 w - - 0 1", "Philidor position",
     "Defender's king on the queening square, rook on the 6th rank keeps the white king out. Once the pawn "
     "advances to the 6th, the rook drops to the 1st rank and checks from behind. Draw.",
     ["e6", "Rb1", "Kd6", "Rd1+", "Ke5", "Re1+"]),
    (r"vancura", "R7/6k1/P4r2/8/8/8/8/6K1 w - - 0 1", "Vancura position",
     "Rook + a-pawn vs rook: the defending rook attacks the pawn from the side, so a7 is met by ...Ra6 and the "
     "pawn falls. Draw.", ["a7", "Ra6", "Rb8", "Rxa7"]),
    (r"saavedra", "8/8/1KP5/3r4/8/8/8/k7 w - - 0 1", "Saavedra position",
     "Famous study: the king escapes the checks, and c8=R! (not c8=Q, which allows ...Rc4+ and stalemate) wins.",
     ["c7", "Rd6+", "Kb5", "Rd5+", "Kb4", "Rd4+", "Kb3", "Rd3+", "Kc2", "Rd4", "c8=R", "Ra4", "Kb3"]),
    (r"r[eé]ti", "7K/8/k1P5/7p/8/8/8/8 w - - 0 1", "Réti study",
     "The white king walks the diagonal, chasing the h-pawn and supporting its own pawn at the same time. Draw.",
     ["Kg7", "h4", "Kf6", "Kb6", "Ke5", "Kxc6", "Kf4"]),
    (r"wrong[- ](colou?r(ed)?[- ])?bishop|rook pawn.{0,20}bishop", "7k/8/6KP/8/8/3B4/8/8 w - - 0 1",
     "Wrong-colour bishop", "Bishop + rook pawn whose queening square (h8, dark) the light bishop can't control: "
     "the defending king sits in the corner. Draw.", ["h7"]),
    (r"queen (vs|against|versus) (a )?(bishop|c|f)[- ]?pawn", "K7/8/8/8/8/1Q6/5pk1/8 w - - 0 1",
     "Queen vs bishop pawn on the 7th", "The defender draws with a stalemate trick around the corner.", []),
    (r"queen (vs|against|versus) (a )?(knight|b|g|centre|center|d|e)[- ]?pawn|queen (vs|against) (a )?pawn",
     "K7/8/8/8/8/1Q6/6pk/8 w - - 0 1", "Queen vs knight pawn on the 7th",
     "The queen forces the king in front of the pawn with checks, gaining time to bring her king closer. Win.",
     ["Qb2", "Kh1", "Qh8+", "Kg1", "Qf6", "Kh1", "Qh4+", "Kg1"]),
    (r"square (of|rule)|rule of the square", "8/8/8/k7/8/8/7P/7K b - - 0 1", "Rule of the square",
     "Black's king is outside the square of the h-pawn, so it cannot catch it: the pawn queens.",
     ["Ka4", "h4", "Kb3", "h5", "Kc4", "h6", "Kd5", "h7", "Ke6", "h8=Q"]),
]


def _named_position(name: str) -> tuple[str, str, str, list[str]] | None:
    low = name.lower()
    for pattern, fen, label, desc, line in NAMED_POSITIONS:
        if re.search(pattern, low):
            return fen, label, desc, line
    # Curated practice corpus: best keyword overlap with its descriptions.
    try:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "data", "endgame_positions.json")
        with open(path, encoding="utf-8") as fh:
            entries = json.load(fh)
    except Exception:
        return None
    words = {w for w in re.findall(r"[a-z]{4,}", low) if w not in {"position", "endgame", "ending", "show", "with", "please"}}
    best, score = None, 0
    for e in entries:
        hits = len(words & set(re.findall(r"[a-z]{4,}", e.get("description", "").lower())))
        if hits > score:
            best, score = e, hits
    if best and score:
        return best["fen"], best["description"].split("—")[0].strip()[:60], best["description"], []
    return None


def setup_position(s: Session, name: str = "", fen: str = "", moves: list[str] | None = None, label: str = "") -> dict:
    """Put a position on the user's board: a named/theory position, a FEN, or opening moves."""
    line = {"san": [], "uci": [], "fens": []}
    desc = ""
    if fen:
        board = chess.Board(fen)
        if not board.is_valid():
            return {"error": "That FEN is not a legal position."}
        title = label or "Position"
    elif moves:
        board = chess.Board()
        line["fens"].append(board.fen())
        for text in moves[:40]:
            try:
                mv = _parse_move(board, str(text))
            except ValueError as exc:
                return {"error": f"Stopped after {' '.join(line['san']) or 'no moves'}: {exc}"}
            line["san"].append(board.san(mv)); line["uci"].append(mv.uci()); board.push(mv); line["fens"].append(board.fen())
        title = label or ("Opening: " + E.numbered(chess.Board(), line["san"][:8]))
    elif name:
        found = _named_position(name)
        if not found:
            return {"found": False, "message": f"No curated position called '{name}'. Use material_setup for a "
                                               "material description, or ask the user for a FEN."}
        board = chess.Board(found[0])
        title, desc = label or found[1], found[2]
        if found[3]:   # the verified main line: steppable on the board and quotable by the model
            b = board.copy()
            line["fens"].append(b.fen())
            for san in found[3]:
                mv = b.parse_san(san)
                line["san"].append(b.san(mv)); line["uci"].append(mv.uci()); b.push(mv); line["fens"].append(b.fen())
    else:
        return {"error": "Give a name, a FEN or opening moves."}
    s.fen = board.fen()
    s.fens.add(board.fen()); s.fens.update(line["fens"])
    s.sans.update(x.rstrip("+#") for x in line["san"])
    s.created = True
    s.emit({"type": "position", "fen": board.fen(), "label": title[:60],
            "line": line if line["san"] else None, "offer": ["play", "explain"]})
    out = {"shown_on_board": True, "label": title, "fen": board.fen(),
           "side_to_move": F.COLOR[board.turn], "material": F.material(board)["summary"]}
    if desc:
        out["about"] = desc
    if name and line["san"]:
        out["main_line"] = E.numbered(board, line["san"])
        out["main_line_source"] = "textbook line, every move checked with the Syzygy tablebase"
        s.add_line(title + ": main line", board.fen(), line["san"], line["fens"], line["uci"])
    if len(board.piece_map()) <= 7:
        tb = tablebase(s, board.fen())
        if tb.get("verdict_for_side_to_move"):
            out["tablebase_result_for_side_to_move"] = tb["verdict_for_side_to_move"]
    s.note(f"[{board.fen()}] set up {title}" + (f" ({out.get('tablebase_result_for_side_to_move')})"
                                                if out.get("tablebase_result_for_side_to_move") else ""))
    return out


PIECE_KEYS = ("Q", "R", "B", "N", "P")
PIECE_MAX = {"Q": 1, "R": 2, "B": 2, "N": 2, "P": 8}   # same limits as the Endgames practice editor


def _counts(raw) -> dict[str, int]:
    out = {k: 0 for k in PIECE_KEYS}
    if isinstance(raw, dict):
        for k, v in raw.items():
            key = str(k).strip().upper()[:1]
            key = {"K": ""}.get(key, key)
            if key in out:
                try:
                    out[key] = max(0, min(PIECE_MAX[key], int(v)))
                except (TypeError, ValueError):
                    pass
    return out


def material_setup(s: Session, white: dict | None = None, black: dict | None = None,
                   user_color: str = "white", label: str = "") -> dict:
    """Open the position editor pre-filled with a material balance; the user confirms it."""
    w, b = _counts(white), _counts(black)
    if sum(w.values()) + sum(b.values()) == 0:
        return {"error": "Give at least one piece besides the kings."}
    color = "black" if str(user_color).lower().startswith("b") else "white"
    balanced = w == b
    s.created = True
    s.emit({"type": "configurator", "white": w, "black": b, "user_color": color, "label": label[:60]})
    s.note(f"material editor opened: White {w} vs Black {b} ({'balanced' if balanced else 'unbalanced'})")
    return {"shown_to_user": True, "balanced": balanced,
            "instruction": "An editor with these counts is in the chat; the user adjusts it and generates the "
                           "position (an equal one when material is balanced). No position exists yet — don't describe one."}


def start_game(s: Session, user_color: str = "white", from_current_board: bool = False, fen: str | None = None) -> dict:
    board = chess.Board(fen) if fen else (chess.Board(s.fen) if from_current_board else chess.Board())
    if not board.is_valid() or board.is_game_over():
        return {"error": "That position can't be played from."}
    color = "black" if str(user_color).lower().startswith("b") else "white"
    s.created = True
    s.emit({"type": "play", "fen": board.fen(), "user_color": color, "engine": "maia", "elo": s.maia_elo})
    user_to_move = (board.turn == chess.WHITE) == (color == "white")
    return {"started": True, "user_plays": color, "opponent": f"Maia (human-like engine, ~{s.maia_elo}; the user "
            f"can change it with the slider)", "fen": board.fen(),
            "instruction": "Tell the user to make their move." if user_to_move else "Maia moves first."}


WIKI = "https://en.wikipedia.org/w/api.php"
# Wikimedia asks API clients to identify themselves with contact details (FORKED_CONTACT = an email or URL);
# anonymous-looking clients are rate-limited much harder.
WIKI_HEADERS = {"User-Agent": f"Forked-Coach/1.0 (chess coaching app; {os.getenv('FORKED_CONTACT', 'no contact set')})"}


def _wiki_get(params: dict) -> dict:
    resp = requests.get(WIKI, params={**params, "format": "json"}, headers=WIKI_HEADERS, timeout=8)
    if resp.status_code == 429:
        raise RuntimeError("Wikipedia is rate-limiting us right now")
    resp.raise_for_status()
    return resp.json()
STOP = {"the", "a", "an", "of", "is", "was", "who", "what", "when", "where", "did", "does", "and", "in", "on",
        "for", "to", "his", "her", "their", "chess", "about", "tell", "me", "with"}
ASPECT = STOP | {"wife", "husband", "married", "marriage", "spouse", "girlfriend", "boyfriend", "partner", "born",
                 "birthday", "age", "old", "children", "kids", "daughter", "son", "parents", "family", "rating",
                 "elo", "peak", "nationality", "from", "lives", "live", "height", "net", "worth", "coach", "trainer"}


def wiki_lookup(s: Session, query: str) -> dict:
    """Facts about real people, events and history from Wikipedia (official API, no key).
    Returns the lead summary plus the sections that match the question's words."""
    q = (query or "").strip()
    if not q:
        return {"error": "Give a search query."}
    # Search for the subject; words like "wife"/"born" only choose the sections afterwards.
    subject = " ".join(w for w in re.split(r"\s+", re.sub(r"['’]s\b", "", q)) if w.lower().strip("?,.") not in ASPECT) or q
    try:
        hits = E._cached(("wiki-search", subject.lower()), lambda: _wiki_get({
            "action": "query", "list": "search", "srsearch": subject, "srlimit": 3}))["query"]["search"]
        if not hits:
            return {"found": False, "message": "Nothing on Wikipedia for that; say you are not sure rather than guess."}
        # Prefer the article whose title is the subject ("Vidit Gujrathi"), not a list that mentions it.
        qwords = set(re.findall(r"[a-z0-9]{3,}", subject.lower()))
        hits.sort(key=lambda h: (-len(qwords & set(re.findall(r"[a-z0-9]{3,}", h["title"].lower()))),
                                 h["title"].lower().startswith("list of")))
        title = hits[0]["title"]
        pages = E._cached(("wiki-page", title), lambda: _wiki_get({
            "action": "query", "prop": "extracts", "explaintext": 1, "titles": title, "redirects": 1}))["query"]["pages"]
        text = next(iter(pages.values())).get("extract") or ""
    except Exception as exc:
        return {"error": f"Couldn't check Wikipedia ({exc if isinstance(exc, RuntimeError) else type(exc).__name__}). "
                         "Tell the user you couldn't verify this right now instead of answering from memory."}
    parts = re.split(r"\n(={2,4}[^=\n]+={2,4})\n", text)
    lead = parts[0].strip()[:900]
    words = {w for w in re.findall(r"[a-z]{3,}", q.lower()) if w not in STOP}
    synonyms = {"wife": ["married", "wife", "spouse", "personal"], "husband": ["married", "husband", "spouse", "personal"],
                "married": ["married", "personal"], "born": ["born", "early"], "coach": ["coach", "trainer"]}
    for w in list(words):
        words.update(synonyms.get(w, []))
    sections = []
    for i in range(1, len(parts) - 1, 2):
        heading, body = parts[i].strip("= ").strip(), parts[i + 1]
        score = sum(body.lower().count(w) + 3 * heading.lower().count(w) for w in words)
        if score:
            sections.append((score, heading, body.strip()))
    sections.sort(key=lambda x: -x[0])
    out = {"found": True, "title": title, "url": f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}",
           "summary": lead, "relevant_sections": {h: b[:900] for _, h, b in sections[:2]},
           "instruction": "Answer from this text. If it doesn't contain the answer, say Wikipedia doesn't say."}
    s.note(f"wikipedia: {title}")
    return out


def show_line(s: Session, moves: list[str] | None = None, label: str = "") -> dict:
    """General mode: play a line from the starting position and show it on the board."""
    return explore_line(s, moves=moves, fen=chess.STARTING_FEN, show=True, label=label or "Line")


def _user_settings(username: str) -> dict:
    from ml.config import DATA_DIR
    try:
        return json.loads((DATA_DIR / "output" / f"{username}_settings.json").read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_warmup_plan(s: Session, time_control: str = "blitz", minutes: int = 5) -> dict:
    """Today's composed warm-up for this player (Warm-Up section), compact."""
    from backend.warmup.composer import compose, plan_summary
    if not s.username or s.username == "Guest":
        return {"error": "no player loaded -- the warm-up needs a username"}
    settings = _user_settings(s.username)
    tc = time_control if time_control in ("bullet", "blitz", "rapid", "classical") else "blitz"
    plan = compose(username=s.username, platform=settings.get("platform", "chesscom"), time_control=tc,
                   minutes=min((3, 5, 10), key=lambda m: abs(m - int(minutes or 5))), fallback_rating=settings.get("elo"))
    return {**plan_summary(plan), "where": "Practice -> Warm-Up (/warmup)"}


def get_warmup_stats(s: Session, period: int = 30) -> dict:
    """Warm-up drill accuracy / speed trends and the games played after warm-ups."""
    from backend.warmup.router import user_stats
    if not s.username or s.username == "Guest":
        return {"error": "no player loaded"}
    st = user_stats(s.username, max(1, min(365, int(period or 30))))
    st["note"] = ("games_after compares warm-up vs no-warm-up games; only claim a difference when enough_data is true")
    return st


HANDLERS = {
    "analyze_position": analyze_position, "evaluate_moves": evaluate_moves,
    "opponent_threats": opponent_threats, "position_features": position_features,
    "explore_line": explore_line, "opening_explorer": opening_explorer,
    "find_master_game": find_master_game, "tablebase": tablebase, "review_game": review_game,
    "opening_theory": opening_theory, "endgame_theory": endgame_theory,
    "get_puzzle": get_puzzle, "start_game": start_game, "setup_position": setup_position,
    "material_setup": material_setup, "show_line": show_line, "wiki_lookup": wiki_lookup,
    "get_warmup_plan": get_warmup_plan, "get_warmup_stats": get_warmup_stats,
}

LABELS = {
    "analyze_position": "Analysing the position", "evaluate_moves": "Comparing moves",
    "opponent_threats": "Checking the opponent's threats", "position_features": "Reading the structure",
    "explore_line": "Playing out the line", "opening_explorer": "Checking the opening database",
    "find_master_game": "Searching master games", "tablebase": "Consulting the tablebase",
    "review_game": "Reviewing the game", "opening_theory": "Checking opening theory",
    "endgame_theory": "Checking endgame theory", "get_puzzle": "Finding a puzzle", "start_game": "Setting up a game vs Maia",
    "setup_position": "Setting up the position", "material_setup": "Opening the position editor",
    "show_line": "Showing the line", "wiki_lookup": "Checking Wikipedia",
    "get_warmup_plan": "Building today's warm-up", "get_warmup_stats": "Reading your warm-up history",
}


def _fn(name, desc, props=None, required=None):
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
        "type": "object", "properties": props or {}, "required": required or []}}}


FEN = {"type": "string", "description": "FEN; omit to use the user's current board"}
MOVES = {"type": "array", "items": {"type": "string"}, "description": "SAN moves, e.g. [\"Nf3\",\"d5\"]"}
COUNTS = {"type": "object", "description": "piece counts besides the king, e.g. {\"R\":1,\"P\":2}",
          "properties": {k: {"type": "integer"} for k in PIECE_KEYS}}
SCHEMAS = {
    "analyze_position": _fn("analyze_position", "Stockfish MultiPV: evaluation, top candidate moves with lines, what each does and verified tactic motifs; current tactics (loose pieces, pins, checks).",
                            {"fen": FEN, "lines": {"type": "integer", "description": "candidates 1-5, default 3"}}),
    "evaluate_moves": _fn("evaluate_moves", "Judge specific moves vs the engine's best: verdict, eval after, opponent's best reply/refutation, what each move does, motifs. Use for 'why is X good/bad', 'X or Y?', and to test the natural alternative (counterfactual).",
                          {"moves": MOVES, "fen": FEN}, ["moves"]),
    "opponent_threats": _fn("opponent_threats", "What the opponent threatens if ignored (null-move probe), your pieces en prise, pins, opponent checks. Use for prophylaxis/defence questions.", {"fen": FEN}),
    "position_features": _fn("position_features", "Exact positional facts: pawn weaknesses, passed pawns, king safety, open files, outposts, bad bishops, space, mobility, development.", {"fen": FEN}),
    "explore_line": _fn("explore_line", "Play a legal sequence from the board (what-if), evaluate the end position and show it on the user's board.",
                        {"moves": MOVES, "fen": FEN, "show": {"type": "boolean"}, "label": {"type": "string"}}),
    "opening_explorer": _fn("opening_explorer", "Opening name and real statistics from Lichess masters and club games for this position, plus famous games that reached it.", {"fen": FEN}),
    "find_master_game": _fn("find_master_game", "Find and load a real historical game from the Masters database. Give surnames, year, and the opening moves you believe were played (verification walks them).",
                            {"white": {"type": "string"}, "black": {"type": "string"}, "year": {"type": "integer"}, "moves": MOVES}, []),
    "tablebase": _fn("tablebase", "Perfect-play Syzygy result for positions with <=7 pieces.", {"fen": FEN}),
    "review_game": _fn("review_game", "Engine review of a whole game (PGN or the loaded game): accuracy, critical moments, better moves. Takes ~10-20 s.", {"pgn": {"type": "string"}}),
    "opening_theory": _fn("opening_theory", "Curated opening knowledge (plans, structures, typical ideas).", {"query": {"type": "string"}, "eco": {"type": "string"}}, ["query"]),
    "endgame_theory": _fn("endgame_theory", "Curated endgame technique (key positions, rules of thumb).", {"query": {"type": "string"}}, ["query"]),
    "get_puzzle": _fn("get_puzzle", "Put a Lichess puzzle on the user's board. Themes are Lichess theme names; all must match.",
                      {"themes": {"type": "array", "items": {"type": "string"}}, "rating": {"type": "integer", "description": "omit for the player's level"}}),
    "setup_position": _fn("setup_position", "Put a position on the user's board: a named/theory position (name), a FEN, or opening moves from the start (moves).",
                          {"name": {"type": "string"}, "fen": {"type": "string"}, "moves": MOVES, "label": {"type": "string"}}),
    "material_setup": _fn("material_setup", "Open the position editor pre-filled with piece counts for each side (kings implied); the user adjusts and generates a position (equal if material is balanced).",
                          {"white": COUNTS, "black": COUNTS, "user_color": {"type": "string", "enum": ["white", "black"]},
                           "label": {"type": "string"}}, ["white", "black"]),
    "start_game": _fn("start_game", "Start a game against Maia (human-like engine) on the board — from the start, or from the current board if the user says 'this position' / 'from here'.",
                      {"user_color": {"type": "string", "enum": ["white", "black"]},
                       "from_current_board": {"type": "boolean"}, "fen": {"type": "string"}}),
    "show_line": _fn("show_line", "Play a line of moves from the starting position and show it on the board (checks legality).",
                     {"moves": MOVES, "label": {"type": "string"}}, ["moves"]),
    "wiki_lookup": _fn("wiki_lookup", "Look up real people, events, tournaments, records and chess history on Wikipedia. "
                       "Use it for any factual question about the real world instead of answering from memory.",
                       {"query": {"type": "string", "description": "e.g. 'Vidit Gujrathi' or '1972 World Chess Championship'"}},
                       ["query"]),
}
SCHEMAS["get_warmup_plan"] = _fn(
    "get_warmup_plan", "The player's pre-game warm-up for today (Practice -> Warm-Up): drills chosen for their rating band, "
    "time control and the blunder patterns found in their own games, with why. Use when they ask how to warm up / "
    "prepare before playing.",
    {"time_control": {"type": "string", "enum": ["bullet", "blitz", "rapid", "classical"]},
     "minutes": {"type": "integer", "description": "3, 5 or 10"}})
SCHEMAS["get_warmup_stats"] = _fn(
    "get_warmup_stats", "The player's warm-up history: drill accuracy and speed trends, and blunders per 40 moves in games "
    "after a warm-up vs without. Never claim warm-ups work unless enough_data is true.",
    {"period": {"type": "integer", "description": "days, default 30"}})
WARMUP_RE = re.compile(r"warm.?up|before (my|a|the|playing)|pre-?game|routine|tilt|drills? (score|accuracy)", re.I)

CORE = ["analyze_position", "evaluate_moves", "opponent_threats", "position_features", "explore_line"]


def select_tools(message: str, session: Session, intent: str = "position") -> list[dict]:
    """Tool schemas for this intent. The set is stable per intent (good for prompt
    caching); a few extras are added only when the message calls for them."""
    m = message.lower()
    if intent == "general":
        names = ["wiki_lookup", "opening_theory", "endgame_theory", "find_master_game", "show_line", "setup_position"]
    elif intent == "create":
        names = ["get_puzzle", "setup_position", "material_setup", "start_game", "analyze_position",
                 "evaluate_moves", "explore_line", "tablebase", "endgame_theory", "opening_theory"]
    else:
        names = list(CORE)
        board = chess.Board(session.fen)
        if board.fullmove_number <= 15 or re.search(r"opening|defen[cs]e|gambit|variation|theory|repertoire|famous|master|played", m):
            names += ["opening_explorer", "opening_theory"]
        if re.search(r"game|karpov|kasparov|carlsen|fischer|tal\b|vs\.?|versus|famous|historical|\b1[89]\d\d\b|\b20\d\d\b", m):
            names += ["find_master_game"]
        if session.game_pgn or re.search(r"review|analy[sz]e (my|this|the) game|pgn|\[event|1\.\s*[a-h1-8nbrqk]", m):
            names.append("review_game")
        if len(board.piece_map()) <= 7 or "endgame" in m or "tablebase" in m:
            names += ["tablebase", "endgame_theory"]
    if WARMUP_RE.search(m):
        names += ["get_warmup_plan", "get_warmup_stats"]
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
