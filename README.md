<div align="center">
  <img src="frontend/public/logo.png" alt="Forked" width="160" />

  <h1>Forked</h1>
  <p><strong>Every move has a reason.</strong></p>
  <p>
    A chess trainer built on your own games. Forked reads the rated games you've
    already played, finds the patterns that cost you points compared with players
    at your level, and trains them away with puzzles, a human-like sparring
    partner, an engine-checked coach and a pre-game warm-up.
  </p>
</div>

---

## What's inside

Sign up with a name, user ID, email and your Chess.com or Lichess username (no
login to those sites; Forked only reads public games). Your rapid rating is
fetched live, your games are analysed, and you land on a hub of sections:

| Section | What you get |
|---|---|
| **Dashboard** | Your live rapid rating, accuracy vs your opponents, a five-skill radar vs peers, when in a game you blunder (normalised by game length), your average evaluation across the game, conversion of winning positions, trends, and your blindspots ranked by what they cost. "Rating if fixed" shows the points each pattern costs, as a turning-point estimate. |
| **Openings** | Lichess opening tree for the rating bracket you choose (Lichess players, by speed, or OTB masters), Stockfish eval on every move, short hand-written ideas for 50+ named openings with sources, and "Play vs Maia from here" on any node. The tree stays where you left it. |
| **Endgames** | Theory tree whose every result is checked against the Syzygy tablebase, and practice from any material set-up against Maia (1100–2600) or full-strength Stockfish. |
| **Warm-Up** | 3/5/10-minute pre-game routines of board-vision and thinking drills, a custom mode to pick your own drills, and an opt-in experiment that checks whether warming up changes your next game. |
| **Drills** | Spaced-repetition puzzles for your costliest skill families, with stored progress: puzzles solved, streaks, day streak and how many of your real-game mistakes you've drilled. |
| **Puzzle Themes** | The full Lichess theme catalogue with per-theme ratings, plus your own games as puzzles: positions where you blundered ("find the move you should have played") and tactics you missed. |
| **Play vs Maia** | A human-like opponent from 600 to 2800 on your own platform's rating scale (Maia-2, with an engine check above 2000), full-strength Stockfish, an "analysed" mode that labels every move live, and one click into a full Game Review afterwards. |
| **AI Coach** | A chat coach that investigates positions with Stockfish before it explains anything, with saved conversations you can reopen together with their board, plus a screen-share voice mode. |
| **Game Review** | Chess.com-style review (accuracy calibrated to Chess.com's stored figures), saved forever: reopen any reviewed game move by move without recomputing, and jump straight to each mistake and blunder with the best move shown. |
| **Analysis Board** | Paste a PGN or FEN, branch from any move, run a background review of a loaded game while you keep analysing, and set up any position in a board editor. |
| **Game History** | Your platform games (rapid / blitz / bullet filters, mistakes and blunders per game) and a Forked history of Maia games, practice games, reviewed games and scanned OTB games. Reviewed games open instantly. |
| **OTB Scan** | Photograph a handwritten scoresheet; a vision model reads it, a legal-move decoder rebuilds the game, you confirm flagged moves, and the game goes to Game Review or the Analysis Board. Previous scans are kept. |

Evaluations are shown in points (pawns), never centipawns: a −193 cp swing reads
as −1.9 pts.

## How the blindspot profile works

```
Chess.com / Lichess username
   │
   ▼  Stage 1: annotate and classify
   Last 80–200 rated rapid games → Stockfish (depth 12, depth 18 on critical moves, cached per game)
   Mistakes = ≥10% loss of winning chances (Lichess curve), for you AND your opponents
   Each tagged: did you allow a tactic, miss one, both, or slip quietly?
   Classified in the matching position by a multi-label chess transformer + a port of
   Lichess's own puzzle tagger
   │
   ▼  Stage 2: compare with your peers
   5 skill families: loose pieces · alignment · defender disruption · king safety · positional
   Your rate per 100 moves vs your opponents in the same games (rating-matched baseline)
   → confirmed / emerging / typical / strength, cost per 10 games, tactics found vs available
   │
   ▼  Stage 3: train
   Theme-matched Lichess puzzles in your rating band, budget split by cost, SM-2 spacing
```

Measured results (`reports/stage12_eval/`): on held-out real-game blunders that
allowed a tactic, the right skill family is found 87% of the time (29% before
v2). Game Review accuracy is within 3.4 points of Chess.com's stored accuracy on
held-out games (`backend/GAME_REVIEW.md`).

## Run it locally

Requirements: Python 3.10+ (3.12 tested on Windows), Node 18+.

```bash
git clone https://github.com/ShahuPatil07/Forked.chess.git
cd Forked.chess
python -m venv .venv
.venv\Scripts\activate                 # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
pip install torch --index-url https://download.pytorch.org/whl/cpu
python scripts/setup_stockfish.py      # downloads the Stockfish binary
```

Create `.env` in the project root:

```
GROQ_API_KEY=gsk_...          # free; coach fallback chain + insights
LICHESS_TOKEN=lip_...         # free; the Opening Explorer needs it
# Optional
DEEPSEEK_API_KEY=...          # paid, cheap: first choice for the coach and OTB Scan
GEMINI_API_KEY=...            # free tier: extra coach capacity
FORKED_DEV_LOGIN=0            # hide the developer sign-in shortcut
MAIA3_UCI_CMD=maia3-uci       # use Maia-3 for Play vs Maia if installed (see below)
```

One-time data builds:

```bash
python scripts/run_puzzle_import.py        # puzzle index for Drills
python scripts/build_theme_index.py        # Puzzle Themes index (~8 min, needs the Lichess puzzle CSV)
python scripts/build_endgame_positions.py  # endgame practice positions
```

Start it:

```bash
uvicorn backend.main:app --port 8000                  # API
cd frontend && npm install && npm run dev             # http://localhost:5173
```

In production one process serves both (`npm run build`, then the API serves
`frontend/dist`). The trained Stage-1 checkpoints in `models/` are not in git;
copy them in or retrain (see `instructions/stage1.md`).

### Optional: Maia-3

Play vs Maia uses Maia-2 out of the box. If you install Maia-3 (AGPL-3.0, from
[CSSLab/maia3](https://github.com/CSSLab/maia3)) so that `maia3-uci` is on your
PATH, or point `MAIA3_UCI_CMD` at it, Forked uses it automatically:

```bash
pip install git+https://github.com/CSSLab/maia3.git
maia3-cache --model maia3-23m
```

## Accounts and data

There is no database by design. Accounts live in `data/users/` (scrypt-hashed
passwords, hashed session tokens, 30-day sessions, login throttling); each
player's games, reviews, scans and coach chats live in `data/library/{user}/`;
pipeline state lives in `data/output/`. All of these are git-ignored. Writes are
atomic (temp file + rename) and locked per file, so concurrent requests can't
corrupt them. The developer shortcut on the sign-in page opens the maintainer's
demo account and can be turned off with `FORKED_DEV_LOGIN=0`.

**Developer auth skip.** In `npm run dev` the sign-in screen is skipped: opening
any app page without a session signs straight into the developer account.
Signing out pauses the skip for that browser tab (so the sign-in and
registration screens can still be tested); `/dev` signs back in, and
`/dev?next=/coach` lands on a specific page. Set `VITE_DEV_AUTH_SKIP=0` in
`frontend/.env.local` to turn the skip off in dev; production builds never skip
unless built with `VITE_DEV_AUTH_SKIP=1`.

## Tests

```bash
.venv/Scripts/python -m pytest tests -q -p no:cacheprovider --ignore=tests/test_coach_live.py
cd frontend && npx tsc --noEmit && npx vite build
```

`tests/test_coach_live.py` calls hosted models and is run by hand.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how every part fits together, for developers
- [PLANS.md](PLANS.md): what comes next
- [instructions/stage1.md](instructions/stage1.md): the blindspot pipeline in detail
- [backend/GAME_REVIEW.md](backend/GAME_REVIEW.md): review method and calibration
- [backend/coach/README.md](backend/coach/README.md): the coach agent

## Credits

Lichess (open puzzle database, opening explorer, tablebase API), Stockfish,
CSSLab's Maia models, and the ChessGoals rating-comparison survey behind the
Chess.com ↔ Lichess rating conversion.
