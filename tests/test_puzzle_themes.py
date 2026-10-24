"""Puzzle Themes: sub-theme detection, explanations, ratings, own-game line trimming.

    .venv/Scripts/python -m pytest tests/test_puzzle_themes.py -q -p no:cacheprovider

Fixtures are real Lichess puzzles (FEN before the trigger move, UCI moves).
"""
import chess

from backend.puzzle_themes import _cut_line, _hint_for, glicko2
from ml.puzzles.explain import explain
from ml.puzzles.subthemes import detect

ROYAL_FORK = ("5bk1/pp3p2/2pq1p1p/3n3N/3Q3P/1P3PP1/P3N1K1/8 b - - 5 29", "c6c5 d4d5 d6d5 h5f6 g8g7 f6d5",
              "attraction capturingDefender crushing deflection endgame fork long queenSacrifice sacrifice")
PAWN_FORK_THEMES = "crushing endgame fork knightEndgame long"
OPPOSITION = ("8/8/5kp1/1p1p4/1P1Kp1PP/2P5/8/8 w - - 2 49", "d4e3 f6e5 e3d2 e5f4", "crushing endgame pawnEndgame short zugzwang")
BREAKTHROUGH = ("8/1p3p2/4k2p/1PP1P1p1/4pp2/8/1P5P/3K4 b - - 0 43", "e6d5 c5c6 b7c6 b5b6 d5e5 b6b7",
                "advancedPawn crushing endgame long pawnEndgame sacrifice")
R_P_VS_R = ("8/7P/3k4/4p3/2K5/7r/R7/8 b - - 0 55", "h3h7 a2a6 d6d7 a6a7 d7e6 a7h7", "crushing endgame long master rookEndgame skewer")
QUEEN_SAC = ("2kr2nr/pp1nq1p1/2p1p1p1/5pN1/1bBP1BP1/5Q1P/PPP5/R4RK1 b - - 1 15", "g8f6 f3c6 b7c6 c4a6",
             "bodenMate mate mateIn2 middlegame queensideAttack sacrifice short")
SKEWER = ("r1b1r1k1/p4pp1/2q1p2p/2Pp4/3PnP2/1R1BP3/P5PP/3Q1RK1 b - - 2 19", "f7f6 d3b5 c6c7 b5e8")


def test_fork_subtypes():
    subs = detect(*ROYAL_FORK)
    assert {"knightFork", "royalFork", "queenSacrifice"} <= subs
    subs = detect("8/8/3k2p1/2p2p1p/3n1K1P/2p1NP2/PP3P2/8 w - - 0 36", "b2c3 d4e6 f4g3 f5f4 g3g2 f4e3", PAWN_FORK_THEMES)
    assert "pawnFork" in subs and "knightFork" not in subs


def test_endgame_technique():
    assert "opposition" in detect(*OPPOSITION)
    assert "pawnBreakthrough" in detect(*BREAKTHROUGH)
    assert "rookPawnVsRook" in detect(*R_P_VS_R)


def test_detect_needs_the_parent_theme():
    fen, moves, _ = OPPOSITION
    assert "opposition" not in detect(fen, moves, "crushing short")   # not tagged pawnEndgame -> not checked


def test_explain_is_board_proven():
    x = explain(*QUEEN_SAC[:2])
    assert x["mate"] and x["summary"] == "Forced mate in 2."
    assert any("sacrifice" in n or "lures" in n for n in x["steps"][0]["notes"])
    x = explain(*SKEWER)
    assert any("skewers the queen on c6 to the rook on e8" in n for n in x["steps"][0]["notes"])
    x = explain(*OPPOSITION[:2])
    assert "takes the opposition" in x["steps"][0]["notes"]


def test_glicko2_direction_and_bounds():
    r, rd, _ = glicko2(1500, 200, 0.06, 1500, 80, 1.0)
    assert r > 1500 and rd < 200
    r2, _, _ = glicko2(1500, 200, 0.06, 1500, 80, 0.0)
    assert r2 < 1500 and abs((r - 1500) + (r2 - 1500)) < 1
    r3, _, _ = glicko2(1500, 200, 0.06, 1500, 80, 0.5)
    assert abs(r3 - 1500) < 1                       # a hinted solve vs an equal puzzle is a draw
    _, rd_floor, _ = glicko2(1500, 60, 0.06, 1500, 80, 1.0)
    assert rd_floor >= 60


def test_cut_line_banks_the_gain():
    # Hanging rook: Rxe7 wins it outright, so the puzzle is that one move.
    board = chess.Board("r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2b1/PqP3PP/7K w - - 0 25")
    line = ["e6e7", "b2b1", "b3c1", "b1c1", "h6c1"]
    cut = _cut_line(board, line, None)
    assert len(cut) % 2 == 1 and cut[0] == "e6e7"
    # Mate lines are cut at the mate.
    assert _cut_line(board, line, 2) == line[:3]


def test_hint_prefers_the_specific_subtype():
    h = _hint_for(["fork", "knightFork", "middlegame", "short"], "fork")
    assert h["theme"] == "knightFork"
    h = _hint_for(["crushing", "middlegame", "pin", "mateIn2", "backRankMate"], "mix")
    assert h["theme"] == "backRankMate"
