"""Chess semantics and independent review metrics; no hosted API."""
import json
from copy import deepcopy

import chess
import chess.engine
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from backend.game_review import (
    classify, move_accuracy, opening_book, offered_sacrifice, parse_game,
    review_rows, router, score_data, summarize, win_percent,
)
from backend.coach.teaching import move_observations, teaching_evidence, concise_explanation
from backend.coach.router import _build_messages, CoachChatRequest
from ml.config import STOCKFISH_PATH


@pytest.mark.parametrize('pgn', ['', 'not a chess game', '1. e4 e5 2. Ke3 *',
    '[Variant "Atomic"]\n\n1. e4 *', '1. e4 *\n\n[Event "Two"]\n\n1. d4 *',
    '[FEN "8/8/8/8/8/8/8/8 w - - 0 1"]\n[SetUp "1"]\n\n*'])
def test_invalid_pgn_rejected(pgn):
    with pytest.raises(HTTPException): parse_game(pgn)


def test_comments_variations_and_setup_supported():
    game = parse_game('1. e4 {idea} (1. d4 d5) e5 2. Nf3 *')
    assert len(list(game.mainline_moves())) == 3
    setup = parse_game('[SetUp "1"]\n[FEN "k7/r7/8/8/8/8/6PP/7K b - - 0 20"]\n\n20... Ra1# 0-1')
    assert setup.board().turn == chess.BLACK and setup.board().fullmove_number == 20


@pytest.mark.parametrize('loss,label', [(0, 'excellent'), (.01999, 'excellent'), (.02, 'good'), (.05, 'inaccuracy'), (.10, 'mistake'), (.20, 'blunder'), (1, 'blunder')])
def test_published_threshold_boundaries(loss, label):
    assert classify(loss, best=False)[0] == label


def test_special_classes_are_conservative():
    assert classify(0, best=True)[0] == 'best'
    assert classify(.01, best=False, book=True)[0] == 'book'
    assert classify(.3, best=False, book=True)[0] == 'blunder'
    assert classify(0, best=True, expected=.6, second_expected=.4)[0] == 'great'
    assert classify(0, best=True, sacrifice=True, expected=.6, second_expected=.4)[0] == 'brilliant'
    assert classify(0, best=True, sacrifice=True, expected=.95, second_expected=.93)[0] != 'brilliant'
    assert classify(.2, best=False, missed_chance=True)[0] == 'miss'


def test_opening_edges_and_transposed_position_lookup():
    book, names = opening_book()
    b = chess.Board()
    assert (b.epd(), 'e2e4') in book
    assert (b.epd(), 'e2e5') not in book
    for san in ['e4','e5','Nf3','Nc6','Bb5']: b.push_san(san)
    assert names[b.epd()]['eco'].startswith('C')


def test_mates_and_black_perspective():
    info = {'score': chess.engine.PovScore(chess.engine.Mate(3), chess.BLACK)}
    assert score_data(info, chess.BLACK, 20)['expected'] == 1
    assert score_data(info, chess.WHITE, 20)['expected'] == 0
    assert score_data(info, chess.BLACK, 20)['white_mate'] == -3
    assert win_percent(None, 0) == 0
    assert move_accuracy(-10) > 99.9 and move_accuracy(100) < 1


def test_development_and_center_observations():
    notes = move_observations(chess.STARTING_FEN, 'g1f3')
    assert any('Develops the knight' in n for n in notes)
    assert any('e5' in n and 'd4' in n for n in notes)
    assert move_observations(chess.STARTING_FEN, 'e2e5') == []


def test_profile_identity_does_not_enter_prompt():
    first = _build_messages(CoachChatRequest(username='one', message='Explain development'))
    second = _build_messages(CoachChatRequest(username='another', message='Explain development'))
    assert first == second
    assert "player's data proactively" not in first[0]['content']


