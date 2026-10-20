"""Exact board facts for explanation: tactics-at-a-glance and positional features.

Everything here is computed from the board with python-chess — no engine, no
LLM. These are the facts a strong coach "sees" and the LLM is most likely to
hallucinate (which pieces hang, which are pinned, pawn weaknesses, open files,
king cover, outposts). Facts describe the board; they do not by themselves
prove why a move is good — the engine comparison does that.
"""
from __future__ import annotations

import chess

VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}
CENTRE = [chess.D4, chess.E4, chess.D5, chess.E5]
COLOR = {chess.WHITE: "White", chess.BLACK: "Black"}


def pname(board: chess.Board, sq: chess.Square) -> str:
    p = board.piece_at(sq)
    return f"{chess.piece_name(p.piece_type)} on {chess.square_name(sq)}" if p else chess.square_name(sq)


def material(board: chess.Board) -> dict:
    def side(c):
        return {chess.piece_name(t): len(board.pieces(t, c)) for t in (chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN)}
    w = sum(VALUES[p.piece_type] for p in board.piece_map().values() if p.color and p.piece_type != chess.KING)
    b = sum(VALUES[p.piece_type] for p in board.piece_map().values() if not p.color and p.piece_type != chess.KING)
    diff = w - b
    summary = "Material is level" if diff == 0 else f"{'White' if diff > 0 else 'Black'} is up {abs(diff)} point{'s' if abs(diff) != 1 else ''} of material"
    return {"white": side(chess.WHITE), "black": side(chess.BLACK), "balance": diff, "summary": summary}


def see(board: chess.Board, move: chess.Move, depth: int = 6) -> int:
    """Static exchange on the target square (simple recursive capture swap)."""
    victim = board.piece_at(move.to_square)
    gain = 1 if board.is_en_passant(move) else (VALUES[victim.piece_type] if victim else 0)
    if move.promotion:
        gain += VALUES[move.promotion] - 1
    if depth == 0:
        return gain
    after = board.copy(stack=False); after.push(move)
    recaptures = [m for m in after.legal_moves if m.to_square == move.to_square and after.is_capture(m)]
    if not recaptures:
        return gain
    # The opponent recaptures with the least valuable piece (standard SEE ordering).
    recaptures.sort(key=lambda m: VALUES[after.piece_type_at(m.from_square)])
    return gain - max(0, see(after, recaptures[0], depth - 1))


def loose_pieces(board: chess.Board, color: chess.Color) -> list[dict]:
    """Pieces of `color` the opponent could win right now by capturing (SEE > 0)."""
    probe = board.copy(stack=False)
    probe.turn = not color
    probe.ep_square = None
    out = []
    if probe.is_check() and not board.is_check():
        return out   # illegal probe (opponent would already be giving check); skip
    for sq, piece in board.piece_map().items():
        if piece.color != color or piece.piece_type == chess.KING:
            continue
        best = 0; by = None
        for m in probe.legal_moves:
            if m.to_square == sq:
                g = see(probe, m)
                if g > best:
                    best, by = g, m
        if best > 0:
            defended = bool(board.attackers(color, sq))
            out.append({"piece": pname(board, sq), "wins": best, "capture": probe.san(by),
                        "defended": defended})
    out.sort(key=lambda x: -x["wins"])
    return out


def pins(board: chess.Board, color: chess.Color) -> list[str]:
    """Absolute pins on `color`'s pieces (pinned to their king)."""
    out = []
    king = board.king(color)
    for sq, piece in board.piece_map().items():
        if piece.color == color and piece.piece_type != chess.KING and board.is_pinned(color, sq):
            ray = board.pin(color, sq)
            pinner = next((s for s in chess.SquareSet(ray) if board.piece_at(s) and board.color_at(s) != color
                           and board.piece_type_at(s) in (chess.BISHOP, chess.ROOK, chess.QUEEN)), None)
            out.append(f"{COLOR[color]} {pname(board, sq)} is pinned to the king"
                       + (f" by the {pname(board, pinner)}" if pinner is not None else ""))
    return out[:4]


def checks_available(board: chess.Board) -> list[str]:
    return [board.san(m) for m in board.legal_moves if board.gives_check(m)][:8]


