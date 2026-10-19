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
CALIBRATION_PATH = Path(__file__).with_name("review_calibration.json")
ALGORITHM = "forked-review-v2"


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


@lru_cache(maxsize=1)
def calibration() -> dict:
    """Fitted constants from scripts/calibrate_review.py (real game results and
    Chess.com stored accuracies). Empty dict -> documented public defaults."""
    try:
        return json.loads(CALIBRATION_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}


def win_percent(cp: int | None, mate: int | None) -> float:
    if mate is not None:
        return 100.0 if mate > 0 else 0.0
    return 100 / (1 + math.exp(-0.00368208 * max(-10000, min(10000, cp or 0))))


def expected_points(cp: int | None, mate: int | None, rating: int | None = None) -> float:
    """Expected game points for the side to move — the scale Chess.com's
    0.02/0.05/0.10/0.20 bands are defined on. A human logistic fitted to real
    game results (calibration), not Stockfish's engine-game WDL model, which is
    far steeper and inflated mistakes/blunders. A rating term is used only if
    the fit found one that matters."""
    if mate is not None:
        return 1.0 if mate > 0 else 0.0
    ep = calibration().get('expected_points') or {}
    k = ep.get('k_flat', 0.00368208)
    if rating and ep.get('use_rating'):
        lo, hi = ep.get('fit_rating_range', [1000, 2200])
        r = max(lo - 200, min(hi + 200, rating))
        k = ep['k0'] + ep['k_per_400'] * (r - 1600) / 400
    return 1 / (1 + math.exp(-max(1e-4, k) * max(-5000, min(5000, cp or 0))))


def move_accuracy(loss_percent: float) -> float:
    """Per-move accuracy from win-percent loss (calibrated to Chess.com stored
    accuracies when a calibration exists; Lichess's public formula otherwise)."""
    acc = calibration().get('accuracy') or {}
    a, k, b = acc.get('A', 103.1668), acc.get('k', 0.04354), acc.get('B', -3.1669)
    return min(100.0, max(0.0, a * math.exp(-k * max(0, loss_percent)) + b))


