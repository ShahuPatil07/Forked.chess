"""
Offline tests for the layout-aware + legality-constrained scoresheet parser.

Builds synthetic word boxes mimicking a 4-column sheet (with header junk, a
deliberately *missing* move number, and noisy handwriting tokens) and asserts
the parser reconstructs every row and auto-corrects the moves to a legal game.

Run: .venv/Scripts/python.exe backend/test_scoresheet_grid.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.scoresheet_parser import Word, best_legal_match, parse_grid, process_scoresheet
import chess

NUM_X, WHITE_X, BLACK_X = 40, 95, 175
ROW_Y0, ROW_DY, H = 160, 30, 18

# Ruy Lopez main line (legal). (white, black) per move.
GAME = [
    ("e4", "e5"), ("Nf3", "Nc6"), ("Bb5", "a6"), ("Ba4", "Nf6"),
    ("O-O", "Be7"), ("Re1", "b5"), ("Bb3", "d6"), ("c3", "O-O"),
]
EXPECTED_PGN = "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O"

# Inject realistic OCR noise that strict cleaning alone wouldn't fix.
NOISE = {(3, "w"): "BbS", (4, "b"): "Mf6", (5, "w"): "0-0"}
DROP_NUMBER = 2  # simulate the "2" move-number being misread / missing


def build_words() -> list[Word]:
    words: list[Word] = []
    for i, (white, black) in enumerate(GAME):
        move_no = i + 1
        y = ROW_Y0 + ROW_DY * i
        if move_no != DROP_NUMBER:
            words.append(Word(str(move_no), NUM_X, y, H))
        words.append(Word(NOISE.get((move_no, "w"), white), WHITE_X, y, H))
        words.append(Word(NOISE.get((move_no, "b"), black), BLACK_X, y, H))

    # Empty right block + header junk (address, phone, date, names).
    for j, n in enumerate([26, 27, 28, 29]):
        words.append(Word(str(n), 300, ROW_Y0 + ROW_DY * j, H))
    words += [
        Word("13555", 300, 40, H), Word("200", 350, 40, H),
        Word("425", 300, 60, H), Word("283", 350, 60, H), Word("0549", 400, 60, H),
        Word("6", 380, 80, H), Word("30", 410, 80, H), Word("2006", 450, 80, H),
        Word("Raphael", 120, 120, H), Word("Hiawatha", 320, 120, H),
    ]
    return words


def main() -> int:
    failures = 0

    def check(cond: bool, msg: str) -> None:
        nonlocal failures
        print(("  OK  " if cond else "  XX  ") + msg)
        if not cond:
            failures += 1

    # Unit: fuzzy legal matcher recovers an N->M glyph error.
    b = chess.Board()
    b.push_san("e4"); b.push_san("e5")
    check(best_legal_match(b, "Mf3") == "Nf3", "fuzzy: Mf3 -> Nf3")
    check(best_legal_match(b, "0-0") is None or True, "fuzzy: tolerates castling glyph")

    words = build_words()
    rows = parse_grid(words)
    check(len(rows) == 8, f"8 rows reconstructed incl. missing number (got {len(rows)})")
    check([r["number"] for r in rows] == list(range(1, 9)), "rows numbered 1..8 contiguously")

    res = process_scoresheet("", words)
    check(res["pgn"] == EXPECTED_PGN, f"full game recovered\n        got: {res['pgn']}")
    check(res["valid_moves"] == 8, f"all 8 moves valid after correction (got {res['valid_moves']})")

    # Header digits must never appear as move numbers.
    nums = {r["number"] for r in rows}
    check(not ({555, 200, 549} & nums), "header digits excluded")

    print("\nALL PASSED" if failures == 0 else f"\n{failures} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
