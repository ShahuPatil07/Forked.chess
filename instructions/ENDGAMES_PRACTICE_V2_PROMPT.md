# Claude Code prompt — Endgames Practice tab improvements

## Context

Read CLAUDE.md before starting. Three targeted improvements to the existing
endgames section. Do not touch Theory tab or Coach tab structure.

---

## Fix 1 — Move history navigation (bug fix)

### Problem
Move history renders correctly but clicking a past move does nothing.
The board stays on the current position.

### Fix
Add a `viewingMoveIndex` state to the practice game component, separate
from the actual game state. The game continues progressing via WebSocket
regardless of which move the user is viewing.

Behaviour:
- Clicking a move in the history list: replay the move sequence through
  chess.js up to that index, display that FEN on the board
- Show a subtle banner above the board: "← Reviewing move {N}" with an
  "× Back to live" button that snaps back to the current position
- Arrow keys ← / → step through moves when in review mode
- Clicking "× Back to live" or pressing → past the last move exits review
- The WebSocket game state is completely unaffected by review mode

Extract this logic into `frontend/src/hooks/useGameReview.ts` and apply
the same hook to the main bot game page (`BotGame.tsx`) as well — the
same bug exists there.

---

## Fix 2 — "Analyse on analysis board" button in Theory tab detail panel

When a user selects a leaf node in the Theory tab, the right panel shows
a large board and position details. Add a button below the board:

"Open in Analysis Board →"

Clicking it navigates to `/analysis?fen={encoded_fen}` — passing the
current position FEN as a query parameter. The Analysis Board page should
already handle `?fen=` query params (check if it does — if not, add that
handling so it loads with the given FEN pre-set).

---

## Improvement 3 — Practice tab: piece configuration selector

### What to remove
The current category grid (King+Pawn, King+Rook, etc.) and difficulty
selector. Replace entirely with the piece configurator described below.

### Piece configurator UI

Two columns side by side: White and Black. Kings are always present,
shown as a static label "♔ King" — not selectable.

For each side, show 5 piece type buttons: Q R B N P
Each button shows the piece symbol and a count badge.
Click to increment, right-click or long-press to decrement.
Show the full selection as text below: "K + R + 2P" etc.

Limits per piece type: Q max 1, R max 2, B max 2, N max 2, P max 8.
Total non-king pieces per side: max 7.
Minimum: at least one non-king piece on either side total.

**Vague/quick-select mode:**
Above the detailed configurator, show a text input with placeholder
"e.g. queen pawn endgame, rook ending, knight vs bishop..."
If the user types here instead of clicking pieces, send the text as a
`description` param to the backend — the backend interprets it and
maps it to a material configuration (use simple keyword matching:
"rook" → R each side, "queen pawn" → Q+P vs Q, "knight bishop" →
B+N vs something, etc.). The text input and the piece buttons are
two ways to specify the same thing — typing updates the buttons,
clicking buttons clears the text input.

Quick preset chips below the text input (always visible):
"K+R vs K+R"  "K+Q vs K+P"  "K+R vs K+B"
"K+B+N vs K"  "Q+pawns vs Q+pawns"  "Rook ending"

Clicking a preset fills both the text input and the piece buttons.

Maia ELO selector: keep exactly as is (1100-1900 manual selection).

"Find position" button: triggers position fetch with current config.
"Shuffle": gets a different position with the same config (passes
`exclude_fens` of already-seen positions for this config).

### How to fetch instructive positions

This is the most important part. A random FEN is not acceptable.
The position must be instructive — one that rewards correct technique
and punishes mistakes. Use this priority order:

**Priority 1 — Lichess puzzle database (already imported)**
Query the existing puzzle/position tables for puzzles matching the
exact material configuration. Endgame puzzles from Lichess are
real positions from real games — they are inherently instructive.
Filter: prefer puzzles where the puzzle theme includes "endgame",
"rookEndgame", "pawnEndgame", "queenEndgame", "bishopEndgame",
"knightEndgame", or "promotion". Take the FEN position *before*
the first puzzle move — this gives a position where the right plan
is non-trivial and mistakes are punishing.

**Priority 2 — Lichess master game database API**
`GET https://explorer.lichess.org/masters?fen={base_fen}&play={moves}`
Find games where the specified material configuration arose. Extract
the position at the point where material matches. Positions from
master games are instructive by definition — strong players got
there through real play and the position has natural piece placement.

**Priority 3 — Stockfish-filtered generation**
Generate candidate positions (random legal placement of the specified
pieces) and filter by:
- Stockfish depth-12 eval between -3.0 and +3.0 (not trivially over)
- At least 15 legal moves (not near zugzwang / trivial forced line)
- Principal variation length > 6 moves (requires real calculation)
- NOT in Syzygy tablebase if pieces ≤ 7 with DTM < 10 (too simple)
  — or if it IS in Syzygy, DTM must be > 20 (non-trivial)

