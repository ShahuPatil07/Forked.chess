"""Board-derived teaching observations and a shared, concise explanation fallback.

These observations describe changes, not a proof of a move's strategic superiority.
The engine's lines remain the source for concrete continuations.
"""
import chess

CENTRE = {chess.D4, chess.E4, chess.D5, chess.E5}


def move_observations(fen: str, uci: str) -> list[str]:
    board = chess.Board(fen)
    move = chess.Move.from_uci(uci)
    if move not in board.legal_moves:
        return []
    piece = board.piece_at(move.from_square)
    side = board.turn
    name = chess.piece_name(piece.piece_type)
    before_attacks = set(board.attacks(move.from_square))
    castle = board.is_castling(move)
    capture = board.is_capture(move)
    board.push(move)
    observations = []
    if castle:
        observations.append("Castles, moving the king off its central starting square and bringing the rook toward the center.")
    if piece.piece_type in (chess.KNIGHT, chess.BISHOP) and chess.square_rank(move.from_square) == (0 if side else 7):
        observations.append(f"Develops the {name} from the back rank.")
    gained = sorted((set(board.attacks(move.to_square)) & CENTRE) - before_attacks)
    if gained:
        observations.append(f"The {name} adds attacks on central squares {', '.join(map(chess.square_name, gained))}.")
    if piece.piece_type == chess.PAWN and move.to_square in CENTRE:
        observations.append(f"Places a pawn on {chess.square_name(move.to_square)}, occupying the center.")
    if piece.piece_type == chess.ROOK:
        file = chess.square_file(move.to_square)
        friendly = any(chess.square_file(s) == file for s in board.pieces(chess.PAWN, side))
        enemy = any(chess.square_file(s) == file for s in board.pieces(chess.PAWN, not side))
        if not friendly:
            observations.append(f"Places the rook on a {'semi-open' if enemy else 'fully open'} {chess.FILE_NAMES[file]}-file.")
    if piece.piece_type == chess.PAWN and not move.promotion:
        rank, file = chess.square_rank(move.to_square), chess.square_file(move.to_square)
        blockers = [s for s in board.pieces(chess.PAWN, not side)
                    if abs(chess.square_file(s) - file) <= 1 and ((chess.square_rank(s) > rank) if side else (chess.square_rank(s) < rank))]
        if not blockers:
            observations.append("Advances a passed pawn: there is no opposing pawn ahead on its file or neighboring files.")
    if move.promotion:
        observations.append(f"Promotes the pawn to a {chess.piece_name(move.promotion)}.")
    if not observations and not capture:
        destinations = len(board.attacks(move.to_square))
        observations.append(f"Repositions the {name} from {chess.square_name(move.from_square)} to {chess.square_name(move.to_square)}; from there it attacks {destinations} squares geometrically.")
    return observations


def teaching_evidence(result: dict) -> dict:
    if not result.get("fen"):
        return {}
    output = {}
    for candidate in result.get("candidates", []):
        output[candidate["move_uci"]] = {
            "observations": move_observations(result["fen"], candidate["move_uci"]),
            "illustrative_line": candidate["line"]["san"][:8],
            "scope": "Exact board changes and an engine-sampled line; not a proof of strategic causation.",
        }
    return output


def concise_explanation(result: dict, focus: str | None) -> str:
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
    observations = result.get("teaching", {}).get(relevant["move_uci"], {}).get("observations", [])
    if observations and not any("ends the game" in c["hypothesis"] for c in claims):
        parts.extend(observations[:2])
    line = relevant["line"]["san"][:8]
    if len(line) > 1:
        parts.append("One concrete continuation is " + ", ".join(line) + ".")
    replies = relevant.get("replies", [])
    if replies:
        parts.append("One defense I checked is " + replies[0]["move_san"] + ".")
    if played and played != best:
        parts.append("The alternative line begins " + ", ".join(best["line"]["san"][:3]) + ".")
    if result.get("status") == "partial" or result.get("warnings"):
        parts.append("This is a bounded search; close rankings may change.")
    return " ".join(parts)

