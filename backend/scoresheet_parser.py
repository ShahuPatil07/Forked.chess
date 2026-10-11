"""
Chess scoresheet OCR text parser.

Turns the raw text returned by an OCR engine (Google Cloud Vision or Tesseract)
into a validated list of moves and a PGN. Handles both printed and handwritten
scoresheets, common OCR substitution errors, annotation symbols, promotion,
en passant and result strings.

Used by ``backend/scoresheet.py`` (POST /api/ocr/scoresheet).
"""
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass

import chess

# Characters OCR commonly confuses. Applied conservatively, per-move, inside
# clean_move() — never as a blanket replace over the whole document.
PIECE_ALIASES = {
    "С": "B",   # Cyrillic Es -> Bishop (slon)
    "Ф": "Q",   # Cyrillic Ef -> Queen (ferz)
    "Л": "R",   # Cyrillic El -> Rook (ladya)
    "К": "K",   # Cyrillic Ka -> King/Knight prefix
    "Кр": "K",  # Russian King prefix
    "Кон": "N", # Russian Knight (kon) — best effort
}

RESULT_TOKENS = {"1-0", "0-1", "1/2-1/2", "½-½", "*"}

# Rough SAN shape used to reject garbage before we hand it to python-chess.
SAN_RE = re.compile(
    r"^(?:O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?)$"
)

# Move-number + white + (optional) black triplet. Tolerates Cyrillic piece
# letters and zeros at the start of a black castling move ("0-0").
MOVE_RE = re.compile(
    r"(\d{1,3})\s*[.)]?\s+"          # move number
    r"([A-Za-zО-Я0][^\s]*)"          # white move
    r"(?:\s+([A-Za-zО-Я0][^\s]*))?", # black move (optional)
    re.UNICODE,
)


def preprocess_ocr(raw_ocr: str) -> str:
    """Normalise whitespace and unify the dash glyphs used in castling."""
    text = raw_ocr.replace("\r", "\n")
    # Unify dash variants (en/em dash, minus sign) to ASCII hyphen.
    text = re.sub(r"[‐-―−]", "-", text)
    # Tighten "O - O" / "0 – 0" spacing so castling survives tokenisation.
    text = re.sub(r"([O0o])\s*-\s*([O0o])(?:\s*-\s*([O0o]))?", _join_castle, text)
    # Collapse newlines and runs of whitespace into single spaces.
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _join_castle(m: re.Match) -> str:
    return "O-O-O" if m.group(3) else "O-O"


def clean_move(raw: str | None) -> str | None:
    """
    Clean one raw OCR token into standard SAN, or return ``None`` if it can't
    be coerced into a plausible SAN string.
    """
    if not raw:
        return None

    s = raw.strip()

    # Remove spaces *inside* a single move so OCR/VLM splits like "Qx c7",
    # "Q xc7" or "Q x c7" collapse back to one token ("Qxc7").
    s = re.sub(r"\s+", "", s)

    # Russian/Cyrillic piece letters first (longest keys first so "Кр"/"Кон"
    # win over "К").
    for alias in sorted(PIECE_ALIASES, key=len, reverse=True):
        s = s.replace(alias, PIECE_ALIASES[alias])

    # Castling: normalise any zero/oh mix to canonical O-O / O-O-O.
    s = re.sub(r"[O0o](?:-[O0o]){1,2}", lambda m: "O-O-O" if m.group(0).count("-") == 2 else "O-O", s)

    # Digit/letter confusions that are safe because SAN never uses these
    # letters (S, l, I) — handled after castling so they don't touch O-O.
    if "O-O" not in s:
        s = s.translate(str.maketrans({"S": "5", "l": "1", "I": "1"}))

    # Strip annotations (!, ?, !?, ?!) and check/mate markers.
    s = re.sub(r"[!?]+", "", s)
    s = re.sub(r"[+#]+$", "", s)

    # Strip parenthetical annotations like "(cp)" / "(ep)" (en-passant marks).
    s = re.sub(r"\([^)]*\)", "", s)

    # Strip en passant suffix, keep the move.
    s = re.sub(r"\s*e\.?p\.?$", "", s, flags=re.IGNORECASE)

    # Case normalisation so a mis-cased read still parses:
    #   uppercase capture mark "X" -> "x"; destination/disambiguation file
    #   letters lowercase ("QxC7" -> "Qxc7"); a clearly-mis-cased leading piece
    #   letter (q/r/n/k — never a file) -> uppercase ("qxc7" -> "Qxc7"). 'b' is
    #   left alone since lowercase 'b' is a legitimate pawn file (bxc3).
    s = s.replace("X", "x")
    s = re.sub(r"([A-H])(?=[1-8])", lambda m: m.group(1).lower(), s)
    if s[:1] in "qrnk":
        s = s[0].upper() + s[1:]
    # Uppercase the promotion piece ("e8=q" -> "e8=Q").
    s = re.sub(r"=([qrbn])$", lambda m: "=" + m.group(1).upper(), s)

    # Promotion without '=' (e8Q -> e8=Q).
    s = re.sub(r"^([a-h]x?[a-h]?1?8?)([QRBN])$", r"\1=\2", s)

    if s in RESULT_TOKENS:
        return None

    if not SAN_RE.match(s):
        return None

    return s or None