def pawn_structure(board: chess.Board, color: chess.Color) -> dict:
    pawns = board.pieces(chess.PAWN, color)
    enemy = board.pieces(chess.PAWN, not color)
    files = [chess.square_file(s) for s in pawns]
    doubled = sorted({chess.FILE_NAMES[f] for f in files if files.count(f) > 1})
    isolated = sorted({chess.square_name(s) for s in pawns
                       if not any(chess.square_file(o) in (chess.square_file(s) - 1, chess.square_file(s) + 1) for o in pawns)})
    passed = []
    for s in pawns:
        f, r = chess.square_file(s), chess.square_rank(s)
        ahead = [o for o in enemy if abs(chess.square_file(o) - f) <= 1 and
                 (chess.square_rank(o) > r if color == chess.WHITE else chess.square_rank(o) < r)]
        if not ahead:
            passed.append(chess.square_name(s))
    backward = []
    for s in pawns:
        f, r = chess.square_file(s), chess.square_rank(s)
        step = 1 if color == chess.WHITE else -1
        support = [o for o in pawns if abs(chess.square_file(o) - f) == 1 and
                   (chess.square_rank(o) <= r if color == chess.WHITE else chess.square_rank(o) >= r)]
        front = s + 8 * step
        if not support and 0 <= front < 64 and chess.square_name(s) not in isolated and chess.square_name(s) not in passed:
            if any(board.piece_type_at(a) == chess.PAWN for a in board.attackers(not color, front)):
                backward.append(chess.square_name(s))
    islands, prev = 0, -2
    for f in sorted(set(files)):
        if f != prev + 1:
            islands += 1
        prev = f
    return {"doubled_files": doubled, "isolated": isolated, "passed": passed, "backward": backward, "islands": islands}


def files_report(board: chess.Board) -> list[str]:
    out = []
    for f in range(8):
        wp = any(chess.square_file(s) == f for s in board.pieces(chess.PAWN, chess.WHITE))
        bp = any(chess.square_file(s) == f for s in board.pieces(chess.PAWN, chess.BLACK))
        if wp and bp:
            continue
        kind = "open" if not wp and not bp else ("half-open for White" if not wp else "half-open for Black")
        heavies = [pname(board, s) for s in chess.SquareSet(chess.BB_FILES[f])
                   if board.piece_type_at(s) in (chess.ROOK, chess.QUEEN)]
        out.append(f"{chess.FILE_NAMES[f]}-file {kind}" + (f" (occupied by {', '.join(heavies)})" if heavies else ""))
    return out


def king_safety(board: chess.Board, color: chess.Color) -> str:
    k = board.king(color)
    if k is None:
        return ""
    kf, kr = chess.square_file(k), chess.square_rank(k)
    step = 1 if color == chess.WHITE else -1
    shield = 0
    for f in (kf - 1, kf, kf + 1):
        if 0 <= f < 8:
            for d in (1, 2):
                r = kr + step * d
                if 0 <= r < 8 and board.piece_at(chess.square(f, r)) == chess.Piece(chess.PAWN, color):
                    shield += 1
                    break
    zone = chess.SquareSet(chess.BB_KING_ATTACKS[k]) | chess.SquareSet(chess.BB_SQUARES[k])
    attackers = {a for sq in zone for a in board.attackers(not color, sq)}
    open_near = [chess.FILE_NAMES[f] for f in (kf - 1, kf, kf + 1) if 0 <= f < 8
                 and not any(chess.square_file(s) == f for s in board.pieces(chess.PAWN, color))]
    castled = (color == chess.WHITE and k in (chess.G1, chess.H1, chess.C1, chess.B1)) or \
              (color == chess.BLACK and k in (chess.G8, chess.H8, chess.C8, chess.B8))
    status = "castled" if castled else ("still in the centre" if kf in (3, 4) else "")
    rights = board.has_castling_rights(color)
    parts = [f"{COLOR[color]} king on {chess.square_name(k)}" + (f" ({status})" if status else ""),
             f"{shield}/3 shield pawns", f"{len(attackers)} enemy piece(s) hit squares around it"]
    if open_near:
        parts.append(f"no own pawn on the {', '.join(open_near)}-file(s) next to it")
    if not castled and rights:
        parts.append("can still castle")
    return "; ".join(parts)


def development(board: chess.Board, color: chess.Color) -> int:
    back = 0 if color == chess.WHITE else 7
    home = {chess.KNIGHT: [chess.B1, chess.G1], chess.BISHOP: [chess.C1, chess.F1]}
    count = 0
    for t, squares in home.items():
        for sq in squares:
            sq = chess.square(chess.square_file(sq), back)
            if board.piece_at(sq) == chess.Piece(t, color):
                count += 1
    return count


