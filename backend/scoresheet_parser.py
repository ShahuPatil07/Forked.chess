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

    # Strip en passant suffix, keep the move.
    s = re.sub(r"\s*e\.?p\.?$", "", s, flags=re.IGNORECASE)

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
    """Build movetext from the longest valid prefix of the validated moves."""
    parts: list[str] = []
    for m in validated:
        if not m.get("white_valid") or not m.get("white"):
            break
        parts.append(f'{m["number"]}. {m["white"]}')
        if m.get("black") and m.get("black_valid"):
            parts.append(m["black"])
        else:
            break
    return " ".join(parts).strip()


def process_scoresheet(raw_ocr: str) -> dict:
    """Full pipeline: parse -> validate -> PGN. Returns the API response dict."""
    parsed = parse_scoresheet(raw_ocr)
    validated = validate_moves_against_board(parsed)
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
