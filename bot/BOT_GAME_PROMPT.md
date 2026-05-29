# Claude Code prompt — Maia2 training bot: WebSocket backend + frontend game UI

## What we're building

A playable chess game against a Maia2-powered bot. The bot plays at
user_elo + 50 — slightly stronger than the user, feels like a tough but
beatable human opponent. No blindspot logic yet. Focus is entirely on
making the game experience feel great: smooth board, human-like thinking
delays, clean UI, solid WebSocket reliability.

This is a new feature added to the existing Forked codebase.
Read CLAUDE.md and stage1.md for full project context before starting.

---

## Stack constraints

- Backend: FastAPI + WebSocket (already in backend/main.py)
- Frontend: React + TypeScript (already set up)
- Chess board: react-chessboard + chess.js (already in frontend)
- Maia2: weights already downloaded in maia2_models/ directory
  Run via Leela Chess Zero (lc0) UCI interface — same as Stockfish
- No new dependencies unless absolutely necessary

---

## Task 1 — Maia2 move generator

Create `src/bot/maia_engine.py`:

- Wrap lc0 as a UCI engine using python-chess engine interface
- Maia2 is skill-conditioned — pass the target ELO via UCI options
- Single function: `get_move(fen: str, target_elo: int) -> str`
  Returns a UCI move string (e.g. "e2e4")
- Use nodes=1 limit — this is critical. Maia2 at nodes=1 plays like
  a human making a quick decision. More nodes = stronger but less human.
- Engine should be initialized once as a singleton at module level,
  not per-move (loading lc0 has overhead)
- Handle engine crash/restart gracefully — if get_move raises, restart
  the engine and retry once before propagating the error
- Log each move with: FEN, target_elo, move returned, time taken

---

## Task 2 — Thinking delay simulator

Create `src/bot/thinking_delay.py`:

Human players don't respond in 50ms. The delay should feel natural.

Rules:
- Base delay: random between 1.5s and 3.5s
- Add complexity bonus: count the number of legal moves in the position.
  More legal moves = more complex = longer think.
  bonus = (legal_move_count / 40) * 2.0 seconds, capped at 2.0s
- Add check bonus: if the position has a check, add 0.5s
  (player needs to find the escape)
- Total cap: 8.0 seconds (never make user wait longer than this)
- Minimum: 1.0 second (never respond instantly)

Single async function: `async def think(board_fen: str) -> None`
Computes the delay, calls asyncio.sleep, returns.
This runs concurrently with move generation so the delay and move
generation happen in parallel — whichever takes longer wins.

---

## Task 3 — WebSocket game server

Add a WebSocket endpoint to `backend/main.py`:

`WS /ws/bot-game/{game_id}`

Game state (store in memory dict, keyed by game_id):
```
{
  "board": chess.Board(),
  "user_color": "white" | "black",
  "user_elo": int,
  "target_elo": int,          # user_elo + 50
  "status": "active" | "finished",
  "move_history": [],          # list of UCI strings
  "result": None | "1-0" | "0-1" | "1/2-1/2"
}
```

Message protocol (JSON):

CLIENT → SERVER:
```
{ "type": "move", "move": "e2e4" }           # user plays a move
{ "type": "resign" }                          # user resigns
{ "type": "offer_draw" }                      # user offers draw
```

SERVER → CLIENT:
```
{ "type": "game_start", "fen": "...", "user_color": "white", "target_elo": 1450 }
{ "type": "move_made", "move": "e7e5", "fen": "...", "by": "bot" | "user" }
{ "type": "thinking" }                        # bot is thinking — show indicator
{ "type": "game_over", "result": "1-0", "reason": "checkmate" | "resignation" | "draw" }
{ "type": "error", "message": "..." }
```

Game flow:
1. Connection opens → send game_start
2. If user is black → immediately start bot move sequence
3. Receive user move → validate it → send move_made (by: user) →
   check game over → send thinking → run think() and get_move()
   concurrently → send move_made (by: bot) → check game over
4. On disconnect → clean up game state after 5 minutes
   (user might reconnect)

Validation: reject illegal moves with error message, don't crash.

---

## Task 4 — Game creation endpoint

`POST /api/bot-game/create`

Request body:
```json
{ "user_color": "white" | "random" }
```