def outposts(board: chess.Board, color: chess.Color) -> list[str]:
    """Squares in the enemy half, protected by an own pawn, that no enemy pawn can ever attack."""
    out = []
    enemy = board.pieces(chess.PAWN, not color)
    ranks = (3, 4, 5) if color == chess.WHITE else (4, 3, 2)
    for r in ranks:
        for f in range(1, 7):
            sq = chess.square(f, r)
            if not any(board.piece_type_at(a) == chess.PAWN for a in board.attackers(color, sq)):
                continue
            can_hit = any(abs(chess.square_file(e) - f) == 1 and
                          (chess.square_rank(e) > r if color == chess.WHITE else chess.square_rank(e) < r) for e in enemy)
            if not can_hit:
                occ = board.piece_at(sq)
                tag = f" (occupied by {COLOR[color]} {chess.piece_name(occ.piece_type)})" if occ and occ.color == color and occ.piece_type in (chess.KNIGHT, chess.BISHOP) else ""
                out.append(chess.square_name(sq) + tag)
    return out[:5]


def bishops(board: chess.Board, color: chess.Color) -> list[str]:
    out = []
    bs = board.pieces(chess.BISHOP, color)
    if len(bs) >= 2 and len(board.pieces(chess.BISHOP, not color)) < 2:
        out.append(f"{COLOR[color]} has the bishop pair")
    own = board.pieces(chess.PAWN, color)
    for b in bs:
        light = (chess.square_file(b) + chess.square_rank(b)) % 2 == 1
        same = sum(1 for p in own if ((chess.square_file(p) + chess.square_rank(p)) % 2 == 1) == light)
        if len(own) >= 4 and same >= len(own) * 0.6 and same >= 4:
            out.append(f"{COLOR[color]} {'light' if light else 'dark'}-squared bishop on {chess.square_name(b)} is hemmed in by "
                       f"{same} own pawns on its colour (a 'bad' bishop)")
    return out


def mobility(board: chess.Board, color: chess.Color) -> int:
    b = board.copy(stack=False); b.turn = color; b.ep_square = None
    return sum(1 for m in b.pseudo_legal_moves if b.piece_type_at(m.from_square) != chess.PAWN)


def centre_control(board: chess.Board) -> str:
    w = sum(len(board.attackers(chess.WHITE, s)) for s in CENTRE)
    b = sum(len(board.attackers(chess.BLACK, s)) for s in CENTRE)
    return f"attacks on the four centre squares: White {w}, Black {b}"


def space(board: chess.Board, color: chess.Color) -> int:
    """Squares in the opponent's half controlled by own pawns + advanced pawns."""
    half = range(4, 8) if color == chess.WHITE else range(0, 4)
    squares = set()
    for p in board.pieces(chess.PAWN, color):
        squares |= {s for s in board.attacks(p) if chess.square_rank(s) in half}
    return len(squares)


def phase(board: chess.Board) -> str:
    non_pawn = sum(VALUES[p.piece_type] for p in board.piece_map().values() if p.piece_type not in (chess.PAWN, chess.KING))
    queens = board.pieces(chess.QUEEN, chess.WHITE) | board.pieces(chess.QUEEN, chess.BLACK)
    if non_pawn <= 20 or (not queens and non_pawn <= 26):
        return "endgame"
    # development() counts minor pieces still on their home squares.
    if board.fullmove_number <= 12 and (development(board, chess.WHITE) + development(board, chess.BLACK)) >= 3:
        return "opening"
    return "middlegame"


def tactical_snapshot(board: chess.Board) -> dict:
    stm = board.turn
    return {
        "side_to_move": COLOR[stm],
        "in_check": board.is_check(),
        "checks_available": checks_available(board),
        "your_loose_pieces": loose_pieces(board, stm),
        "opponent_loose_pieces": loose_pieces(board, not stm),
        "pins": pins(board, chess.WHITE) + pins(board, chess.BLACK),
    }


