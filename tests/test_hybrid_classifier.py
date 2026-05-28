"""
Unit tests for HybridThreatClassifier — known tactical positions.

Each test verifies:
  1. threat_type is what we expect
  2. method is "rule_based" (no engine/model needed for these clear positions)

Run with:
    .venv/Scripts/python -m pytest tests/test_hybrid_classifier.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from ml.classifier.hybrid_classifier import HybridThreatClassifier, ClassificationResult
from ml.ingestion.threat_classifier import classify_threat


# Rule-based classifier tests (no model needed)
# ------------------------------------------------------------------

class TestRuleBased:

    def test_back_rank_mate(self):
        """
        White rook on e1, black king on g8 with pawns on f7/g7/h7.
        Re8# is a back-rank checkmate.
        FEN: 6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1
        Best move: e1e8 (Rxe8#... actually we need black rook on e8 to make it mate)
        Use a cleaner position: white Rook on a1, black king boxed in on h8
        """
        # White: Ka1, Ra2. Black: Kh8, pawns g7 h7.
        # Ra8# is back-rank mate.
        fen  = "7k/6pp/8/8/8/8/R7/K7 w - - 0 1"
        move = "a2a8"
        result = classify_threat(fen, move)
        assert result == "back_rank", f"Expected back_rank, got {result}"

    def test_fork(self):
        """
        Knight on d5 moves to f6 — attacks black king on h7 and queen on d7 simultaneously.
        White: Kc1, Nd5. Black: Kh7, Qd7. Nf6+ forks king and queen.
        """
        fen  = "8/3qk2K/8/3N4/8/8/8/2K5 w - - 0 1"
        move = "d5f6"
        result = classify_threat(fen, move)
        # Nf6+ checks the king (king_attack fires first) — either is correct
        assert result in ("fork", "king_attack"), f"Expected fork/king_attack, got {result}"

    def test_fork_simple(self):
        """Knight on e5 attacks black queen on d7 AND rook on g6 — classic fork."""
        # White: Ke1, Ne5. Black: Ke8, Qd7, Rg6 (both worth > knight).
        fen  = "4k3/3q4/6r1/4N3/8/8/8/4K3 w - - 0 1"
        move = "e5d7"  # Nxd7 — captures queen, but was Nd7 forking the rook?
        # Actually Ne5-d7 is a capture (Nxd7), not a fork of 2 pieces.
        # Use Ne5-f7 to fork king and rook: Nf7+ forks Ke8 and Rh8
        fen2  = "4k2r/8/8/4N3/8/8/8/4K3 w - - 0 1"
        move2 = "e5f7"
        result2 = classify_threat(fen2, move2)
        # Nf7+ checks the king (king_attack) and forks the rook — expect fork or king_attack
        assert result2 in ("fork", "king_attack", "back_rank"), (
            f"Nf7+ fork position: expected fork/king_attack, got {result2}"
        )

    def test_hanging_piece(self):
        """Black queen is undefended — white can capture it for free."""
        # White: Ke1, Qd1. Black: Ke8, Qq3 (undefended).
        fen  = "4k3/8/8/8/8/3q4/8/3QK3 w - - 0 1"
        move = "d1d3"  # Qxd3 captures the undefended black queen
        result = classify_threat(fen, move)
        assert result == "hanging_piece", f"Expected hanging_piece, got {result}"

    def test_hanging_piece_good_trade(self):
        """Pawn captures defended rook — good trade (attacker < victim)."""
        # White: Ke1, Pe4. Black: Ke8, Rd4 (defended by black Bd6).
        fen  = "4k3/8/3b4/8/3rP3/8/8/4K3 w - - 0 1"
        move = "e4d5"  # exd5? Actually exd4
        # Pawn on e4 captures rook on d4 — rook > pawn even if defended
        # But pawn can only go forward or capture diagonally...
        fen2  = "4k3/8/3b4/8/2rP4/8/8/4K3 w - - 0 1"
        move2 = "d4c5"  # dxc5? No, rook is on c4 not c5
        # Clean: white pawn on e5 captures black rook on d6 (defended by Bd7)
        fen3  = "4k3/3b4/3r4/4P3/8/8/8/4K3 w - - 0 1"
        move3 = "e5d6"  # exd6 — pawn captures rook (good trade)
        result3 = classify_threat(fen3, move3)
        assert result3 == "hanging_piece", f"Expected hanging_piece for good trade, got {result3}"

    def test_passed_pawn(self):
        """White passed pawn advancing towards promotion."""
        # White: Ke1, Pe5 (passed — no black pawns on d,e,f files ahead).
        # Black: Ke8.
        fen  = "4k3/8/8/4P3/8/8/8/4K3 w - - 0 1"
        move = "e5e6"
        result = classify_threat(fen, move)
        assert result == "passed_pawn", f"Expected passed_pawn, got {result}"

    def test_promotion(self):
        """Pawn promotes to queen."""
        fen  = "8/4P3/8/8/8/8/8/4K1k1 w - - 0 1"
        move = "e7e8q"
        result = classify_threat(fen, move)
        assert result == "passed_pawn", f"Expected passed_pawn (promotion), got {result}"

    def test_other_fallback(self):
        """A quiet positional move with no tactical theme returns 'other'."""
        # King shuffle — no tactics
        fen  = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        move = "e2e4"
        result = classify_threat(fen, move)
        # e4 from starting position is not a tactical threat, may be other or piece_activity
        assert result in ("other", "piece_activity", "passed_pawn"), (
            f"e2e4 from start: unexpected {result}"
        )


# HybridThreatClassifier tests (no engine, with model if available)
# ------------------------------------------------------------------

class TestHybridClassifier:

    @pytest.fixture
    def clf(self):
        root = Path(__file__).parent.parent
        model_path = root / "models" / "threat_lgbm.pkl"
        return HybridThreatClassifier(model_path=model_path if model_path.exists() else None)

    def test_back_rank_rule_based(self, clf):
        fen  = "7k/6pp/8/8/8/8/R7/K7 w - - 0 1"
        move = "a2a8"
        result = clf.classify(fen, move, eval_drop_cp=300, pv_length=1)
        assert result.threat_type == "back_rank"
        assert result.method == "rule_based"
        assert result.confidence == 1.0
        assert result.eval_drop_category == "blunder"

    def test_hanging_piece_rule_based(self, clf):
        fen  = "4k3/8/8/8/8/3q4/8/3QK3 w - - 0 1"
        move = "d1d3"
        result = clf.classify(fen, move, eval_drop_cp=900, pv_length=1)
        assert result.threat_type == "hanging_piece"
        assert result.method == "rule_based"

    def test_skip_low_eval_drop(self, clf):
        fen  = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
        move = "e2e4"
        result = clf.classify(fen, move, eval_drop_cp=20)
        assert result.method == "skip"
        assert result.eval_drop_category == "skip"

    def test_inaccuracy_category(self, clf):
        fen  = "7k/6pp/8/8/8/8/R7/K7 w - - 0 1"
        move = "a2a8"
        result = clf.classify(fen, move, eval_drop_cp=70)
        assert result.eval_drop_category == "inaccuracy"

    def test_method_distribution_tracking(self, clf):
        fen  = "7k/6pp/8/8/8/8/R7/K7 w - - 0 1"
        clf.classify(fen, "a2a8", eval_drop_cp=300)
        clf.classify(fen, "a2a8", eval_drop_cp=300)
        dist = clf.get_method_distribution()
        assert dist["rule_based"] >= 2
