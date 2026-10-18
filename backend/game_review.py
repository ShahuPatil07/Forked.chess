"""Local PGN review. Public classification bands; explicitly independent metrics.

No account context or hosted model is used for review scores. See GAME_REVIEW.md.
"""
from __future__ import annotations

import csv
import asyncio
import io
import json
import math
import queue
import statistics
import threading
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Literal

import chess
import chess.engine
import chess.pgn
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ml.config import STOCKFISH_PATH
from backend.coach.teaching import move_observations

router = APIRouter(prefix="/api/game-review")
REVIEW_SLOT = threading.BoundedSemaphore(1)
PRESETS = {"quick": (20000, 14), "standard": (80000, 18), "deep": (240000, 22)}
VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


class ReviewRequest(BaseModel):
    pgn: str = Field(min_length=1, max_length=150000)
    quality: Literal["quick", "standard", "deep"] = "standard"


def parse_game(text: str) -> chess.pgn.Game:
    handle = io.StringIO(text.lstrip('\ufeff'))
    try:
        game = chess.pgn.read_game(handle)
        if game is None or game.errors:
            raise ValueError("PGN contains an illegal or unrecognized move.")
        if game.headers.get("Variant", "Standard").lower() not in ("standard", "chess", "normal"):
            raise ValueError("Only standard chess PGNs are supported.")
        board = game.board()
        if not board.is_valid() or board.chess960:
            raise ValueError("The PGN starting position is invalid or unsupported.")
        moves = list(game.mainline_moves())
        if not 1 <= len(moves) <= 400:
            raise ValueError("Upload one game containing between 1 and 400 half-moves.")
        for move in moves:
            if move not in board.legal_moves or board.is_game_over():
                raise ValueError("PGN contains an illegal move or continues after the game has ended.")
            board.push(move)
        if chess.pgn.read_game(handle) is not None:
            raise ValueError("Upload a single game, not a multi-game PGN file.")
        return game
    except (ValueError, IndexError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc


@lru_cache(maxsize=1)
def opening_book():
    edges, names = set(), {}
    for file in sorted(Path(__file__).with_name("review_book").glob('*.tsv')):
        with file.open(encoding='utf-8') as handle:
            for entry in csv.DictReader(handle, delimiter='\t'):
                game = chess.pgn.read_game(io.StringIO(entry['pgn']))
                if not game or game.errors:
                    continue
                board = game.board()
                for move in game.mainline_moves():
                    edges.add((board.epd(), move.uci()))
                    board.push(move)
                names[board.epd()] = {'name': entry['name'], 'eco': entry['eco']}
    return edges, names


def win_percent(cp: int | None, mate: int | None) -> float:
    if mate is not None:
        return 100.0 if mate > 0 else 0.0
    return 100 / (1 + math.exp(-0.00368208 * max(-10000, min(10000, cp or 0))))


def move_accuracy(loss_percent: float) -> float:
    return min(100.0, max(0.0, 103.1668 * math.exp(-0.04354 * max(0, loss_percent)) - 3.1669))


def score_data(info: dict, mover: chess.Color, ply: int) -> dict:
    pov = info['score']
    score, white = pov.pov(mover), pov.white()
    wdl = info.get('wdl')
    expected = wdl.pov(mover).expectation() if wdl else score.wdl(model='sf16', ply=ply).expectation()
    return {'cp': score.score(), 'mate': score.mate(), 'white_cp': white.score(),
            'white_mate': white.mate(), 'expected': expected,
            'win_percent': win_percent(score.score(), score.mate())}


def variation(board: chess.Board, pv: list[chess.Move], max_plies=8) -> dict:
    replay = board.copy()
    sans, ucis, fens = [], [], [board.fen()]
    for move in pv[:max_plies]:
        if replay.is_game_over() or move not in replay.legal_moves:
            break
        sans.append(replay.san(move)); ucis.append(move.uci())
        replay.push(move); fens.append(replay.fen())
    return {'san': sans, 'uci': ucis, 'fens': fens}


def exchange_gain(board: chess.Board, move: chess.Move, remaining=5) -> int:
    """Legal same-square exchange search; not a full sacrifice proof."""
    gain = 1 if board.is_en_passant(move) else VALUES.get(board.piece_type_at(move.to_square), 0)
    after = board.copy(); after.push(move)
    replies = [m for m in after.legal_moves if m.to_square == move.to_square and after.is_capture(m)]
    return gain - (max([0] + [exchange_gain(after, m, remaining - 1) for m in replies]) if remaining else 0)


def offered_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    if board.is_check() or VALUES[board.piece_type_at(move.from_square)] < 3:
        return False
    after = board.copy(); after.push(move)
    # A queen-for-rook move is not a queen sacrifice if the whole exchange wins material.
    collected = 1 if board.is_en_passant(move) else VALUES.get(board.piece_type_at(move.to_square), 0)
    return any(m.to_square == move.to_square and after.is_capture(m)
               and exchange_gain(after, m) - collected >= 2 for m in after.legal_moves)


def classify(loss: float, *, best: bool, book: bool = False, sacrifice: bool = False,
             expected: float = .5, second_expected: float | None = None,
             missed_chance: bool = False) -> tuple[str, str]:
    # Named openings include traps, dubious gambits and even Fool's Mate.
    # A database match must never conceal a significant engine-detected error.
    if book and loss < .05:
        return 'book', 'This move appears in the bundled opening reference without a significant expected-score loss.'
    if sacrifice and loss < .02 and expected >= .5 and second_expected is not None and second_expected < .9:
        return 'brilliant', 'A near-best piece sacrifice that keeps a sound engine evaluation (heuristic).'
    if best and second_expected is not None and expected >= .45 and expected - second_expected >= .10:
        return 'great', 'The top move stands out from the next engine candidate in this search (heuristic).'
    if best:
        return 'best', 'This is the strongest move found at the selected search budget.'
    if missed_chance and loss >= .05:
        return 'miss', 'A winning chance after the previous error was not maintained (heuristic).'
    for upper, label, reason in [(.02, 'excellent', 'Almost as strong as the engine choice.'),
                                 (.05, 'good', 'A playable move with a small expected-score concession.'),
                                 (.10, 'inaccuracy', 'Gives up a meaningful part of the position’s potential.'),
                                 (.20, 'mistake', 'Significantly worsens the expected outcome.')]:
        if loss < upper:
            return label, reason
    return 'blunder', 'Loses at least 0.20 expected points relative to the strongest move found.'


def summarize(rows: list[dict]) -> dict:
    output = {}
    window = max(3, min(8, len(rows) // 10))
    trajectory = [win_percent(r['played_score']['white_cp'], r['played_score']['white_mate']) for r in rows]
    for side in ('white', 'black'):
        chosen = [(i, row) for i, row in enumerate(rows) if row['color'] == side]
        accuracies = [r['accuracy'] for _, r in chosen]
        weights = [max(.5, statistics.pstdev(trajectory[max(0, i - window + 1):i + 1])) for i, _ in chosen]
        if accuracies:
            weighted = sum(a * w for a, w in zip(accuracies, weights)) / sum(weights)
            harmonic = len(accuracies) / sum(1 / max(.01, a) for a in accuracies)
            accuracy = round((weighted + harmonic) / 2, 1)
        else:
            accuracy = None
        informative = [r for _, r in chosen if r['classification'] != 'book' and not r['forced']
                       and .1 < r['best_score']['expected'] < .95]
        # Deliberately disclosed heuristic; never pretend this is calibrated Elo.
        rating = None
        if len(informative) >= 8:
            mean_loss = statistics.mean(r['expected_loss'] for r in informative)
            estimate = round(max(400, min(2800, 2800 - 600 * math.log1p(mean_loss * 100))) / 50) * 50
            margin = max(300, round(900 / math.sqrt(len(informative)) / 50) * 50)
            rating = {'estimate': estimate, 'low': max(400, estimate - margin),
                      'high': min(2800, estimate + margin), 'sample': len(informative), 'calibrated': False}
        output[side] = {'accuracy': accuracy, 'counts': dict(Counter(r['classification'] for _, r in chosen)),
                        'moves': len(chosen), 'rating': rating, 'rating_sample': len(informative)}
    return output


def review_rows(game: chess.pgn.Game, engine, quality: str):
    nodes, depth = PRESETS[quality]
    book, names = opening_book()
    board = game.board()
    previous_loss = 0.0
    for index, move in enumerate(game.mainline_moves()):
        before = board.copy()
        color = board.turn
        count = min(3, board.legal_moves.count())
        infos = engine.analyse(board, chess.engine.Limit(nodes=nodes * count, depth=depth, time=3), multipv=count)
        info_by_move = {i['pv'][0].uci(): i for i in infos if i.get('pv')}
        board.push(move)
        # Analyze the resulting position independently. Root-move-only searches
        # can overlook a short mating reply even with a superficially deep PV.
        # Retain the game stack so repetition/50-move context reaches Stockfish.
        if board.is_game_over():
            outcome = board.outcome()
            played_info = {'pv': [move], 'depth': depth, 'score': chess.engine.PovScore(
                chess.engine.Cp(0) if outcome.winner is None else chess.engine.Mate(1 if outcome.winner == color else -1), color)}
        else:
            after_info = engine.analyse(board, chess.engine.Limit(nodes=nodes, depth=depth, time=3))
            played_info = dict(after_info, pv=[move] + after_info.get('pv', []), depth=after_info.get('depth', 0) + 1)
            mate = after_info['score'].pov(color).mate()
            if mate is not None and mate > 0:
                played_info['score'] = chess.engine.PovScore(chess.engine.Mate(mate + 1), color)
        info_by_move[move.uci()] = played_info
        ordered = sorted(info_by_move.values(), key=lambda i: i['score'].pov(color), reverse=True)
        best_info = ordered[0]
        best_move = best_info['pv'][0]
        best_score, played_score = (score_data(i, color, before.ply()) for i in (best_info, played_info))
        second = score_data(ordered[1], color, before.ply()) if len(ordered) > 1 else None
        loss = max(0.0, best_score['expected'] - played_score['expected'])
        is_best = best_move == move
        label, reason = classify(loss, best=is_best, book=(before.epd(), move.uci()) in book and not board.is_game_over(),
                                 sacrifice=offered_sacrifice(before, move) if loss < .02 else False,
                                 expected=played_score['expected'], second_expected=second['expected'] if second else None,
                                 missed_chance=previous_loss >= .10 and best_score['expected'] >= .75 and played_score['expected'] < .60)
        san, best_san = before.san(move), before.san(best_move)
        line = variation(before, played_info.get('pv', [move]))
        best_line = variation(before, best_info['pv'])
        observation = move_observations(before.fen(), move.uci())
        explanation = f"{san}: {reason}"
        if board.is_checkmate():
            explanation = f"{san} is checkmate. The king is in check and has no legal way to escape it."
        elif board.is_game_over():
            explanation = f"{san} ends the game in a draw by {board.outcome().termination.name.lower().replace('_', ' ')}."
        elif observation:
            explanation += ' ' + observation[0]
        if not is_best:
            explanation += f" Consider {best_san}; the line begins {' '.join(best_line['san'][:6])}."
        elif len(line['san']) > 1:
            explanation += ' One continuation is ' + ' '.join(line['san'][:6]) + '.'
        row = {'ply': index + 1, 'move_number': before.fullmove_number, 'color': 'white' if color else 'black',
               'san': san, 'uci': move.uci(), 'before_fen': before.fen(), 'fen': board.fen(),
               'classification': label, 'reason': reason, 'explanation': explanation,
               'best_san': best_san, 'best_uci': best_move.uci(), 'best_score': best_score, 'played_score': played_score,
               'expected_loss': round(loss, 5), 'accuracy': round(move_accuracy(best_score['win_percent'] - played_score['win_percent']), 2),
               'depth': int(played_info.get('depth', 0)), 'best_depth': int(best_info.get('depth', 0)),
               'line': line, 'best_line': best_line, 'opening': names.get(board.epd()),
               'forced': before.legal_moves.count() == 1,
               'search_limited': min(played_info.get('depth', 0), best_info.get('depth', 0)) < depth}
        previous_loss = loss
        yield row


def event(data: dict) -> str:
    return 'data: ' + json.dumps(data) + '\n\n'


@router.post('/analyse')
def analyse_game(req: ReviewRequest, request: Request):
    game = parse_game(req.pgn)
    if not STOCKFISH_PATH.exists():
        raise HTTPException(503, 'Local Stockfish is not installed.')
    if not REVIEW_SLOT.acquire(blocking=False):
        raise HTTPException(429, 'Another game review is running. Try again after it finishes.')

    messages = queue.SimpleQueue()
    stopped = threading.Event()
    def worker():
        try:
            messages.put({'type': 'start', 'total': len(list(game.mainline_moves())), 'headers': dict(game.headers),
                          'initial_fen': game.board().fen(), 'quality': req.quality, 'algorithm': 'forked-review-v1'})
            rows = []
            # Dedicated engine: a whole game never holds the interactive Coach lock.
            with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as engine:
                engine.configure({'Threads': 1, 'Hash': 64, 'UCI_ShowWDL': True})
                for row in review_rows(game, engine, req.quality):
                    if stopped.is_set():
                        return
                    rows.append(row)
                    messages.put({'type': 'move', 'move': row})
                messages.put({'type': 'done', 'summary': summarize(rows), 'engine': engine.id.get('name', 'Stockfish'),
                              'algorithm': 'forked-review-v1'})
        except Exception:
            messages.put({'type': 'error', 'message': 'Review stopped before completion. Retry with a smaller search budget.'})
        finally:
            REVIEW_SLOT.release()
    threading.Thread(target=worker, daemon=True, name='forked-game-review').start()
    async def generate():
        try:
            while not stopped.is_set():
                if await request.is_disconnected():
                    return
                try:
                    message = messages.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(.05)
                    continue
                yield event(message)
                if message['type'] in ('done', 'error'):
                    return
        finally:
            stopped.set()
    return StreamingResponse(generate(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache'})