def positional_report(board: chess.Board) -> dict:
    report = {"phase": phase(board), "material": material(board)["summary"]}
    for c in (chess.WHITE, chess.BLACK):
        name = COLOR[c].lower()
        ps = pawn_structure(board, c)
        weak = []
        if ps["isolated"]: weak.append("isolated " + ", ".join(ps["isolated"]))
        if ps["doubled_files"]: weak.append("doubled on " + ", ".join(ps["doubled_files"]) + "-file")
        if ps["backward"]: weak.append("backward " + ", ".join(ps["backward"]))
        report[name] = {
            "king": king_safety(board, c),
            "pawns": f"{ps['islands']} pawn island(s)" + (f"; weaknesses: {'; '.join(weak)}" if weak else "; no structural weaknesses")
                     + (f"; passed pawn(s): {', '.join(ps['passed'])}" if ps["passed"] else ""),
            "undeveloped_minors": development(board, c) if board.fullmove_number <= 20 else None,
            "piece_mobility": mobility(board, c),
            "space": space(board, c),
            "outposts": outposts(board, c),
            "bishops": bishops(board, c),
        }
        if report[name]["undeveloped_minors"] is None:
            report[name].pop("undeveloped_minors")
    report["files"] = files_report(board)
    report["centre"] = centre_control(board)
    named = structures(board)
    if named:
        report["structures"] = named
    return report


def structures(board: chess.Board) -> list[str]:
    """Named pawn structures (exact pattern match) with their textbook plans — theory, not engine."""
    W, B = chess.WHITE, chess.BLACK

    def has(color, sq):
        return board.piece_at(chess.parse_square(sq)) == chess.Piece(chess.PAWN, color)

    def none_on(color, file_name):
        f = chess.FILE_NAMES.index(file_name)
        return not any(chess.square_file(s) == f for s in board.pieces(chess.PAWN, color))
    out = []
    for color, sq, side, other in ((W, "d4", "White", "Black"), (B, "d5", "Black", "White")):
        if has(color, sq) and none_on(color, "c") and none_on(color, "e"):
            out.append(f"{side} has an isolated queen's pawn (IQP) on {sq}: {side} wants active pieces, a kingside attack "
                       f"and the {sq[0]}-pawn advance; {other} blockades the square in front of it and trades pieces toward an endgame.")
    if has(W, "d4") and none_on(W, "c") and has(B, "d5") and has(B, "c6") and none_on(B, "e"):
        out.append("Carlsbad structure (Queen's Gambit Exchange type): White's classic plan is the minority attack b4–b5 "
                   "to leave Black a weak c-pawn (alternative: the central break f3 and e4); Black seeks kingside play "
                   "(…Ne4, …f5) or the …c5 break.")
    if has(B, "d5") and none_on(B, "c") and has(W, "d4") and has(W, "c3") and none_on(W, "e"):
        out.append("Reversed Carlsbad (e.g. Caro-Kann Exchange): Black's classic plan is the minority attack …b5–b4; "
                   "White plays on the kingside.")
    if has(W, "d5") and has(W, "e4") and has(B, "d6") and has(B, "e5"):
        out.append("Closed centre d5/e4 vs d6/e5 (King's Indian type): each side attacks where its chain points — White "
                   "on the queenside (c4–c5, b4), Black on the kingside (…f5–f4, …g5); a race on opposite wings.")
    if has(W, "d4") and has(W, "e5") and has(B, "d5") and has(B, "e6"):
        out.append("French chain d4/e5 vs d5/e6: Black attacks the base with …c5 (and …f6); White uses the kingside space "
                   "(f4–f5, a piece attack) and keeps d4 supported.")
    if has(W, "c4") and has(W, "e4") and none_on(W, "d") and has(B, "d6") and none_on(B, "c"):
        out.append("Maróczy bind (c4 + e4 vs d6): White restrains …b5 and …d5; Black regroups and aims for those breaks or …f5.")
    for color, c, d, side in ((W, "c4", "d4", "White"), (B, "c5", "d5", "Black")):
        if has(color, c) and has(color, d) and none_on(color, "b") and none_on(color, "e"):
            out.append(f"{side} has hanging pawns on {c}/{d}: strong while they can advance, targets once blockaded — "
                       f"the opponent pressures them with pieces and pawn levers.")
    for color, sqs, side, hole in ((W, ("d4", "e3", "f4"), "White", "e4"), (B, ("d5", "e6", "f5"), "Black", "e5")):
        if all(has(color, s) for s in sqs):
            out.append(f"{side} has a Stonewall ({'/'.join(sqs)}): a strong outpost for a knight in front of it, "
                       f"but a permanent hole on {hole} and a bad light-squared bishop.")
    return out