def parse_scoresheet(raw_ocr: str) -> list[dict]:
    """Extract ``{number, white, black, white_raw, black_raw}`` rows."""
    text = preprocess_ocr(raw_ocr)
    moves: list[dict] = []

    for match in MOVE_RE.finditer(text):
        number = int(match.group(1))
        white_raw = match.group(2)
        black_raw = match.group(3)

        # A result token in the white slot means the game is over.
        if white_raw in RESULT_TOKENS:
            break

        moves.append(
            {
                "number": number,
                "white": clean_move(white_raw),
                "black": clean_move(black_raw) if black_raw else None,
                "white_raw": white_raw,
                "black_raw": black_raw,
            }
        )

    return moves


# ── Legality-constrained correction ───────────────────────────────────────────
#
# Handwriting OCR is noisy, but at any position there are only ~30 legal moves.
# Matching each OCR token to the closest legal SAN auto-corrects most glyph
# errors (Mf3->Nf3, BbS->Bb5, 0-0->O-O) and works for ANY scoresheet because it
# is driven by chess rules, not by recognising specific layouts.


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _norm_for_match(s: str) -> str:
    """Strip OCR/notation noise so two SANs can be compared by edit distance."""
    s = re.sub(r"\([^)]*\)", "", s)
    s = re.sub(r"[+#!?=x\s]", "", s)
    if s and s[0] in "KQRBNkqrbn" and len(s) > 1:
        s = s[0].upper() + s[1:]
    return s


# Structured move features: (kind, piece, dest). ``piece`` is 'P' for a pawn
# move, one of KQRBN for a known piece, or '?' for a piece move whose leading
# letter was misread (e.g. an OCR'd "Mf3"). Comparing these is far more reliable
# than raw edit distance because the destination square OCRs well and the
# pawn-vs-piece distinction is carried by the presence of a leading letter.
# Glyph confusions for the leading piece letter (Latin + Cyrillic).
PIECE_LEAD_FIX = {
    "M": "N", "H": "N", "И": "N",  # N is the classic OCR victim
    "Ф": "Q", "О": "Q",            # Cyrillic / circle -> Queen
    "Л": "R",                       # Cyrillic El -> Rook
    "К": "K", "Я": "K",
    "С": "B",                       # Cyrillic Es -> Bishop
}


def _move_features(s: str) -> tuple:
    s = re.sub(r"\([^)]*\)", "", s).strip()
    if re.fullmatch(r"[O0o]-?[O0o]-[O0o][+#]?", s):
        return ("OOO",)
    if re.fullmatch(r"[O0o]-?[O0o][+#]?", s):
        return ("OO",)
    squares = re.findall(r"[a-hA-H][1-8]", s)
    dest = squares[-1].lower() if squares else None
    lead = s[0] if s else ""
    lead_fixed = PIECE_LEAD_FIX.get(lead, lead)
    if lead_fixed in "KQRBN":
        piece = lead_fixed
    elif lead.isalpha() and lead.isupper():
        piece = "?"  # piece move, exact piece misread
    else:
        piece = "P"
    return ("m", piece, dest)


def _feat_compatible(tf: tuple, cf: tuple) -> bool:
    if tf[0] != cf[0]:
        return False
    if tf[0] != "m":  # castling kinds already equal
        return True
    _, tp, td = tf
    _, cp, cd = cf
    if td is None or td != cd:
        return False
    token_piece = tp != "P"
    cand_piece = cp != "P"
    if token_piece != cand_piece:
        return False
    if not token_piece:
        return True
    return tp == "?" or tp == cp