Auth required. Reads user's ELO from their profile.
Creates a game_id (uuid), initializes game state, returns:
```json
{ "game_id": "...", "user_color": "white", "target_elo": 1450 }
```

`GET /api/bot-game/{game_id}`

Returns current game state (for reconnection):
```json
{
  "game_id": "...",
  "fen": "...",
  "user_color": "white",
  "target_elo": 1450,
  "status": "active",
  "move_history": ["e2e4", "e7e5", ...]
}
```

---

## Task 5 — Frontend game page

Create `frontend/src/pages/BotGame.tsx`

The page has two sections: the board on the left, info panel on the right.

### Board section
- Use react-chessboard for the board
- Board orientation matches user color (white plays from bottom)
- Highlight last move (both squares — from and to)
- Highlight user's king square in red if in check
- Drag and drop moves — validate with chess.js before sending to server
- Show promotion dialog when a pawn reaches the back rank
- Disable interaction when it's the bot's turn

### Info panel
- Bot name: "Maia · {target_elo}" with a small robot icon
- vs
- User name: "{username} · {user_elo}"
- Thinking indicator: animated dots when bot is thinking
  ("Maia is thinking..." with 3 bouncing dots)
  Appears after "thinking" message, disappears when move arrives
- Move history: scrollable list of moves in algebraic notation
  (pairs: "1. e4 e5  2. Nf3 Nc6" etc)
  Auto-scrolls to latest move
- Game result banner: shown when game ends
  "You won!" / "Maia won" / "Draw"
  With a "Play again" button and a "Back to dashboard" button
- Resign button: with confirmation dialog ("Are you sure you want to resign?")

### Navigation
- Add "Play vs Bot" button to the main dashboard
  Clicking it calls POST /api/bot-game/create with user_color: "random"
  then navigates to /bot-game/{game_id}

### WebSocket connection
- Connect on mount, disconnect on unmount
- On disconnect: show "Connection lost — reconnecting..." banner,
  attempt reconnect every 3 seconds, up to 5 attempts
- On reconnect: call GET /api/bot-game/{game_id} to restore state,
  then reconnect WebSocket
- Handle all message types from the protocol above

---

## Task 6 — Basic game persistence (optional but recommended)

Store finished games in a `bot_games` table:
- game_id, user_id, user_color, target_elo, result, move_history (JSON),
  started_at, finished_at

This lets us later: detect if the bot exploited a blindspot in a real
game, feed the game through Stage 1 pipeline, update mastery scores.
Just create the model and save on game_over for now — don't wire to
pipeline yet.

---

## Experience quality checklist

These make the difference between a demo and a product:

- [ ] Bot never responds in under 1 second (feels robotic)
- [ ] Board highlights last move clearly
- [ ] Check is visually indicated on the king square
- [ ] Promotion dialog appears (not auto-promotes to queen silently)
- [ ] Illegal move attempts are silently rejected (piece snaps back)
- [ ] "Maia is thinking..." indicator appears immediately after user moves
- [ ] Smooth piece animation (react-chessboard handles this — don't override)
- [ ] Move history updates in real time
- [ ] Game over state is clear — result banner is prominent
- [ ] "Play again" works without page refresh
- [ ] Board is not interactive during bot's turn
- [ ] Resign has a confirmation step

---

## What NOT to build yet

- Blindspot detection (comes later)
- ELO boost / blending layer (comes later)
- Post-game debrief with blindspot moments (comes later)
- Time controls / clock (comes later)
- Chat (never)
- Opening book (Maia2 handles this implicitly)

---

## Definition of done

- [ ] POST /api/bot-game/create returns game_id
- [ ] WS /ws/bot-game/{game_id} handles full game from start to game_over
- [ ] Illegal moves rejected without crash
- [ ] Bot thinking delay feels human (1–8 seconds, complexity-weighted)
- [ ] Maia2 engine initialized as singleton, restarts on crash
- [ ] Frontend board renders, user can drag pieces
- [ ] Bot thinking indicator shows/hides correctly
- [ ] Move history updates in real time
- [ ] Game over banner shows with result and play again button
- [ ] "Play vs Bot" button on dashboard navigates to game page
- [ ] WebSocket reconnection handles disconnect gracefully
- [ ] Finished games saved to bot_games table