def threats_after(board: chess.Board, move: chess.Move, limit: int = 2) -> list[str]:
    """Captures that would win material if the mover could move again (exact, by static exchange),
    which were not already winning before the move — "Ng5 threatens Nxf7". Adds the fork that
    capture would create, when it attacks the king, queen or a rook."""
    mover = board.turn
    after = board.copy(stack=False); after.push(move)
    if after.is_game_over():
        return []
    probe = after.copy(stack=False); probe.turn = mover; probe.ep_square = None
    if not probe.is_valid():
        return []
    before = {m.uci(): see(board, m) for m in board.legal_moves if board.is_capture(m)}
    found = []
    for m in probe.legal_moves:
        if not probe.is_capture(m):
            continue
        gain = see(probe, m)
        if gain <= 0 or before.get(m.uci(), -99) >= gain:
            continue
        found.append((gain, m))
    out = []
    for gain, m in sorted(found, key=lambda x: -x[0])[:limit]:
        text = f"threatens {probe.san(m)} next (wins {gain} point{'s' if gain != 1 else ''} by exchange)"
        hit = probe.copy(stack=False); hit.push(m)
        big = [pname(hit, s) for s in hit.attacks(m.to_square)
               if hit.piece_at(s) and hit.color_at(s) != mover and hit.piece_type_at(s) in (chess.KING, chess.QUEEN, chess.ROOK)]
        if len(big) >= 2:
            text += f", and that capture would fork the {' and the '.join(big[:2])}"
        out.append(text)
    return out