def best_legal_match(board: chess.Board, token: str | None) -> str | None:
    """Return the legal SAN that best fits ``token``, or None if ambiguous.
    Matches on structure (destination square + pawn/piece), falling back to edit
    distance only to break ties between structurally-equivalent candidates."""
    if not token:
        return None
    tf = _move_features(token)
    cands = [
        board.san(m)
        for m in board.legal_moves
        if _feat_compatible(tf, _move_features(board.san(m)))
    ]
    if len(cands) == 1:
        return cands[0]
    if len(cands) > 1:
        nt = _norm_for_match(token)
        scored = sorted((_levenshtein(nt, _norm_for_match(s)), s) for s in cands)
        if len(scored) < 2 or scored[1][0] > scored[0][0]:
            return scored[0][1]
    return None


def _resolve(board: chess.Board, token: str | None) -> str | None:
    """Exact SAN if possible, else a legality-constrained fuzzy match."""
    if not token:
        return None
    cleaned = clean_move(token) or token
    try:
        return board.san(board.parse_san(cleaned))
    except (chess.IllegalMoveError, chess.InvalidMoveError, ValueError):
        return best_legal_match(board, cleaned)


def autocorrect_and_validate(moves: list[dict]) -> list[dict]:
    """
    Walk the game, resolving each cell's OCR token to a legal move where
    possible. The resolved SAN is written back into ``white`` / ``black`` so the
    review screen shows the corrected move; the original OCR token is kept in
    ``*_raw`` so the user can still see and edit it when no match is found.
    """
    board = chess.Board()
    out: list[dict] = []
    broken = False

    for md in moves:
        r = dict(md)
        w_tok = md.get("white") or md.get("white_raw")
        b_tok = md.get("black") or md.get("black_raw")

        if broken:
            r["white"] = w_tok
            r["black"] = b_tok
            r["white_valid"] = False
            r["black_valid"] = False
            out.append(r)
            continue

        # White
        w_san = _resolve(board, w_tok)
        if w_san:
            board.push_san(w_san)
            r["white"] = w_san
            r["white_valid"] = True
        elif w_tok:
            r["white"] = w_tok  # keep the OCR guess for the user to edit
            r["white_valid"] = False
            broken = True
        else:
            r["white"] = None
            r["white_valid"] = False
            broken = True

        # Black (only if white resolved)
        if not broken and b_tok:
            b_san = _resolve(board, b_tok)
            if b_san:
                board.push_san(b_san)
                r["black"] = b_san
                r["black_valid"] = True
            else:
                r["black"] = b_tok
                r["black_valid"] = False
                broken = True
        elif b_tok is None:
            r["black"] = None
            r["black_valid"] = True  # game may end on white's move
        else:
            r["black"] = b_tok
            r["black_valid"] = False

        out.append(r)

    return out


def validate_moves_against_board(moves: list[dict]) -> list[dict]:
    """
    Replay the moves with python-chess, marking each ply valid/invalid. Once a
    move fails to apply, every following move is flagged (the position is no
    longer trustworthy) but still returned so the user can correct it.
    """
    board = chess.Board()
    validated: list[dict] = []
    broken = False

    for move_dict in moves:
        result = dict(move_dict)

        if broken:
            result["white_valid"] = False
            result["black_valid"] = False
            result["error"] = "previous move invalid"
            validated.append(result)
            continue

        # White
        if move_dict["white"]:
            try:
                board.push(board.parse_san(move_dict["white"]))
                result["white_valid"] = True
            except (chess.IllegalMoveError, chess.InvalidMoveError, ValueError) as e:
                result["white_valid"] = False
                result["white_error"] = str(e) or "illegal move"
        else:
            result["white_valid"] = False
            result["white_error"] = "could not read from OCR"

        # Black (only attempted if white was valid)
        if result["white_valid"] and move_dict["black"]:
            try:
                board.push(board.parse_san(move_dict["black"]))
                result["black_valid"] = True
            except (chess.IllegalMoveError, chess.InvalidMoveError, ValueError) as e:
                result["black_valid"] = False
                result["black_error"] = str(e) or "illegal move"
        elif move_dict["black"] is None:
            # No black move (e.g. game ended on white's move) — acceptable.
            result["black_valid"] = True
        else:
            result["black_valid"] = False
            result["black_error"] = "could not read from OCR"

        validated.append(result)

        if not (result["white_valid"] and result["black_valid"]):
            broken = True

    return validated


