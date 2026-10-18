# Game Review: methodology, implementation and acceptance tests

`/game-review` is Forked's independent local game-review implementation. It uses
existing python-chess/Stockfish and bundled CC0 opening data. No hosted API, paid
review service, new Python dependency or daily quota is required for the review.
Optional **Explain the idea** uses the same configured Coach narrator and fallback.

## Scope and public research

Chess.com's full Game Review engine, CAPS2 math and game-rating calibration are
not published. An exact numerical replica cannot be claimed. This implementation
uses the published move-classification bands with its own engine outcome model,
Lichess-inspired accuracy formulas and explicitly experimental special labels and
performance estimates. It does not bypass or call a paid Chess.com service.

Primary sources consulted:

- [Chess.com move classifications](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc): expected-points loss bands and descriptions of Great, Brilliant and Miss.
- [Chess.com accuracy](https://support.chess.com/en/articles/8708970-how-is-accuracy-in-analysis-determined): CAPS2 overview, without a complete reproducible algorithm.
- [Chess.com game rating](https://support.chess.com/en/articles/10773754-how-is-game-rating-calculated-in-game-review): its estimates depend on move quality and player rating. Forked deliberately excludes player/profile ratings in this slice.
- [Lichess accuracy](https://lichess.org/page/accuracy): public win-percent and move-accuracy formulas, and volatility-weighted/harmonic aggregation approach.
- [Lichess opening reference](https://github.com/lichess-org/chess-openings): CC0 data, pinned at `a6189a30dc273ccb21fc2536a9a2fefd5592a67a`; source/license included under `review_book/`.

## User flow

Upload or paste a single standard-chess PGN, choose Quick/Standard/Deep, then click
Game review. A local streaming job publishes each move as it finishes. Cancel
stops receiving the job; partial rows remain inspectable/exportable without final
accuracy/rating summaries. No incomplete game is presented as a completed review.

The interface includes:

- Player names and result from PGN headers, with separate White/Black accuracy.
- Read-only chessboard, last-move highlights, flip, arrow buttons and move list.
- Left/Right, Home/End keyboard navigation (disabled while typing in form fields).
- White-perspective evaluation bar/graph and timeline slider.
- Classification legend/counts and Next key moment navigation.
- Played and best-line branches, clickable moves, return to game and open in Analysis.
- A local explanation for every move, with deeper shared Coach explanation on demand.
- Review JSON export containing scores, search depths, legal lines/FENs, summary,
  engine identity, algorithm version and a completion flag.

The eval label refers to the selected game position while a candidate branch is
being explored; branch positions are not separately reanalyzed in this UI.

## Engine and chess semantics

Implementation: `backend/game_review.py`; route registered in `backend/main.py`.

1. Parse a single standard PGN with python-chess. Comments and side variations are
   accepted; the main line is reviewed. SetUp/FEN and Black-to-move starts work.
   Reject illegal moves, invalid boards, games continuing after automatic terminal
   outcomes, unsupported variants, multiple games, empty games and >400 plies.
   Request text is capped at 150,000 characters; browser uploads at 150 KB.
2. Create a dedicated Stockfish process per review, Threads=1, Hash=64 MB,
   UCI_ShowWDL=true. It does not hold the interactive Coach's shared engine lock.
3. Search up to three candidates before each move. Then independently analyze the
   position after the played move, preserving the full move stack. This avoids
   relying only on a root-constrained line that can miss a short opponent tactic.
   The before search gets up to one node allowance per candidate; after gets one.
4. Compare scores from the original mover's perspective. Store separate cp and
   mate types plus White-perspective scores. When lifting an after-position mate
   score back to the root, add the just-played move only for a winning mover mate.
   Mate is never subtracted from a centipawn number.
5. Exact automatic terminal boards override engine estimates: checkmate or draw.
   PGN resignation/result headers do not override board evaluation. FEN/move stack
   supports repetition context; claimable draws are not assumed to have been claimed.
6. Replay candidate lines legally, stopping at automatic game termination. Return
   up to eight plies (four moves by each side), with FEN after every move.
7. Produce classifications, local teaching observations, accuracy and summary.

| Quality | Nodes per allowance | Depth cap |
| --- | ---: | ---: |
| Quick | 20,000 | 14 |
| Standard | 80,000 | 18 |
| Deep | 240,000 | 22 |

Each engine call also has a 3-second time cap. These are maximum budgets, not a
promise of reaching the displayed depth cap. Actual depths and a search-limited
flag are returned. A review can differ by Stockfish version, machine speed and
search budget; a larger budget should be used to investigate surprising labels.

A bounded semaphore allows one review at a time (HTTP 429 otherwise). A worker
thread owns the engine and sends events to an asynchronous SSE reader. Disconnect
signals cancellation; the worker exits after its current bounded move (normally
at most two 3-second search calls plus startup/overhead). Its finally block releases
the slot and engine even on errors. Reviews are not saved server-side.

## Classification

Expected points are Stockfish's native `WDL.expectation()` from the mover's view:
`(wins + draws/2) / total`. If WDL is unavailable, python-chess's fixed sf16 score
model is used. This is an engine outcome model, **not Chess.com's rating-dependent
human model**. Player username, rating headers, account history and elapsed move
times never change the policy.

`loss = max(0, best_expected - played_expected)`.

| Ordinary label | Expected-points loss |
| --- | --- |
| Best | Strongest move found by this search |
| Excellent | <0.02 |
| Good | 0.02 to <0.05 |
| Inaccuracy | 0.05 to <0.10 |
| Mistake | 0.10 to <0.20 |
| Blunder | >=0.20 |

Special labels take precedence in this order:

1. **Book:** the legal position+move edge is present in the bundled reference,
   loss <0.05, and the move does not end the game. Named opening data contains
   losing traps (including Fool's Mate), so a lookup must not conceal an error.
2. **Brilliant (heuristic):** near-best (loss <0.02), played expected >=0.5,
   next candidate expected <0.9, and a real offer of the moved minor/major piece.
   A legal same-square exchange search (up to five reply levels) checks whether
   an opponent can gain at least two material points from accepting the piece,
   accounting for material captured by the original move. Do not award it for
   simply exchanging queens or for being already winning with every candidate.
   This is intentionally conservative and misses sacrifices of unmoved pieces,
   long combinations and many positional sacrifices. It is not a sacrifice proof.
3. **Great (heuristic):** the best move preserves >=0.45 expected points and exceeds
   the next sampled candidate by >=0.10. This is a search distinction, not a proof
   that every other legal move loses.
4. **Best:** strongest searched move; ties can be effectively equivalent.
5. **Miss (heuristic):** the opponent just lost >=0.10 expected points, a >=0.75
   winning chance became available, but the move leaves <0.60 with loss >=0.05.
6. The ordinary loss bands above.

Expected-score saturation matters: in an already overwhelmingly won/lost position,
large cp differences can produce small expected loss. Classification and accuracy
use different outcome mappings and need not move in lockstep. No search label
certifies exhaustive chess truth.

## Accuracy

For a non-mate cp score:

```text
winPercent(cp) = 100 / (1 + exp(-0.00368208 * cp))
lossPercent = max(0, bestMoverWinPercent - playedMoverWinPercent)
moveAccuracy = clamp(103.1668 * exp(-0.04354 * lossPercent) - 3.1669, 0, 100)
```

Winning mates map to 100 and losing mates to 0. For each side, combine:

- A mean weighted by local standard deviation of the White win-percent trajectory
  (window clamp(game plies / 10, 3, 8), minimum weight 0.5).
- The harmonic mean of its move accuracies (0.01 numerical floor).

Game accuracy is the average of these means, rounded to one decimal. This follows
the published Lichess approach with Forked's explicit window/edge conventions; it
is neither guaranteed identical to Lichess production nor Chess.com CAPS2. An
absent side in a FEN-start fragment has null accuracy rather than a fabricated 0.

## Experimental game strength

There is no defensible way to recover an exact Elo from a single short game
without a calibrated dataset. The UI therefore calls this **estimated game strength**
and marks it **not calibrated Elo**. A side needs at least eight non-book,
non-forced decisions whose best expected score lies strictly between 0.1 and 0.95.
Games dominated by opening theory or already-decided positions can have no estimate.

Current disclosed heuristic, applied separately to each side:

```text
estimate = roundTo50(clamp(2800 - 600 * ln(1 + 100 * meanExpectedLoss), 400, 2800))
margin = max(300, roundTo50(900 / sqrt(informativeMoveCount)))
range = clamp(estimate +/- margin, 400, 2800)
```

The displayed range is a heuristic sensitivity band, **not a statistical confidence
interval**. It ignores game length outside the informative sample, position
complexity and time control. Do not use it as a tournament rating, calibrated
performance rating, player-skill measurement or cheating detector. Calibration
against a diverse rated corpus and held-out evaluation are future work.

## API

`POST /api/game-review/analyse` with `{ "pgn": "...", "quality": "standard" }`.
SSE event types: `start` (headers/initial FEN/total), `move` (one reviewed ply),
`done` (both summaries/engine/version) or `error`. Invalid input uses HTTP 400/422;
unavailable local engine returns 503; concurrent review returns 429. The frontend
rejects a stream that ends without a done event. Cancelling a request never marks
a partial export complete.

## Validation and recommended manual tests

Backend tests cover invalid/multiple PGNs, FEN/Black starts, classification
boundaries, book traps, mate polarity, legal PV playback, castling/en passant/
underpromotion, terminal draws, sacrifice-vs-exchange distinction, minimum rating
samples and the Opera Game mating net. The browser test uses the real backend for
PGN upload, bad-input feedback, Fool's Mate, cancellation/restart, full Opera Game,
keyboard/branch navigation, JSON export and desktop/mobile layout.

```powershell
.venv/Scripts/python.exe -m pytest tests/test_game_review.py -q -p no:cacheprovider
node scripts/test_game_review.cjs
```

Try these yourself:

1. **Try the Opera game**, Standard, then Deep. Play through the final Qb8+/Nxb8/
   Rd8# sequence. The final board and explanation must agree about checkmate.
2. Paste `1. f3 e5 2. g4 Qh4# 0-1`. The losing g4 must be a blunder even though
   the named trap appears in the opening reference; Black's mate is positive for
   Black and negative on the White-perspective evaluation display.
3. Upload a real 40+ move PGN. Inspect both summaries, classifications and key
   moments. Where there is enough information, both game-strength estimates should
   appear; they are illustrative, not claims about the players' actual ratings.
4. Navigate a move, play its best line, return to game, flip, use keyboard arrows,
   and export. The displayed board must match the selected move/branch.
5. Cancel a Deep review, then retry. Partial moves must not have a completed
   summary; the next job should become available when the bounded worker exits.
6. Submit an illegal PGN, a multi-game file and a FEN-start fragment. Errors must
   be clear and legal fragments must preserve fullmove number and side to move.
7. Use **Explain the idea** on a quiet move, a blunder and a sacrifice. Compare
   with the same pre-move FEN and focus move in Coach. Report the question, budget,
   explanation and exported evidence when a label or explanation seems wrong.