def move_effects(board: chess.Board, move: chess.Move) -> list[str]:
    """Exact, human-level description of what a move changes on the board."""
    out = []
    mover = board.turn
    piece = board.piece_at(move.from_square)
    san = board.san(move)
    after = board.copy(stack=False); after.push(move)
    if after.is_checkmate():
        return [f"{san} is checkmate"]
    if board.is_capture(move):
        victim = "pawn" if board.is_en_passant(move) else chess.piece_name(board.piece_type_at(move.to_square))
        out.append(f"captures a {victim}")
    if after.is_check():
        out.append("gives check")
    if board.is_castling(move):
        out.append("castles the king to safety and connects the rooks")
    # New attacks by the moved piece on valuable / loose enemy pieces.
    targets = []
    for sq in after.attacks(move.to_square):
        t = after.piece_at(sq)
        if t and t.color != mover and t.piece_type != chess.PAWN:
            if t.piece_type == chess.KING:
                continue
            defended = bool(after.attackers(not mover, sq))
            if VALUES[t.piece_type] > VALUES[piece.piece_type] or not defended:
                targets.append(f"{chess.piece_name(t.piece_type)} on {chess.square_name(sq)}" + ("" if defended else " (undefended)"))
    if len(targets) >= 2:
        out.append("attacks two targets at once (double attack/fork): " + " and ".join(targets))
    elif targets:
        out.append("attacks the " + targets[0])
    # Discovered attacks: lines opened by moving away.
    for sq, p in after.piece_map().items():
        if p.color == mover and p.piece_type in (chess.BISHOP, chess.ROOK, chess.QUEEN) and sq != move.to_square:
            new = set(after.attacks(sq)) - set(board.attacks(sq))
            hit = [s for s in new if after.piece_at(s) and after.color_at(s) != mover and after.piece_type_at(s) in (chess.QUEEN, chess.ROOK, chess.KING)]
            if hit:
                out.append(f"opens a line for the {pname(after, sq)} onto the {pname(after, hit[0])} (discovered attack)")
                break
    # Pins created.
    before_pins = set(pins(board, not mover)); new_pins = [p for p in pins(after, not mover) if p not in before_pins]
    out.extend(new_pins[:1])
    # Threats created (what it would win if ignored).
    out.extend(threats_after(board, move))
    # Pieces left hanging by this move.
    hanging_before = {x["piece"] for x in loose_pieces(board, mover)}
    hanging_after = [x for x in loose_pieces(after, mover) if x["piece"] not in hanging_before]
    for h in hanging_after[:2]:
        out.append(f"leaves the {h['piece']} en prise ({h['capture']} wins {h['wins']} point{'s' if h['wins'] != 1 else ''} by static exchange)")
    # Positional effects.
    if piece.piece_type in (chess.KNIGHT, chess.BISHOP) and chess.square_rank(move.from_square) == (0 if mover else 7):
        out.append(f"develops the {chess.piece_name(piece.piece_type)}")
    if move.to_square in [chess.parse_square(s.split()[0]) for s in outposts(after, mover)] and piece.piece_type == chess.KNIGHT:
        out.append(f"plants the knight on an outpost ({chess.square_name(move.to_square)}) no enemy pawn can attack")
    if piece.piece_type == chess.PAWN:
        if move.to_square in CENTRE:
            out.append("stakes a claim in the centre")
        ps_after = pawn_structure(after, mover)["passed"]
        if chess.square_name(move.to_square) in ps_after:
            out.append("pushes a passed pawn")
        if move.promotion:
            out.append(f"promotes to a {chess.piece_name(move.promotion)}")
        # Pawn break: attacks an enemy pawn.
        if any(after.piece_type_at(s) == chess.PAWN and after.color_at(s) != mover for s in after.attacks(move.to_square)):
            out.append("challenges the enemy pawn chain (pawn break)")
        # Prophylaxis, exactly: squares the pawn now covers that enemy pieces could have jumped to.
        covered_before = set()
        for s in board.pieces(chess.PAWN, mover):
            covered_before |= set(board.attacks(s))
        probe = board.copy(stack=False); probe.turn = not mover; probe.ep_square = None
        if probe.is_valid():
            denied = {}
            for m in probe.pseudo_legal_moves:
                p = probe.piece_at(m.from_square)
                if (m.to_square in after.attacks(move.to_square) and m.to_square not in covered_before
                        and p.piece_type not in (chess.PAWN, chess.KING) and not probe.piece_at(m.to_square)):
                    denied.setdefault(chess.square_name(m.to_square), []).append(probe.san(m) if m in probe.legal_moves else None)
            for sq, moves in list(denied.items())[:1]:
                moves = [x for x in moves if x]
                if moves:
                    out.append(f"takes the {sq} square away from the enemy pieces ({', '.join('...' + x for x in moves[:2])} "
                               f"would now land on a square the pawn attacks)")
        king = board.king(mover)
        # Luft: a castled king's shield pawn steps up, freeing a square right next to the king.
        if (king is not None and chess.square_distance(king, move.from_square) == 1
                and chess.square_rank(king) == (0 if mover else 7) and chess.square_file(king) in (0, 1, 2, 6, 7)
                and abs(chess.square_file(move.from_square) - chess.square_file(king)) <= 1):
            out.append(f"gives the king a flight square on {chess.square_name(move.from_square)} (no back-rank mate worries)")
    if piece.piece_type in (chess.ROOK, chess.QUEEN) and chess.square_file(move.to_square) != chess.square_file(move.from_square):
        f = chess.square_file(move.to_square)
        own = [s for s in after.pieces(chess.PAWN, mover) if chess.square_file(s) == f]
        enemy = any(chess.square_file(s) == f for s in after.pieces(chess.PAWN, not mover))
        if not own:
            out.append(f"takes the {'half-open' if enemy else 'open'} {chess.FILE_NAMES[f]}-file")
        elif piece.piece_type == chess.ROOK:
            # Say what a rook on a CLOSED file really does (LLMs love to call it "open").
            out.append(f"the {chess.FILE_NAMES[f]}-file is closed (own pawn on {chess.square_name(own[0])}"
                       + (" and an enemy pawn" if enemy else "") + "): the rook backs up that pawn and a future pawn break, not an open file")
    if piece.piece_type == chess.KING and not board.is_castling(move) and phase(board) == "endgame":
        out.append("activates the king (an endgame strength)")
    mob_before, mob_after = mobility(board, mover), mobility(after, mover)
    if mob_after - mob_before >= 5:
        out.append(f"frees the position (piece mobility {mob_before}→{mob_after})")
    if not out:
        out.append(f"quiet move: repositions the {chess.piece_name(piece.piece_type)} from {chess.square_name(move.from_square)} to {chess.square_name(move.to_square)}")
    return out


def compare_reports(before: dict, after: dict) -> list[str]:
    """Plain-language deltas between two positional reports (same side keys)."""
    out = []
    for side in ("white", "black"):
        for key in ("king", "pawns"):
            if before.get(side, {}).get(key) != after.get(side, {}).get(key):
                out.append(f"{side} {key}: {after[side][key]}")
    if before.get("files") != after.get("files"):
        out.append("files now: " + ("; ".join(after["files"]) or "all closed"))
    return out[:6]