def build_pgn(validated: list[dict]) -> str:
    """Build movetext from the longest valid prefix. Renumbers sequentially so a
    gappy/misread OCR move number never corrupts the PGN."""
    parts: list[str] = []
    n = 1
    for m in validated:
        if not m.get("white_valid") or not m.get("white"):
            break
        parts.append(f"{n}. {m['white']}")
        if m.get("black") and m.get("black_valid"):
            parts.append(m["black"])
        else:
            break
        n += 1
    return " ".join(parts).strip()


# ── Layout-aware parser ───────────────────────────────────────────────────────
#
# Real scoresheets (e.g. Chess4Life) are 4-column tables: [#|White|Black] for
# moves 1-25 on the left and 26-50 on the right, plus a header full of an
# address and phone number. OCR linearises all of that into one text blob, so
# the flat regex parser above mistakes address digits for move numbers and
# scrambles the columns.
#
# Instead we reconstruct the grid from word bounding boxes: find the vertical
# column(s) of sequential move numbers (1..60), then read the White / Black
# tokens sitting in each number's row band. Header/footer text has no aligned
# column of consecutive small integers, so it is ignored automatically.


@dataclass
class Word:
    text: str
    cx: float
    cy: float
    h: float


def words_from_vision(text_annotations: list[dict]) -> list[Word]:
    """Build Word list from Vision ``textAnnotations`` (skip [0], the full text)."""
    words: list[Word] = []
    for a in text_annotations[1:]:
        verts = a.get("boundingPoly", {}).get("vertices", [])
        if not verts:
            continue
        xs = [p.get("x", 0) for p in verts]
        ys = [p.get("y", 0) for p in verts]
        words.append(
            Word(
                text=a.get("description", ""),
                cx=sum(xs) / len(xs),
                cy=sum(ys) / len(ys),
                h=max(ys) - min(ys),
            )
        )
    return words


def _as_move_number(text: str) -> int | None:
    t = text.strip().rstrip(".)")
    if t.isdigit():
        v = int(t)
        if 1 <= v <= 120:   # allow long games / high right-column numbers
            return v
    return None


def _linfit(xs: list[float], ys: list[float], fallback: float) -> tuple[float, float]:
    """Least-squares slope/intercept for y = a*x + b. ``fallback`` is the slope
    used when x has no spread."""
    n = len(xs)
    sx, sy = sum(xs), sum(ys)
    sxx = sum(x * x for x in xs)
    sxy = sum(x * y for x, y in zip(xs, ys))
    denom = n * sxx - sx * sx
    if denom == 0:
        a = fallback
        return a, (sy - a * sx) / n
    a = (n * sxy - sx * sy) / denom
    if a <= 0:
        a = fallback
    return a, (sy - a * sx) / n