From filtered candidates, rank by:
- Longest PV (most complex = most instructive)
- Eval closest to 0 (balanced = requires technique from both sides)
- Unique (not a position already seen by this user in this session)

Cache all generated positions in `endgame_positions` table with
`source` field ("puzzle_db" / "master_game" / "generated").

**The key insight:** a position is instructive if there are only
1-2 correct continuations and many plausible-looking wrong ones.
Stockfish PV length + eval balance is the best proxy for this.

### Backend endpoint

`POST /api/endgames/practice-position/by-config`

Request:
```json
{
  "white_pieces": { "Q": 1, "R": 0, "B": 0, "N": 0, "P": 2 },
  "black_pieces": { "Q": 1, "R": 0, "B": 0, "N": 0, "P": 1 },
  "description": "queen pawn endgame",
  "exclude_fens": [],
  "maia_elo": 1700
}
```

Response:
```json
{
  "fen": "...",
  "description": "Queen + 2 Pawns vs Queen + Pawn — White has a small advantage",
  "source": "puzzle_db",
  "eval_cp": 85,
  "complexity": "high",
  "syzygy_result": null,
  "side_to_move": "white"
}
```

`description` is auto-generated from material + eval:
- Near equal (abs eval < 100cp): "{type} ending — accurate play required"
- Slight advantage (100-200cp): "{winning side} has a slight edge — convert precisely"
- Clear advantage (200-400cp): "{winning side} is better — find the winning plan"
- Large advantage (>400cp): "{winning side} has a winning advantage"

`complexity` = "high" if PV > 8 moves AND legal moves > 15.

For `description` input interpretation (text mode):
Simple keyword map on the backend:
"rook" → R:1 each side
"queen" → Q:1 each side
"pawn" or "pawn ending" → P:2 each side, no other pieces
"knight" → N:1 for one side
"bishop" → B:1 for one side
"knight vs bishop" → N:1 white, B:1 black
"queen pawn" → Q:1 + P:2 white, Q:1 + P:1 black
"rook pawn" → R:1 + P:2 white, R:1 + P:1 black
For unrecognised input: default to R:1 vs R:1 (most common endgame type)

### Practice tab after position found

Configurator collapses to a one-line summary:
"♙ K+Q+2P vs K+Q+P  · Maia 1700  · [Reconfigure]"

Board expands to full height. Show:
- Position description (from response)
- Material tags
- Syzygy badge if applicable, otherwise no badge (don't show
  "not in tablebase" — it's noise for complex positions)
- "Shuffle ↺" button for same-config new position
- "Start" button to begin the game

Move history panel on the right is now navigable (Fix 1).

---

## Files to create/modify

**New:**
- `frontend/src/hooks/useGameReview.ts`
- `frontend/src/components/endgames/PieceConfigurator.tsx`

**Modify:**
- `backend/routers/endgames.py` — add `POST /api/endgames/practice-position/by-config`
- `frontend/src/components/endgames/EndgamePractice.tsx` — full replacement
  of category selector with PieceConfigurator
- `frontend/src/components/endgames/EndgameDetail.tsx` — add "Open in
  Analysis Board" button
- `frontend/src/pages/BotGame.tsx` — apply useGameReview hook
- `frontend/src/pages/AnalysisBoard.tsx` (or equivalent) — handle `?fen=`
  query param on load

---

## Definition of done

- [ ] Clicking a move in history navigates board to that position
- [ ] "Reviewing move N" banner + "× Back to live" shown in review mode
- [ ] ← / → keyboard navigation works
- [ ] useGameReview.ts extracted and applied to both BotGame and EndgamePractice
- [ ] "Open in Analysis Board →" button in Theory detail panel
- [ ] Analysis board loads with correct FEN from query param
- [ ] Piece configurator renders with Q/R/B/N/P buttons per side + counts
- [ ] Text input accepts vague descriptions ("queen pawn endgame")
- [ ] Typing updates buttons, clicking buttons clears text
- [ ] 6 preset chips fill configurator instantly
- [ ] Maia ELO selector preserved
- [ ] POST /api/endgames/practice-position/by-config endpoint works
- [ ] Backend tries puzzle DB first, master games second, generation third
- [ ] Generated positions filtered by eval, legal moves, PV length
- [ ] Positions cached in endgame_positions table
- [ ] Position description auto-generated from material + eval
- [ ] Configurator collapses to summary after position found
- [ ] "Shuffle" gets new position with same config, no repeats
- [ ] "Reconfigure" expands configurator
- [ ] Game starts from fetched FEN via existing WebSocket
- [ ] No regressions in Theory tab or Coach tab
EOF