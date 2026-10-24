"""Scoresheet decoder: readings -> legal game, under real-world sheet messiness.

    .venv/Scripts/python -m pytest tests/test_scoresheet_decoder.py -q -p no:cacheprovider
"""
import pytest

from backend.scoresheet_decoder import cells_from_rows, decode, norm_reading
from backend.scoresheet_reader import merge_reads, parse_meta, parse_rows


def _maia():
    """Production decodes with the Maia2 human-move prior; blank cells need it."""
    from backend.scoresheet_prior import move_logprobs
    import chess
    if move_logprobs([chess.Board()]) is None:
        pytest.skip("Maia2 not available")
    return move_logprobs

RUY = ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "Re1", "b5", "Bb3", "d6", "c3", "O-O"]


def sheet(sans: list[str], edits: dict[int, str] | None = None) -> list[dict]:
    """Rows as a reader returns them, with cell `ply` replaced by edits[ply]."""
    edits = edits or {}
    rows = []
    for i in range(0, len(sans), 2):
        w = edits.get(i, sans[i])
        b = edits.get(i + 1, sans[i + 1] if i + 1 < len(sans) else "")
        rows.append({"number": i // 2 + 1, "white": w, "black": b})
    return rows


def sans_of(rows, **kw) -> list[str]:
    return [p["san"].rstrip("+#") for p in decode(cells_from_rows(rows), **kw)["plies"]]


def test_clean_sheet_is_exact():
    res = decode(cells_from_rows(sheet(RUY)))
    assert [p["san"] for p in res["plies"]] == RUY
    assert {p["status"] for p in res["plies"]} == {"exact"}


def test_handwriting_misreads_are_fixed():
    # BbS (S/5), Mf6 (M/N), 0-0 (zeros), b6 read as 66, Re1 as Rel
    edits = {4: "BbS", 7: "Mf6", 8: "0-0", 10: "Rel", 11: "65"}
    assert sans_of(sheet(RUY, edits)) == RUY


def test_player_slips_are_fixed():
    # missing disambiguation, pawn-capture shorthand, capture-by-piece-type
    game = ["d4", "d5", "c4", "e6", "Nc3", "Nf6", "cxd5", "exd5", "Bg5", "Nbd7", "e3", "Be7", "Bxf6", "Nxf6"]
    edits = {6: "cd", 9: "Nd7", 12: "BxN"}
    assert sans_of(sheet(game, edits)) == game


# 3...b5 is the only move that makes 5.axb5 legal later, so a blank there is recoverable.
SLAV = ["d4", "d5", "c4", "dxc4", "e3", "b5", "a4", "c6", "axb5", "cxb5", "Qf3", "Nc6"]


def test_forgotten_move_is_inferred_not_shifted():
    rows = sheet(SLAV)
    rows[2]["black"] = ""                              # 3...b5 never written
    out = decode(cells_from_rows(rows), prior=_maia())["plies"]
    assert [p["san"] for p in out] == SLAV            # later cells stay in their own column
    assert out[5]["status"] == "inferred" and out[5]["alternatives"]


def test_junk_cell_is_dropped():
    rows = sheet(RUY)
    rows.append({"number": 9, "white": "Resigns", "black": ""})
    res = decode(cells_from_rows(rows))
    assert [p["san"] for p in res["plies"]] == RUY
    assert res["dropped_cells"]


def test_skipped_row_numbers_become_blank_cells():
    rows = [r for r in sheet(SLAV) if r["number"] != 3]   # reader skipped row 3 entirely
    out = decode(cells_from_rows(rows), prior=_maia())["plies"]
    sans = [p["san"] for p in out]
    assert len(sans) == len(SLAV) and sans[5] == "b5" and sans[6:] == SLAV[6:]
    assert out[4]["status"] == "inferred"             # White's unwritten 3rd move is flagged, not guessed silently


def test_pin_realigns_the_rest():
    game = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "c3", "Nf6"]
    rows = sheet(game, {4: "Bb4"})                     # illegal for white: Bb5 and Bc4 both one edit away
    pinned = decode(cells_from_rows(rows), pins={4: "f1c4"})
    assert [p["san"] for p in pinned["plies"]] == game
    assert pinned["plies"][4]["status"] == "confirmed"


def test_alternatives_and_legal_moves_reported():
    res = decode(cells_from_rows(sheet(RUY, {4: "Bb6"})))
    p = res["plies"][4]
    assert p["san"] == "Bb5" and p["read"] == "Bb6" and p["alternatives"]


def test_reading_normalisation():
    assert norm_reading("0-0-0") == "O-O-O"
    assert norm_reading("o-o") == "O-O"
    assert norm_reading(" Q x c7 !? ") == "Qxc7"


def test_reader_json_and_pass_merge():
    a = parse_rows('{"rows":[{"n":1,"w":"e4","b":"e5"},{"n":2,"w":"Nf3","b":"Nc6","b_alt":["Nc5"]}]}')
    b = parse_rows('```json\n{"rows":[{"n":2,"w":"Nf3","b":"Nc7"}]}\n```')
    merged = merge_reads([a, b])
    assert merged[1]["black"] == "Nc6" and set(merged[1]["black_alt"]) == {"Nc5", "Nc7"}
    assert sans_of(merged)[:4] == ["e4", "e5", "Nf3", "Nc6"]
    assert parse_meta('{"rows":[],"meta":{"white":"Anand","result":"1-0","foo":"x"}}') == {"white": "Anand", "result": "1-0"}