def parse_grid(words: list[Word]) -> list[dict]:
    """
    Reconstruct move rows from positioned words. Returns the same shape as
    ``parse_scoresheet`` (number/white/black/white_raw/black_raw), or [] if no
    move-number column can be found (caller falls back to the text parser).

    Rows are derived from the *spacing* of the move-number column (a linear fit
    of value -> y), so a single misread number doesn't drop its whole row — the
    row position is interpolated and its move tokens are still collected. This
    keeps the move sequence contiguous, which the legality-constrained corrector
    depends on.
    """
    if not words:
        return []

    line_h = statistics.median([w.h for w in words if w.h > 0] or [12])
    page_w = max(w.cx for w in words)
    col_tol = max(line_h * 1.5, page_w * 0.03)

    nums = [(w, v) for w in words if (v := _as_move_number(w.text)) is not None]
    if len(nums) < 3:
        return []

    # Cluster number words into vertical columns by x.
    nums.sort(key=lambda nw: nw[0].cx)
    columns: list[list[tuple[Word, int]]] = []
    for w, v in nums:
        if columns and abs(w.cx - columns[-1][-1][0].cx) <= col_tol:
            columns[-1].append((w, v))
        else:
            columns.append([(w, v)])

    def is_ladder(col: list[tuple[Word, int]]) -> bool:
        if len(col) < 3:
            return False
        cs = sorted(col, key=lambda nw: nw[0].cy)
        ups = sum(1 for a, b in zip(cs, cs[1:]) if b[1] > a[1])
        return ups >= len(cs) - 2

    ladders = [c for c in columns if is_ladder(c)]
    if not ladders:
        return []

    ladders.sort(key=lambda c: statistics.median([w.cx for w, _ in c]))
    col_x = [statistics.median([w.cx for w, _ in c]) for c in ladders]

    rows: dict[int, dict] = {}
    for ci, col in enumerate(ladders):
        left = col_x[ci]
        right = col_x[ci + 1] if ci + 1 < len(col_x) else float("inf")

        # Fit value -> y so we can place every row, even ones whose number OCR
        # missed. Slope fallback ~2 line-heights of pitch.
        vals = [v for _, v in col]
        cys = [w.cy for w, _ in col]
        slope, intercept = _linfit([float(v) for v in vals], cys, line_h * 2)
        vmin, vmax = min(vals), max(vals)

        # All non-number tokens that belong to this column's move cells.
        col_tokens = [
            w
            for w in words
            if _as_move_number(w.text) is None
            and w.cx > left - col_tol * 0.5
            and w.cx < right - col_tol * 0.5
        ]

        # Assign each token to its nearest row by the fitted pitch.
        groups: dict[int, list[Word]] = {}
        for w in col_tokens:
            v = round((w.cy - intercept) / slope)
            if vmin <= v <= vmax:
                groups.setdefault(v, []).append(w)

        for v in range(vmin, vmax + 1):
            toks = sorted(groups.get(v, []), key=lambda w: w.cx)
            white_raw, black_raw = _split_white_black(toks) if toks else (None, None)
            if v in rows and (rows[v]["white_raw"] or rows[v]["black_raw"]):
                continue
            rows[v] = {
                "number": v,
                "white": clean_move(white_raw) if white_raw else None,
                "black": clean_move(black_raw) if black_raw else None,
                "white_raw": white_raw,
                "black_raw": black_raw,
            }

    # Trim leading/trailing fully-empty rows (e.g. the empty right block).
    ordered = [rows[k] for k in sorted(rows)]
    while ordered and not ordered[-1]["white_raw"] and not ordered[-1]["black_raw"]:
        ordered.pop()
    while ordered and not ordered[0]["white_raw"] and not ordered[0]["black_raw"]:
        ordered.pop(0)
    return ordered


def _split_white_black(toks: list[Word]) -> tuple[str, str | None]:
    """Split a row's tokens (sorted by x) into White / Black cells at the
    largest horizontal gap. Tokens within a cell are joined."""
    if len(toks) == 1:
        return toks[0].text, None

    gaps = [(toks[i + 1].cx - toks[i].cx, i) for i in range(len(toks) - 1)]
    _, split_at = max(gaps)
    white = "".join(t.text for t in toks[: split_at + 1])
    black = "".join(t.text for t in toks[split_at + 1 :])
    return white, (black or None)


def process_scoresheet(
    raw_ocr: str,
    words: list[Word] | None = None,
    moves: list[dict] | None = None,
) -> dict:
    """Full pipeline: parse -> validate -> PGN. Returns the API response dict.

    Move source, in priority order:
      1. ``moves`` — already-structured rows from a vision LLM (no parsing needed)
      2. ``words`` — positioned OCR tokens -> layout-aware grid parser
      3. ``raw_ocr`` — flat text parser (last-resort fallback)
    """
    parsed: list[dict] = []
    if moves:
        parsed = moves
    if len(parsed) < 3 and words:
        parsed = parse_grid(words)
    if len(parsed) < 3:
        parsed = parse_scoresheet(raw_ocr)
    # Legality-constrained correction: snaps noisy OCR tokens to the nearest
    # legal move where possible (and keeps the raw token otherwise).
    validated = autocorrect_and_validate(parsed)
    pgn = build_pgn(validated)

    valid_moves = 0
    for m in validated:
        if m.get("white_valid") and m.get("black_valid"):
            valid_moves += 1

    return {
        "moves": validated,
        "total_moves": len(validated),
        "valid_moves": valid_moves,
        "pgn": pgn,
        "raw_ocr": raw_ocr,
    }