def test_ratings_need_evidence_and_ignore_book_padding():
    row = {'color':'white','accuracy':90.,'classification':'good','forced':False,'expected_loss':.02,
           'best_score':{'expected':.6},'played_score':{'white_cp':0,'white_mate':None}}
    assert summarize([row] * 7)['white']['rating'] is None
    assert summarize([row] * 8)['white']['rating']['calibrated'] is False
    book = deepcopy(row); book['classification'] = 'book'
    assert summarize([book] * 30)['white']['rating'] is None
    assert summarize([row])['black']['accuracy'] is None


@pytest.fixture(scope='module')
def engine():
    if not STOCKFISH_PATH.exists(): pytest.skip('Stockfish not installed')
    with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as engine:
        engine.configure({'Threads':1,'Hash':32,'UCI_ShowWDL':True})
        yield engine


def test_real_game_fools_mate_rows_and_legal_variations(engine):
    rows = list(review_rows(parse_game('1. f3 e5 2. g4 Qh4# 0-1'), engine, 'quick'))
    assert len(rows) == 4
    assert rows[-1]['played_score']['mate'] == 1
    assert rows[-1]['played_score']['white_mate'] == -1
    assert rows[-1]['best_uci'] == 'd8h4'
    assert rows[2]['classification'] == 'blunder'
    for row in rows:
        board = chess.Board(row['before_fen']); board.push_uci(row['uci'])
        assert board.fen() == row['fen']
        for name in ['line', 'best_line']:
            board = chess.Board(row['before_fen'])
            for san in row[name]['san']: board.push_san(san)
            assert board.fen() == row[name]['fens'][-1]


def test_real_custom_black_start_and_endpoint(engine):
    pgn = '[SetUp "1"]\n[FEN "k7/r7/8/8/8/8/6PP/7K b - - 0 20"]\n\n20... Ra1# 0-1'
    rows = list(review_rows(parse_game(pgn), engine, 'quick'))
    assert rows[0]['color'] == 'black' and rows[0]['move_number'] == 20
    app = FastAPI(); app.include_router(router)
    response = TestClient(app).post('/api/game-review/analyse', json={'pgn':pgn,'quality':'quick'})
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    assert [e['type'] for e in events] == ['start','move','done']
    assert events[-1]['summary']['white']['accuracy'] is None


def test_independent_reply_search_catches_opera_game_mating_net(engine):
    pgn = '[SetUp "1"]\n[FEN "4kb1r/p2r1ppp/4qn2/4p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 1 15"]\n\n15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0'
    # Use the actual bishop on b5 for the historical combination.
    pgn = pgn.replace('4p1B1', '1B2p1B1')
    rows = list(review_rows(parse_game(pgn), engine, 'standard'))
    assert rows[1]['played_score']['mate'] is not None
    assert rows[1]['played_score']['mate'] < 0
    assert rows[1]['line']['san'][:4] == ['Nxd7', 'Qb8+', 'Nxb8', 'Rd8#']
    assert rows[2]['played_score']['mate'] == 2
    assert 'checkmate' in rows[-1]['explanation']


@pytest.mark.parametrize('fen,move', [
    ('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'O-O'),
    ('7k/P7/8/8/8/8/8/K7 w - - 0 1', 'a8=N'),
    ('7k/8/8/3pP3/8/8/8/K7 w - d6 0 1', 'exd6'),
])
def test_review_special_moves_and_terminal_draws(engine, fen, move):
    game = parse_game(f'[SetUp "1"]\n[FEN "{fen}"]\n\n1. {move} *')
    row = next(review_rows(game, engine, 'quick'))
    board = chess.Board(fen); board.push_san(move)
    assert row['fen'] == board.fen()
    if move == 'a8=N':
        assert row['played_score']['cp'] == 0
        assert 'draw by insufficient material' in row['explanation']


def test_sacrifice_heuristic_rejects_a_profitable_queen_exchange():
    board = chess.Board('4r2k/8/8/8/4q3/8/8/4Q1K1 w - - 0 1')
    assert not offered_sacrifice(board, board.parse_san('Qxe4'))
    sacrifice = chess.Board('4kb1r/p2n1ppp/4q3/4p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 0 16')
    assert offered_sacrifice(sacrifice, sacrifice.parse_san('Qb8+'))
