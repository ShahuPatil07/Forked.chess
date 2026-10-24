# Forked: what comes next

Ordered roughly by value to players, then by effort. Each item says why it
matters and where it would land in the code. Nothing here is started unless
marked.

## Near term

### Accounts and trust
- **Require sign-in on every per-player endpoint.** `assert_owner` still lets
  anonymous requests through so local scripts keep working. Add a
  `FORKED_REQUIRE_AUTH=1` mode that rejects them, and switch scripts to a
  service token. (`backend/auth.py`, every router that calls `assert_owner`.)
- **Email verification and password reset.** Needs an email sender; keep it
  optional so local installs still work without one.
- **Verify chess-account ownership.** Today anyone can attach any public
  username. Lichess OAuth (PKCE, no secret) proves ownership for Lichess; for
  Chess.com, ask the player to put a one-time code in their profile "location"
  field and check it through the public API.
- **Move accounts to SQLite** once there are more than a few hundred users.
  The `storage.py` interface (`read_json` / `locked_update`) was kept narrow so
  this is a contained change. Ask before adding it.

### Dashboard and profile
- **Rating trend from the platform's own history**, not only from analysed
  games (Chess.com and Lichess both expose rating history).
- **Per-time-control profiles.** The pipeline is rapid-only by design; blitz
  players would benefit from a separate blitz profile computed the same way.
- **Explain each radar axis in place**, with the three games that moved it most.

### Training loop
- **Close the loop in Drills.** When a drilled family's live rate drops below
  the peer rate for 30+ games, retire it and say so on the dashboard.
- **Own-game puzzles in Drills.** Mix the player's real blunder positions
  (Puzzle Themes `game-blunders`) into SRS sessions for the same family.
- **Warm-Up experiment report.** Once enough opted-in players pass
  `min_games_per_arm`, publish the comparison on `/warmup/lab` with its
  confidence interval, including a null result.

### Game Review and analysis
- **Shareable review links** (read-only, opt-in per game).
- **Opening name and book exit** shown on the review summary using the curated
  opening index.
- **Engine lines on demand in Game Review** (MultiPV 3 for the selected move)
  reusing `/api/analyse`.

## Medium term

- **Maia-3 by default** when it can be installed from PyPI without native
  build steps, keeping Maia-2 as the fallback (`backend/bot/engines.py`).
- **OTB Scan live camera and video** (code exists in `features/otb-scan/`, not
  mounted). Needs a measured accuracy bar on real phone footage before launch.
- **Opening repertoire.** Let players mark the lines they play; show how they
  score in them from their own games, and drill deviations.
- **Endgame skill test.** A short placement test over the theory tree that
  marks which endgames a player can actually win/draw against Stockfish.
- **Coach memory across sessions** using the stored chats (summaries only,
  with a visible "what the coach remembers" page and a delete button).
- **Background jobs on a small worker pool** instead of single threads, so two
  long reviews or ingestions don't queue behind each other. Still no external
  queue.

## Quality and operations

- **Frontend tests.** Playwright flows for sign-up, review, Maia game and OTB
  hand-off exist only as ad-hoc scripts; move them into `scripts/` with a
  fixture account and run them in CI.
- **CI.** GitHub Actions: pytest (without live-model tests), `tsc`, `vite
  build`, the endgame-tree tablebase check.
- **Rate-limit outbound platform calls** per user (Chess.com archives,
  Lichess exports) and back off on 429.
- **Error reporting.** A small `/api/client-errors` sink so frontend crashes
  are visible to the maintainer.
- **Accessibility pass.** Keyboard play on every board, screen-reader move
  announcements, and a contrast check of chart colours in both themes.

## Not planned

Puzzle synthesis (Lichess already has millions), social features, a coaching
marketplace and native mobile apps stay out of scope. The web app is
responsive instead.
