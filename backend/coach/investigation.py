"""Bounded chess investigation, independent of any language-model provider.

An engine line is evidence for an interpretation, not proof of its cause.
Only board facts and faithfully reported search observations are 'verified'.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import logging
import math
import re
import time
from typing import Callable, Literal

import chess
import chess.engine

log = logging.getLogger(__name__)
VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3,
          chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
MOVE_TOKEN = re.compile(
    r"(?<![\w/])(?:[a-h][1-8][a-h][1-8][qrbn]?|O-O(?:-O)?|"
    r"[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)(?![\w/])"
)


@dataclass(frozen=True)
class InvestigationRequest:
    fen: str
    question: str = ""
    focus_move: str | None = None
    alternative_move: str | None = None
    budget_seconds: float = 8.0
    scan_depth: int = 12
    deep_depth: int = 18
    multipv: int = 3


@dataclass
class Score:
    white_cp: int | None
    white_mate: int | None
    mover_cp: int | None
    mover_mate: int | None


@dataclass
class Line:
    uci: list[str]
    san: list[str]
    fens: list[str]
    material_change: int
    captures: list[str]
    ends_in_mate: bool
    terminal: str | None = None
    material_balance: int = 0


@dataclass
class Reply:
    move_uci: str
    move_san: str
    score: Score
    depth: int
    line: Line


@dataclass
class Candidate:
    id: str
    move_uci: str
    move_san: str
    roles: list[str]
    score: Score
    depth: int
    line: Line
    gives_check: bool
    immediate_mate: bool
    captured_piece: str | None
    attacked_targets: list[str]
    motif_hint: str | None
    legal_replies: list[str] = field(default_factory=list)
    replies: list[Reply] = field(default_factory=list)
    initial_score: Score | None = None
    refined: bool = False


@dataclass
class Claim:
    id: str
    candidate_id: str
    hypothesis: str
    status: Literal["verified", "likely", "uncertain", "rejected"]
    test: str
    supporting_evidence: list[str]
    contradicting_evidence: list[str] = field(default_factory=list)
    scope: str = ""


@dataclass
class Investigation:
    fen: str
    question: str
    side_to_move: str
    focus_move: str | None
    alternative_move: str | None
    candidates: list[Candidate] = field(default_factory=list)
    claims: list[Claim] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    status: str = "complete"
    terminal: str | None = None
    engine: dict = field(default_factory=dict)
    budget: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def parse_move(board: chess.Board, text: str) -> chess.Move:
    value = text.strip()
    try:
        move = chess.Move.from_uci(value)
    except ValueError:
        try:
            move = board.parse_san(value)
        except ValueError as exc:
            raise ValueError(f"'{value}' is not a legal move in this position.") from exc
    if move not in board.legal_moves:
        raise ValueError(f"'{value}' is not a legal move in this position.")
    return move


def moves_in_question(board: chess.Board, question: str) -> list[chess.Move]:
    found: list[chess.Move] = []
    for token in MOVE_TOKEN.findall(question):
        try:
            move = parse_move(board, token)
        except ValueError:
            continue
        if move not in found:
            found.append(move)
    return found


def score_from(info: dict, mover: chess.Color) -> Score:
    raw = info.get("score")
    if raw is None:
        return Score(None, None, None, None)
    white, root = raw.white(), raw.pov(mover)
    return Score(white.score(), white.mate(), root.score(), root.mate())


def score_key(score: Score) -> tuple[int, int]:
    if score.mover_mate is not None:
        return ((3, -score.mover_mate) if score.mover_mate > 0
                else (1, abs(score.mover_mate)))
    return (2, score.mover_cp) if score.mover_cp is not None else (0, 0)


def score_label(score: Score) -> str:
    if score.white_mate is not None:
        winner = "White" if score.white_mate > 0 else "Black"
        return f"{winner} mates in {abs(score.white_mate)}"
    if score.white_cp is None:
        return "not evaluated"
    return f"{score.white_cp / 100:+.2f} (White's perspective)"


def material(board: chess.Board, mover: chess.Color) -> int:
    return sum(VALUES[p.piece_type] * (1 if p.color == mover else -1)
               for p in board.piece_map().values())


def replay_line(board: chess.Board, pv: list[chess.Move], mover: chess.Color,
                max_plies: int = 12) -> Line:
    """Reject illegal engine output; never silently present a broken variation."""
    tmp = board.copy()
    initial = material(tmp, mover)
    uci, san, fens, captures = [], [], [tmp.fen()], []
    for move in pv[:max_plies]:
        if move not in tmp.legal_moves:
            raise ValueError("Engine returned a variation containing an illegal move.")
        notation = tmp.san(move)
        if tmp.is_capture(move):
            victim = tmp.piece_at(move.to_square)
            name = chess.piece_name(victim.piece_type) if victim else "pawn (en passant)"
            captures.append(f"{notation} captures a {name}")
        san.append(notation)
        uci.append(move.uci())
        tmp.push(move)
        fens.append(tmp.fen())
        if tmp.is_game_over(claim_draw=False):
            break
    outcome = tmp.outcome(claim_draw=False)
    return Line(uci, san, fens, material(tmp, mover) - initial,
                captures, tmp.is_checkmate(),
                f"{outcome.termination.name.lower()} ({outcome.result()})" if outcome else None,
                material(tmp, mover))


def candidate_from(board: chess.Board, info: dict, roles: list[str]) -> Candidate:
    pv = info.get("pv") or []
    if not pv:
        raise ValueError("Engine returned no candidate move for a nonterminal position.")
    move = pv[0]
    line = replay_line(board, pv, board.turn)
    after = board.copy()
    after.push(move)
    piece = after.piece_at(move.to_square)
    targets = []
    for square in sorted(after.attacks(move.to_square)):
        target = after.piece_at(square)
        if target and target.color != board.turn and target.piece_type != chess.PAWN:
            targets.append(f"{chess.piece_name(target.piece_type)} on {chess.square_name(square)}")
    captured = board.piece_at(move.to_square) if board.is_capture(move) else None
    captured_name = (chess.piece_name(captured.piece_type) if captured
                     else "pawn (en passant)" if board.is_en_passant(move) else None)
    # Legacy rules supply a hypothesis hint only, never a verified explanation.
    from ml.ingestion.threat_classifier import classify_threat
    motif = classify_threat(board.fen(), move.uci())
    candidate = Candidate(
        f"move:{move.uci()}", move.uci(), board.san(move), roles,
        score_from(info, board.turn), int(info.get("depth", 0)), line,
        after.is_check(), after.is_checkmate(), captured_name,
        targets if piece else [], motif if motif != "other" else None,
    )
    candidate.legal_replies = [after.san(m) for m in after.legal_moves] if not after.is_game_over() else []
    return candidate


def build_claims(board: chess.Board, candidates: list[Candidate]) -> list[Claim]:
    """Generate testable hypotheses, then verify them against independent replies."""
    claims: list[Claim] = []

    def add(c: Candidate, text: str, status: str, test: str,
            support: list[str], against: list[str] | None = None, scope: str = ""):
        claims.append(Claim(f"claim:{len(claims) + 1}", c.id, text, status,
                            test, support, against or [], scope))

    for c in candidates:
        line_text = " ".join(c.line.san)
        if c.immediate_mate:
            add(c, f"{c.move_san} is checkmate.", "verified",
                "Apply the legal move; check king attack and absence of legal replies.",
                [f"python-chess confirms checkmate after {c.move_san}."],
                scope="Exact board fact.")
        elif c.gives_check:
            add(c, f"{c.move_san} gives check.", "verified",
                "Apply the move and test whether the opponent's king is in check.",
                [f"python-chess confirms check after {c.move_san}."],
                scope="Check does not by itself establish that the move is good.")
            after = board.copy(); after.push_uci(c.move_uci)
            legal_replies = list(after.legal_moves)
            if legal_replies and all(after.piece_type_at(m.from_square) == chess.KING for m in legal_replies):
                add(c, f"All {len(legal_replies)} legal replies to {c.move_san} are king moves: "
                    + ", ".join(c.legal_replies) + ".", "verified",
                    "Enumerate every legal first reply and inspect the moving piece.",
                    c.legal_replies, scope="Exhaustive for one reply ply only; later continuations are not covered.")

            # For small terminal tactics, prove the concrete two-ply consequence
            # by enumerating EVERY legal reply, rather than extrapolating from
            # the two engine-sampled defenses. This exposes the fork/draw nuance.
            if len(c.line.uci) >= 3 and legal_replies:
                continuation = chess.Move.from_uci(c.line.uci[2])
                outcomes = []
                sans = []
                for reply in legal_replies:
                    branch = after.copy(); branch.push(reply)
                    if continuation not in branch.legal_moves:
                        break
                    sans.append(branch.san(continuation))
                    branch.push(continuation)
                    outcome = branch.outcome(claim_draw=False)
                    if outcome is None:
                        break
                    outcomes.append((outcome.termination.name.lower(), outcome.result()))
                if len(outcomes) == len(legal_replies) and len(set(outcomes)) == 1:
                    termination, result = outcomes[0]
                    add(c, f"After every legal first reply to {c.move_san}, {sans[0]} is legal "
                        f"and ends the game with {termination.replace('_', ' ')} ({result}).",
                        "verified", "Enumerate all first replies; replay the same continuation and check each terminal outcome.",
                        [f"Tested all {len(legal_replies)} replies: {', '.join(c.legal_replies)}."],
                        scope="Exact two-ply board proof for this continuation, independent of engine scores.")
        if c.captured_piece:
            add(c, f"{c.move_san} captures a {c.captured_piece}.", "verified",
                "Inspect the captured square, including en passant.",
                [f"The legal first move captures a {c.captured_piece}."],
                scope="A capture alone does not prove a net material win.")
        if len(c.attacked_targets) >= 2:
            add(c, f"After {c.move_san}, the moved piece attacks "
                + " and ".join(c.attacked_targets) + ".", "verified",
                "Apply the move and inspect the moved piece's attack squares.",
                c.attacked_targets,
                scope="Geometric attacks only; defenses and forced gains require search.")

        # A material-winning hypothesis is tested against an additional engine
        # search of the opponent's replies, rather than trusted from one PV.
        if c.line.material_change != 0 or c.captured_piece or len(c.attacked_targets) >= 2:
            gains = [c.line.material_change] + [r.line.material_change for r in c.replies]
            support, against = [], []
            for label, gain in [("Root line", gains[0])] + [
                    (f"Reply {r.move_san}", r.line.material_change) for r in c.replies]:
                text = f"{label}: net material change {gain:+d} for the original mover at the sampled horizon."
                (support if gain > 0 else against).append(text)
            status = ("likely" if c.replies and min(gains) > 0
                      else "uncertain" if not c.replies or any(g > 0 for g in gains)
                      else "rejected")
            add(c, f"{c.move_san} wins material against the investigated defenses.",
                status, "Re-search the opponent's strongest replies; replay each line and count net material.",
                support, against, "Sampled continuations, not all defenses or a proof of a forced material win.")

            if any(g < 0 for g in gains):
                losses = [f"{c.move_san} {' '.join(c.line.san[1:])}: {gains[0]:+d} material change."]
                losses += [f"Reply {r.move_san}: {r.line.material_change:+d} material change."
                           for r in c.replies]
                add(c, f"{c.move_san} allows the opponent to gain material in the sampled lines.",
                    "likely" if c.replies and max(gains) < 0 else "uncertain",
                    "Count net material from the original position, including sacrifices and recaptures.",
                    [s for s, g in zip(losses, gains) if g < 0],
                    [s for s, g in zip(losses, gains) if g >= 0],
                    "This could be a sound sacrifice; material loss alone does not refute a move.")

        if c.line.terminal:
            add(c, f"The displayed {c.move_san} line ends with {c.line.terminal.replace('_', ' ')}.",
                "verified", "Replay the sampled line and test its terminal board outcome.",
                [line_text], scope="Outcome of this line, not proof that all replies reach it.")

        if c.score.mover_mate is not None and c.score.mover_mate > 0 and not c.immediate_mate:
            add(c, f"{c.move_san} leads to a forced mate according to this search.", "likely",
                "Compare the root mate score with independently searched opponent replies.",
                [f"Root search reports mate in {c.score.mover_mate}.", f"Sampled line: {line_text}"],
                [f"Reply {r.move_san} did not confirm a winning mate score."
                 for r in c.replies if r.score.mover_mate is None or r.score.mover_mate <= 0],
                "Bounded engine finding; the displayed PV is not an exhaustive proof.")
            if claims[-1].contradicting_evidence:
                claims[-1].status = "uncertain"

    if len(candidates) >= 2:
        top = candidates[0]
        for other in candidates[1:]:
            same_depth = top.depth == other.depth and top.refined and other.refined
            if top.score.mover_cp is not None and other.score.mover_cp is not None:
                gap = top.score.mover_cp - other.score.mover_cp
                claim = (f"The search scores {top.move_san} {gap / 100:.2f} pawns ahead of "
                         f"{other.move_san} for {('White' if board.turn else 'Black')}.")
                add(other, claim, "verified" if same_depth else "uncertain",
                    "Compare scores from the original mover's perspective at matching completed depths.",
                    [f"{top.move_san}: {score_label(top.score)}, depth {top.depth}.",
                     f"{other.move_san}: {score_label(other.score)}, depth {other.depth}."],
                    scope="Numerical search observation, not a causal explanation. Small gaps may be noise.")
    return claims


def investigate(req: InvestigationRequest, engine=None, lock=None,
                clock: Callable[[], float] = time.monotonic) -> Investigation:
    if not math.isfinite(req.budget_seconds) or not 0.25 <= req.budget_seconds <= 15:
        raise ValueError("Analysis budget must be between 0.25 and 15 seconds.")
    if not 1 <= req.scan_depth <= req.deep_depth <= 22 or not 1 <= req.multipv <= 5:
        raise ValueError("Invalid analysis depths or candidate count.")
    try:
        if len(req.fen.strip().split()) != 6:
            raise ValueError("A complete FEN has six fields.")
        board = chess.Board(req.fen.strip())
    except ValueError as exc:
        raise ValueError("Invalid FEN. Include all six FEN fields.") from exc
    if not board.is_valid():
        raise ValueError("This FEN does not describe a legal chess position (check kings, pawns and checks).")
    mentioned = moves_in_question(board, req.question)
    focus = parse_move(board, req.focus_move) if req.focus_move else (mentioned[0] if mentioned else None)
    alt = parse_move(board, req.alternative_move) if req.alternative_move else next(
        (m for m in mentioned if m != focus), None)
    if alt and alt == focus:
        raise ValueError("Choose different focus and alternative moves.")
    started = clock()
    deadline = started + req.budget_seconds
    out = Investigation(board.fen(), req.question, "white" if board.turn else "black",
                        focus.uci() if focus else None, alt.uci() if alt else None)
    calls: list[dict] = []
    outcome = board.outcome(claim_draw=False)
    if outcome:
        out.terminal = outcome.termination.name.lower()
        out.status = "terminal"
        out.claims = [Claim("claim:1", "position", f"Game over: {out.terminal.replace('_', ' ')} ({outcome.result()}).",
                            "verified", "Check the legal board's outcome.", [outcome.result()], scope="Exact terminal board fact.")]
        out.budget = {"requested_seconds": req.budget_seconds, "elapsed_seconds": round(clock() - started, 3),
                      "engine_calls": [], "exhausted": False}
        return out
    acquired = False
    if engine is None:
        from backend.main import _sf_lock, _ensure_engine
        lock = _sf_lock
    try:
        if lock is not None:
            acquired = lock.acquire(timeout=max(0.0, deadline - clock()))
            if not acquired:
                out.status = "partial"
                out.warnings.append("The engine was busy; the analysis budget expired while waiting.")
                return out
        if engine is None:
            engine = _ensure_engine()
        out.engine = {"name": engine.id.get("name", "Stockfish"), "scan_depth": req.scan_depth,
                      "deep_depth": req.deep_depth, "multipv": req.multipv,
                      "hash_policy": "shared engine; transposition table may be warm"}

        def search(position: chess.Board, stage: str, seconds: float,
                   depth: int, count: int = 1, roots=None) -> list[dict]:
            remaining = deadline - clock()
            if remaining < 0.04:
                return []
            before = clock()
            infos = engine.analyse(position, chess.engine.Limit(depth=depth, time=min(seconds, remaining)),
                                   multipv=count, root_moves=roots)
            calls.append({"stage": stage, "elapsed_seconds": round(clock() - before, 3),
                          "requested_depth": depth, "root_moves": [m.uci() for m in roots] if roots else []})
            return infos if isinstance(infos, list) else [infos]

        initial = search(board, "candidate_scan", min(2.0, req.budget_seconds * 0.20),
                         req.scan_depth, min(req.multipv, board.legal_moves.count()))
        candidates: dict[str, Candidate] = {}
        initial_best = None
        for info in initial:
            c = candidate_from(board, info, ["candidate"])
            if initial_best is None:
                initial_best = c.move_uci
            c.initial_score = c.score
            candidates[c.move_uci] = c
        out.candidates = sorted(candidates.values(), key=lambda c: score_key(c.score), reverse=True)

        ordered = list(dict.fromkeys(
            [m.uci() for m in (focus, alt) if m] + ([initial_best] if initial_best else []) + list(candidates)))
        refine_seconds = max(0.04, (deadline - clock()) * 0.60 / max(1, len(ordered)))
        for uci in ordered:
            move = chess.Move.from_uci(uci)
            roles = ["candidate"]
            if move == focus:
                roles.append("focus")
            if move == alt:
                roles.append("alternative")
            previous = candidates.get(uci)
            infos = search(board, f"refine:{uci}", refine_seconds,
                           req.deep_depth, roots=[move])
            if infos:
                c = candidate_from(board, infos[0], roles)
                if c.move_uci != uci:
                    raise ValueError("Engine did not respect the requested root move.")
                c.initial_score = previous.score if previous else None
                c.refined = True
                candidates[uci] = c
                out.candidates = sorted(candidates.values(), key=lambda c: score_key(c.score), reverse=True)
            elif previous:
                previous.roles = roles
            else:
                out.warnings.append(f"Budget expired before {board.san(move)} could be evaluated.")

        out.candidates = sorted(candidates.values(), key=lambda c: score_key(c.score), reverse=True)
        if not out.candidates:
            out.status = "partial"
            out.warnings.append("No candidate evidence was available within the analysis budget.")
            return out
        # Investigate best, requested focus, and alternative independently. The
        # second MultiPV reply tests whether a material story survives another defense.
        relevant = list(dict.fromkeys([out.candidates[0].move_uci] +
                                       [m.uci() for m in (focus, alt) if m]))
        reply_seconds = max(0.04, (deadline - clock()) * 0.95 / max(1, len(relevant)))
        for uci in relevant:
            c = candidates.get(uci)
            if not c or c.immediate_mate:
                continue
            after = board.copy()
            after.push_uci(uci)
            if after.is_game_over():
                continue
            infos = search(after, f"verify_replies:{uci}", reply_seconds,
                           min(16, req.deep_depth), min(2, after.legal_moves.count()))
            for info in infos:
                pv = info.get("pv") or []
                if not pv:
                    continue
                # Replay from the ORIGINAL board so the first capture/sacrifice
                # and its material cost are included in every reply comparison.
                line = replay_line(board, [chess.Move.from_uci(uci)] + pv, board.turn)
                c.replies.append(Reply(pv[0].uci(), after.san(pv[0]),
                                       score_from(info, board.turn), int(info.get("depth", 0)), line))
        out.claims = build_claims(board, out.candidates)
        if any(c.depth < req.deep_depth for c in out.candidates):
            out.warnings.append("Some searches stopped before the target depth; close rankings may change.")
        if len(out.candidates) > 1 and out.candidates[0].initial_score is not None:
            best = out.candidates[0]
            if initial_best and best.move_uci != initial_best:
                out.warnings.append("The preferred move changed after deeper investigation.")
        if any(not candidates[u].replies and not candidates[u].immediate_mate
               and not chess.Board(candidates[u].line.fens[1]).is_game_over()
               for u in relevant if u in candidates):
            out.status = "partial"
            out.warnings.append("The budget did not permit independent reply checks for every requested branch.")
    except chess.engine.EngineError as exc:
        log.warning("Investigation engine failure: %s", exc)
        out.status = "partial"
        out.warnings.append("The engine stopped before the investigation finished. Available evidence is shown.")
        out.claims = build_claims(board, out.candidates)
    finally:
        if acquired:
            lock.release()
        elapsed = clock() - started
        exhausted = elapsed >= req.budget_seconds - 0.04
        out.budget = {"requested_seconds": req.budget_seconds, "elapsed_seconds": round(elapsed, 3),
                      "engine_calls": calls, "exhausted": exhausted}
        if exhausted and out.status == "complete":
            out.status = "partial"
        log.info("Position investigation status=%s candidates=%d calls=%d elapsed=%.3fs",
                 out.status, len(out.candidates), len(calls), elapsed)
    return out


def factual_explanation(result: Investigation) -> str:
    if result.terminal:
        return result.claims[0].hypothesis
    if not result.candidates:
        return " ".join(result.warnings) or "There is not enough engine evidence to recommend a move."
    top = result.candidates[0]
    side = result.side_to_move.title()
    lines = [f"The strongest move found for {side} is {top.move_san}: {score_label(top.score)}."]
    relevant = [c for c in result.candidates if c == top or "focus" in c.roles or "alternative" in c.roles]
    for c in relevant:
        lines.append(f"{c.move_san}: {' '.join(c.line.san[:8])} (depth {c.depth}).")
        selected = [cl for cl in result.claims if cl.candidate_id == c.id and
                    cl.status in ("verified", "likely") and "scores" not in cl.hypothesis]
        for claim in selected[:3]:
            lines.append(f"{claim.status.title()}: {claim.hypothesis}")
        if c.replies:
            lines.append(f"A critical reply found is {c.replies[0].move_san}; "
                         f"the line continues {' '.join(c.replies[0].line.san[1:8])}.")
    if len(relevant) > 1:
        lines.append("Comparison: " + "; ".join(f"{c.move_san} {score_label(c.score)}" for c in relevant) + ".")
    lines.extend(result.warnings)
    lines.append("Uncertain: these bounded searches do not prove a long-term strategic cause. "
                 "Material changes are measured only at the displayed line's horizon.")
    return "\n\n".join(lines)