def score_data(info: dict, mover: chess.Color, ply: int, rating: int | None = None) -> dict:
    pov = info['score']
    score, white = pov.pov(mover), pov.white()
    wdl = info.get('wdl')
    engine_expected = wdl.pov(mover).expectation() if wdl else score.wdl(model='sf16', ply=ply).expectation()
    return {'cp': score.score(), 'mate': score.mate(), 'white_cp': white.score(),
            'white_mate': white.mate(), 'expected': expected_points(score.score(), score.mate(), rating),
            'engine_expected': engine_expected,
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
    """Does the move offer at least a minor piece / the exchange (net) to the
    opponent? Any square counts — moving into capture, or leaving another piece
    en prise — and the offer counts even if it is declined (Chess.com's
    repeated-rook example). Moves that mate on the spot are not sacrifices."""
    if board.is_check():
        return False
    after = board.copy(); after.push(move)
    if after.is_checkmate():
        return False
    collected = 1 if board.is_en_passant(move) else VALUES.get(board.piece_type_at(move.to_square), 0)
    for reply in after.legal_moves:
        if not after.is_capture(reply):
            continue
        victim = after.piece_type_at(reply.to_square)
        if victim is None or VALUES.get(victim, 0) < 3:
            continue
        # what the opponent nets with this capture (including the recapture fight)
        net = exchange_gain(after, reply)
        if reply.to_square == move.to_square:
            net -= collected                    # we already took something on that square
        if net >= 2:
            return True
    return False


def is_obvious(board: chess.Board, move: chess.Move, prev_move: chess.Move | None) -> bool:
    """Too obvious to be 'Great' (Chess.com excludes e.g. recapturing a piece):
    recaptures on the square the opponent just captured on, the only legal
    move, and escapes from check with at most two options."""
    if board.legal_moves.count() == 1:
        return True
    if board.is_check() and board.legal_moves.count() <= 2:
        return True
    if prev_move is not None and board.is_capture(move) and move.to_square == prev_move.to_square:
        return True
    return False


def classify(loss: float, *, best: bool, book: bool = False, sacrifice: bool = False,
             expected: float = .5, second_expected: float | None = None,
             missed_chance: bool = False, concrete: bool = True, obvious: bool = False,
             endgame: bool = False, rating: int | None = None) -> tuple[str, str]:
    """Chess.com-style move label. Published bands on expected-points loss, plus
    the documented contextual rules: Blunder needs a concrete punishment
    (material or mate) — otherwise Mistake, or Miss when a chance was let slip;
    Great is the only good move but not an obvious one; Brilliant is a sound,
    near-best piece/exchange sacrifice that was needed."""
    # Named openings include traps, dubious gambits and even Fool's Mate.
    # A database match must never conceal a significant engine-detected error.
    if book and loss < .05:
        return 'book', 'A known opening move.'
    near_best = .02 + (.01 if rating and rating < 1200 else 0)
    gap = (expected - second_expected) if second_expected is not None else 0
    if sacrifice and loss <= near_best and expected >= .45 and second_expected is not None \
            and second_expected < .9 and (not endgame or gap >= .10):
        return 'brilliant', 'A sound sacrifice: material is offered for a lasting advantage.'
    if best and not obvious and second_expected is not None and expected >= .40 and gap >= .10:
        return 'great', 'The only good move — the alternatives are clearly worse.'
    if best:
        return 'best', 'The strongest move in the position.'
    if missed_chance and loss >= .10 and not (loss >= .20 and concrete):
        return 'miss', 'Missed the chance to punish the opponent’s error.'
    for upper, label, reason in [(.02, 'excellent', 'Almost as strong as the best move.'),
                                 (.05, 'good', 'A solid move with a small concession.'),
                                 (.10, 'inaccuracy', 'Gives up a meaningful part of your advantage.'),
                                 (.20, 'mistake', 'Significantly worsens your position.')]:
        if loss < upper:
            return label, reason
    if not concrete:
        return 'mistake', 'A big drop, but there is no immediate material or mating punishment.'
    return 'blunder', 'Loses material or allows mate.'


def _aggregate(accs: list[float], weights: list[float]) -> float | None:
    if not accs:
        return None
    cfg = calibration().get('accuracy') or {}
    if cfg.get('model') == 'power':
        f, p = cfg.get('f', 5.0), cfg.get('p', 0.5)
        vals = [max(f, a) for a in accs]
        pm = math.exp(sum(math.log(v) for v in vals) / len(vals)) if abs(p) < 1e-3 else \
            (sum(v ** p for v in vals) / len(vals)) ** (1 / p)
        return round(max(0.0, min(100.0, pm + cfg.get('b', 0.0))), 1)
    weighted = sum(a * w for a, w in zip(accs, weights)) / sum(weights)
    harmonic = len(accs) / sum(1 / max(.01, a) for a in accs)
    return round(max(0.0, min(100.0, (weighted + harmonic) / 2 + cfg.get('b', 0.0))), 1)


def _invert(xs: list[float], ys: list[float], y: float) -> float:
    """Piecewise-linear inverse of a non-decreasing curve (clamped at the ends)."""
    mono = [max(ys[:i + 1]) for i in range(len(ys))]
    if y <= mono[0]:
        return xs[0]
    for i in range(1, len(mono)):
        if mono[i] >= y:
            span = mono[i] - mono[i - 1]
            t = 0.0 if span <= 0 else (y - mono[i - 1]) / span
            return xs[i - 1] + t * (xs[i] - xs[i - 1])
    return xs[-1]


PRIOR_SD = 350.0   # how far one game's level typically strays from a player's rating


def game_rating(accuracy: float | None, moves: int, player_rating: int | None = None) -> dict | None:
    """Game rating = the rating this game was played at, from its accuracy.

    Measured on Chess.com's own stored accuracies (thousands of rated games):
    typical accuracy rises only ~1 point per 100 Elo while one player's games
    spread ~13 points, so accuracy alone barely pins a rating down. We combine
    the evidence: the likelihood of this accuracy at each rating (normal,
    centre = typical accuracy, spread from the observed middle half) times a
    prior centred on the player's PGN rating when known (Chess.com's current
    Game Rating is described as relative to the player's rating), flat when
    unknown. Returns the posterior mean and an 80% interval."""
    curve = calibration().get('rating_curve') or []
    if accuracy is None or len(curve) < 4:
        return None
    rs = [c['rating'] for c in curve]
    # fine grid, linear interpolation of the (monotone) centre and spread
    lo_r, hi_r = rs[0] - 100, rs[-1] + 150
    grid = list(range(int(lo_r), int(hi_r) + 1, 25))
    mono = [max(c['typical_acc'] for c in curve[:i + 1]) for i in range(len(curve))]
    spread = [max(4.0, (c['p75'] - c['p25']) / 1.349) for c in curve]

    def interp(xs, ys, x):
        if x <= xs[0]:
            return ys[0] + (ys[1] - ys[0]) / (xs[1] - xs[0]) * (x - xs[0])
        if x >= xs[-1]:
            return ys[-1] + (ys[-1] - ys[-2]) / (xs[-1] - xs[-2]) * (x - xs[-1])
        for i in range(1, len(xs)):
            if x <= xs[i]:
                t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
                return ys[i - 1] + t * (ys[i] - ys[i - 1])
        return ys[-1]
    post = []
    for g in grid:
        mu, sd = interp(rs, mono, g), interp(rs, spread, g)
        w = math.exp(-0.5 * ((accuracy - mu) / sd) ** 2) / sd
        if player_rating:
            w *= math.exp(-0.5 * ((g - player_rating) / PRIOR_SD) ** 2)
        post.append(w)
    total = sum(post) or 1.0
    post = [w / total for w in post]
    mean = sum(g * w for g, w in zip(grid, post))
    cum, low, high = 0.0, grid[0], grid[-1]
    for g, w in zip(grid, post):
        prev, cum = cum, cum + w
        if prev < .10 <= cum:
            low = g
        if prev < .90 <= cum:
            high = g
    r50 = lambda x: int(round(x / 50) * 50)
    return {'estimate': r50(mean), 'low': r50(low), 'high': r50(high), 'sample': moves, 'calibrated': True,
            'relative_to': player_rating,
            'method': ('Your rating adjusted by this game’s accuracy' if player_rating else
                       'Rating at which this accuracy is typical') + ' (fitted on Chess.com stored accuracies)'}


def _legacy_rating(informative: list[dict]) -> dict:
    mean_loss = statistics.mean(r['expected_loss'] for r in informative)
    estimate = round(max(400, min(2800, 2800 - 600 * math.log1p(mean_loss * 100))) / 50) * 50
    margin = max(300, round(900 / math.sqrt(len(informative)) / 50) * 50)
    return {'estimate': estimate, 'low': max(400, estimate - margin),
            'high': min(2800, estimate + margin), 'sample': len(informative), 'calibrated': False}


def summarize(rows: list[dict], ratings: dict | None = None) -> dict:
    output = {}
    cfg = calibration().get('accuracy') or {}
    window = max(3, min(8, len(rows) // 10))
    trajectory = [win_percent(r['played_score']['white_cp'], r['played_score']['white_mate']) for r in rows]
    for side in ('white', 'black'):
        chosen = [(i, row) for i, row in enumerate(rows) if row['color'] == side
                  and not (cfg.get('skip_book') and row['classification'] == 'book')
                  and not (cfg.get('skip_forced') and row.get('forced'))]
        accuracies = [r['accuracy'] for _, r in chosen]
        weights = [max(.5, statistics.pstdev(trajectory[max(0, i - window + 1):i + 1])) for i, _ in chosen]
        accuracy = _aggregate(accuracies, weights)
        phases = {}
        for phase in ('opening', 'middlegame', 'endgame'):
            sub = [(r['accuracy'], w) for (_, r), w in zip(chosen, weights) if r.get('phase') == phase]
            if len(sub) >= 3:
                phases[phase] = {'accuracy': _aggregate([a for a, _ in sub], [w for _, w in sub]), 'moves': len(sub)}
        informative = [r for i, r in [(i, r) for i, r in enumerate(rows) if r['color'] == side]
                       if r['classification'] != 'book' and not r.get('forced')
                       and .1 < r['best_score']['expected'] < .95]
        rating = None
        if len(informative) >= 8:
            rating = game_rating(accuracy, len(informative), (ratings or {}).get(side)) or _legacy_rating(informative)
        output[side] = {'accuracy': accuracy,
                        'counts': dict(Counter(r['classification'] for r in rows if r['color'] == side)),
                        'moves': sum(1 for r in rows if r['color'] == side), 'rating': rating,
                        'rating_sample': len(informative), 'phases': phases}
    return output


BOOK_MAX_PLY = 30
BOOK_MIN_GAMES = 50
BOOK_MIN_SHARE = .02


class _ExplorerBook:
    """Deeper 'Book' than the named-opening lines: a move strong players (2200+
    on Lichess) play often in this position. Uses the Openings feature's cached
    explorer proxy; one failure disables it for the rest of the review so a
    flaky network never stalls a game."""

    def __init__(self):
        self.enabled = True

    def __call__(self, board: chess.Board, move: chess.Move) -> bool:
        if not self.enabled or board.ply() >= BOOK_MAX_PLY:
            return False
        try:
            from backend.openings import _fetch_lichess
            data = _fetch_lichess(board.fen(), '', 2200)
        except Exception:
            self.enabled = False
            return False
        rows = data.get('moves') or []
        total = sum(r.get('white', 0) + r.get('draws', 0) + r.get('black', 0) for r in rows) or 1
        for r in rows:
            if r.get('uci') == move.uci() or (board.is_castling(move) and r.get('san') == board.san(move)):
                n = r.get('white', 0) + r.get('draws', 0) + r.get('black', 0)
                return n >= BOOK_MIN_GAMES and n / total >= BOOK_MIN_SHARE
        return False


def _rating_of(game: chess.pgn.Game, color: chess.Color) -> int | None:
    raw = game.headers.get('WhiteElo' if color == chess.WHITE else 'BlackElo', '')
    return int(raw) if raw.isdigit() else None


def review_rows(game: chess.pgn.Game, engine, quality: str):
    from ml.ingestion.mechanism import tag_mechanism, TACTIC_SWING_CP
    from ml.ingestion.mistake_extractor import game_phase
    nodes, depth = PRESETS[quality]
    book, names = opening_book()
    board = game.board()
    previous_loss = 0.0
    prev_board: chess.Board | None = None
    prev_move: chess.Move | None = None
    in_book = True
    explorer_book = _ExplorerBook()
    for index, move in enumerate(game.mainline_moves()):
        before = board.copy()
        color = board.turn
        rating = _rating_of(game, color)
        count = min(3, board.legal_moves.count())
        infos = engine.analyse(board, chess.engine.Limit(nodes=nodes * count, depth=depth, time=3), multipv=count)
        info_by_move = {i['pv'][0].uci(): i for i in infos if i.get('pv')}
        board.push(move)
        # Analyze the resulting position independently. Root-move-only searches
        # can overlook a short mating reply even with a superficially deep PV.
        # Retain the game stack so repetition/50-move context reaches Stockfish.
        after_info = None
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
        best_score, played_score = (score_data(i, color, before.ply(), rating) for i in (best_info, played_info))
        alternatives = [i for i in ordered if i['pv'][0] != move]
        second = score_data(alternatives[0], color, before.ply(), rating) if alternatives else None
        loss = max(0.0, best_score['expected'] - played_score['expected'])
        is_best = best_move == move or loss < .001

        # Concrete punishment / missed chance: the same mechanism Stage 1 uses.
        reply_line = [m.uci() for m in (after_info or {}).get('pv', [])]
        reply_mate = (after_info['score'].pov(not color).mate() if after_info else None)
        mech = tag_mechanism(
            before, [m.uci() for m in best_info['pv']], move.uci(), reply_line,
            best_score['mate'] if (best_score['mate'] or 0) > 0 else None,
            reply_mate if (reply_mate or 0) > 0 else None,
            prev_board=prev_board,
            es_before=best_score['win_percent'] / 100, es_after=played_score['win_percent'] / 100)
        concrete = (mech.swing_allowed_cp >= TACTIC_SWING_CP or mech.mate_allowed is not None
                    or (played_score['mate'] is not None and played_score['mate'] < 0))
        missed_chance = (mech.mate_missed is not None or mech.swing_missed_cp >= TACTIC_SWING_CP
                         or (previous_loss >= .10 and best_score['expected'] >= .70))
        phase = game_phase(before)
        in_book = in_book and ((before.epd(), move.uci()) in book or explorer_book(before, move))
        sac = offered_sacrifice(before, move) if loss < .04 else False
        label, reason = classify(
            loss, best=is_best, book=in_book and not board.is_game_over(), sacrifice=sac,
            expected=played_score['expected'], second_expected=second['expected'] if second else None,
            missed_chance=missed_chance, concrete=concrete, obvious=is_obvious(before, move, prev_move),
            endgame=phase == 'endgame', rating=rating)
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
        if label in ('blunder', 'mistake', 'miss') and reply_line and label != 'miss':
            reply = variation(board, (after_info or {}).get('pv', []), 4)
            if reply['san']:
                explanation += f" The opponent can answer {' '.join(reply['san'][:4])}."
        if not is_best:
            explanation += f" Consider {best_san}; the line begins {' '.join(best_line['san'][:6])}."
        elif len(line['san']) > 1:
            explanation += ' One continuation is ' + ' '.join(line['san'][:6]) + '.'
        candidates = [{'uci': i['pv'][0].uci(), 'san': before.san(i['pv'][0]),
                       'expected': round(score_data(i, color, before.ply(), rating)['expected'], 4)}
                      for i in ordered[:4]]
        row = {'ply': index + 1, 'move_number': before.fullmove_number, 'color': 'white' if color else 'black',
               'san': san, 'uci': move.uci(), 'before_fen': before.fen(), 'fen': board.fen(),
               'classification': label, 'reason': reason, 'explanation': explanation,
               'best_san': best_san, 'best_uci': best_move.uci(), 'best_score': best_score, 'played_score': played_score,
               'expected_loss': round(loss, 5), 'accuracy': round(move_accuracy(best_score['win_percent'] - played_score['win_percent']), 2),
               'depth': int(played_info.get('depth', 0)), 'best_depth': int(best_info.get('depth', 0)),
               'line': line, 'best_line': best_line, 'opening': names.get(board.epd()),
               'forced': before.legal_moves.count() == 1, 'phase': phase, 'candidates': candidates,
               'punished_by': variation(board, (after_info or {}).get('pv', []), 6) if concrete and loss >= .10 else None,
               'search_limited': min(played_info.get('depth', 0), best_info.get('depth', 0)) < depth}
        previous_loss = loss
        prev_board, prev_move = before, move
        yield row


def official_accuracy(headers: dict) -> dict | None:
    """Chess.com's own stored accuracy for a Chess.com game, from the documented
    Published-Data API (monthly archive of the game's player, matched by URL).
    Shown beside — never mixed into — the local estimate. None when the PGN is
    not a Chess.com game, the game was never reviewed there, or the API fails."""
    import re
    import requests
    from ml.config import REQUEST_HEADERS
    link = headers.get('Link', '')
    m = re.search(r'chess\.com/game/(?:live|daily)/(\d+)', link)
    date = headers.get('EndDate') or headers.get('UTCDate') or headers.get('Date') or ''
    d = re.match(r'(\d{4})\.(\d{2})', date)
    if not m or not d:
        return None
    for player in (headers.get('White', ''), headers.get('Black', '')):
        if not player:
            continue
        try:
            url = f"https://api.chess.com/pub/player/{player.lower()}/games/{d.group(1)}/{d.group(2)}"
            games = requests.get(url, headers=REQUEST_HEADERS, timeout=8).json().get('games', [])
        except Exception:
            continue
        for g in games:
            if g.get('url', '').endswith('/' + m.group(1)):
                acc = g.get('accuracies')
                return {'white': acc.get('white'), 'black': acc.get('black'), 'url': g['url']} if acc else None
    return None


class CheckMoveRequest(BaseModel):
    fen: str = Field(min_length=10, max_length=120)
    uci: str = Field(min_length=4, max_length=5)
    best_expected: float


@router.post('/check-move')
def check_move(req: CheckMoveRequest):
    """Retry: evaluate a move the user tries in a reviewed position and label it
    on the same expected-points scale as the review."""
    try:
        board = chess.Board(req.fen)
        move = chess.Move.from_uci(req.uci)
    except ValueError as exc:
        raise HTTPException(400, 'Invalid position or move.') from exc
    if move not in board.legal_moves:
        raise HTTPException(400, 'Illegal move.')
    color = board.turn
    san = board.san(move)
    board.push(move)
    if board.is_checkmate():
        expected = 1.0
    elif board.is_game_over():
        expected = .5
    else:
        from backend.main import _sf_lock, _ensure_engine   # shared interactive engine
        with _sf_lock:
            info = _ensure_engine().analyse(board, chess.engine.Limit(nodes=150000, depth=16, time=2))
        sc = info['score'].pov(color)
        expected = expected_points(sc.score(), sc.mate())
    loss = max(0.0, req.best_expected - expected)
    label = 'best' if loss < .005 else classify(loss, best=False, concrete=True)[0]
    return {'san': san, 'expected': round(expected, 4), 'loss': round(loss, 4), 'classification': label,
            'correct': loss < .02}


@router.get('/recent')
def recent_games(username: str, platform: Literal['chesscom', 'lichess'] = 'chesscom', n: int = 12):
    """The player's most recent games (any time class) with PGNs, to review in one click."""
    from ml.ingestion.fetcher import (fetch_chesscom_games, fetch_lichess_games,
                                      parse_chesscom_game, parse_lichess_game)
    n = max(1, min(30, n))
    try:
        if platform == 'chesscom':
            raw = fetch_chesscom_games(username, min_games=n, time_classes=())
            parsed = [parse_chesscom_game(g, username) for g in raw]
        else:
            raw = fetch_lichess_games(username, min_games=n, time_classes=())
            parsed = [parse_lichess_game(g, username) for g in raw]
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, 'Could not reach the games service. Try again.') from exc
    out = []
    for g in parsed:
        if not g:
            continue
        out.append({k: g.get(k) for k in ('game_id', 'white_username', 'black_username', 'white_elo', 'black_elo',
                                          'result', 'user_color', 'time_control', 'time_class', 'played_at', 'url', 'pgn')})
    out.sort(key=lambda g: -(g.get('played_at') or 0))
    return {'games': out[:n]}


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
                          'initial_fen': game.board().fen(), 'quality': req.quality, 'algorithm': ALGORITHM})
            rows = []
            # Dedicated engine: a whole game never holds the interactive Coach lock.
            with chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as engine:
                engine.configure({'Threads': 1, 'Hash': 64, 'UCI_ShowWDL': True})
                for row in review_rows(game, engine, req.quality):
                    if stopped.is_set():
                        return
                    rows.append(row)
                    messages.put({'type': 'move', 'move': row})
                official = None
                try:
                    official = official_accuracy(dict(game.headers))
                except Exception:
                    official = None
                messages.put({'type': 'done', 'summary': summarize(rows, {'white': _rating_of(game, chess.WHITE), 'black': _rating_of(game, chess.BLACK)}), 'engine': engine.id.get('name', 'Stockfish'),
                              'algorithm': ALGORITHM, 'official_accuracy': official})
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
