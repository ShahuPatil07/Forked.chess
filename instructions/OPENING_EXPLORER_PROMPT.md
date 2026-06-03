# Claude Code prompt — Opening Explorer

## Context

Read CLAUDE.md before starting. This is a new feature added to the existing
Forked codebase. The opening explorer is a standalone section of the product —
completely independent from the personalized blindspot pipeline. It serves any
chess player at any level who wants to learn openings.

The goal: build the best opening explorer available to any chess player for
free. Better than Chess.com's (static table with a board on the side) and
better than Lichess's (good data, poor UX). Our differentiator is the
interactive tree UI, engine eval on every node, WDL bars from real games,
AI-generated "typical ideas" descriptions, and lazy-loading depth up to 10
moves.

---

## How the feature works

The user lands on /openings. They see a collapsible tree of opening moves
starting from the initial position. Each node in the tree shows:
- A mini board thumbnail of the resulting position
- The move in algebraic notation
- A popularity bar
- Engine eval badge
- Win/Draw/Loss bar

Clicking a node expands it to show responses, and also populates a detail
panel on the right with: a larger board, full opening name, engine eval,
WDL stats, and a paragraph of typical ideas for that line.

The tree supports up to 10 half-moves (5 full moves) of expansion depth.
Beyond that, the tree shows a "reached depth limit" message. The Lichess
explorer API provides real data for all positions.

---

## Data sources

### Lichess Opening Explorer API

No auth required. Free. Fast.

`GET https://explorer.lichess.org/lichess?fen={FEN}&play={moves}&topGames=0&recentGames=0`

Returns for each position:
- `moves[]` — list of moves with: `san`, `uci`, `white`, `draws`, `black`
  (game counts, not percentages — compute percentages yourself)
- `opening` — `{ name, eco }` if a named opening

Popularity = (white + draws + black) for that move / total games at position.
WDL = white / total, draws / total, black / total.

Always fetch with `topGames=0&recentGames=0` to keep responses fast and small.

### Opening names

Lichess returns `opening.name` for positions that have ECO codes. Use this
as the node label. For positions without a named opening, derive a label from
the parent's name + the move (e.g. "Ruy Lopez: 4. Ba4").

### AI-generated "typical ideas" — Groq API

The description paragraph for each opening node is generated once via Groq
and cached permanently in the database. Never regenerate for the same position.

Use the existing Groq API integration already in the codebase. The model is
`llama-3.3-70b-versatile`.

Prompt template:
```
You are a chess coach writing for intermediate players (1000–1800 ELO).

Opening: {opening_name}
Position FEN: {fen}
Side to move: {side}
Move just played: {move}

Write a single paragraph (4–6 sentences) describing the typical ideas,
plans, and strategic themes for both sides in this position. Be concrete —
mention piece placement, pawn breaks, and typical manoeuvres. Do not mention
specific move numbers or use bullet points. Write in plain prose.
```

Generate the description asynchronously — don't block the tree from loading
while it generates. Show a subtle skeleton/loading state in the detail panel
ideas section while it loads.

---

## Backend

### New file: `backend/routers/openings.py`

All endpoints require no auth — the opening explorer is public.

---

#### `GET /api/openings/explore`

Query params: `fen` (required), `moves` (optional, space-separated UCI moves
e.g. `e2e4 e7e5 g1f3`)

Logic:
1. Fetch from Lichess explorer API with the given FEN and moves
2. For each move returned, compute popularity % and WDL %
3. Sort by popularity descending
4. Return top 8 moves maximum (prune rare lines with < 1% popularity)
5. For each move, check if an AI description is cached in the DB
6. Return everything — cached descriptions inline, null for uncached ones

Response shape:
```json
{
  "opening": { "name": "Ruy Lopez", "eco": "C60" },
  "moves": [
    {
      "san": "Nf3",
      "uci": "g1f3",
      "name": "King's Knight Opening",
      "popularity": 79,
      "w": 36, "d": 33, "l": 31,
      "eval": null,
      "ideas": "White attacks the e5 pawn...",
      "fen_after": "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
    }
  ]
}
```

`eval` is null initially — engine eval is fetched separately (see below).
`fen_after` is computed by applying the move to the input FEN using python-chess.

---

#### `GET /api/openings/eval`

Query params: `fen`

Runs Stockfish depth-16 on the given FEN. Returns:
```json
{ "eval": "+0.3", "depth": 16 }
```

Cache this in the DB keyed by FEN. Stockfish eval for any given position never
changes — cache indefinitely.

Run Stockfish at depth 16 (not 18 or 20 — the opening explorer doesn't need
maximum depth and we want fast response). Use the existing Stockfish singleton
from the annotation pipeline.

---

#### `POST /api/openings/ideas`

Body: `{ "fen": "...", "move": "Nf3", "opening_name": "King's Knight Opening" }`

Generates and caches the AI description for one position. Called by the
frontend when a node is expanded and no cached description exists. Returns:
```json
{ "ideas": "White attacks the e5 pawn and develops..." }
```

If the description already exists in the cache, return it immediately without
calling Groq. Otherwise call Groq, save to cache, return.

---

### Database

Add two new tables (Alembic migration):

`opening_ideas_cache`
- `fen` (primary key, string)
- `ideas` (text)
- `created_at` (datetime)

`opening_eval_cache`
- `fen` (primary key, string)
- `eval` (string, e.g. "+0.3")
- `depth` (int)
- `created_at` (datetime)

---

## Frontend

### New page: `frontend/src/pages/OpeningExplorer.tsx`

Route: `/openings`

Add "Openings" to the main navigation alongside Dashboard, Drills, etc.

---

### Layout

Two-panel layout:
- Left panel (flex: 1, scrollable): the opening tree
- Right panel (fixed 240px, scrollable): position detail

On narrow screens (< 700px): stack vertically — detail panel moves below
the tree.

---

### Tree component: `frontend/src/components/openings/OpeningTree.tsx`

State:
- `expandedNodes: Set<string>` — keys are FEN strings
- `selectedNode: NodeData | null`
- Root is always shown (the 4 main first moves: e4, d4, c4, Nf3)

Each tree node renders:
- Mini board canvas (44×44px) drawn with the position after the move
- Expand chevron icon (rotates when open)
- Move in monospace font
- Opening name below the move (truncated if too long)
- Right side: eval badge + popularity %

Clicking a node:
1. Marks it as selected (highlight border)
2. Sets it as the detail panel's active node
3. If it has no children loaded yet: call GET /api/openings/explore with
   the node's FEN, show loading dots, render children when response arrives
4. If already expanded: collapse (hide children, don't destroy them)

Depth limit: if depth >= 10, don't render an expand chevron. Show a small
"—" indicator instead. Clicking a depth-10 node still shows detail but
doesn't expand.

Children are indented with a left border line to show hierarchy visually.
Indent per depth level: 54px (mini board width + gap).

---

### Detail panel: `frontend/src/components/openings/OpeningDetail.tsx`

Sections from top to bottom:

1. Board canvas (202×202px) — the position after the move

2. Move + opening name
   - Move in large monospace (18px)
   - Full opening name below (12px, secondary color)
   - ECO code badge if available (e.g. "C60")

3. Stats row
   - Popularity: "{n}% of games"
   - Engine eval badge (fetched async from /api/openings/eval, shows
     skeleton while loading)

4. WDL bar
   - Three-segment horizontal bar: white wins (purple), draws (grey),
     black wins (dark)
   - Labels below: "36% W  33% D  31% L"

5. Typical ideas section
   - Label: "TYPICAL IDEAS" in small caps
   - The paragraph text, or a skeleton loading state while Groq generates it
   - If no ideas cached: fire POST /api/openings/ideas immediately on node
     selection and show skeleton until it resolves

6. "Ask about this line" button
   - Calls sendPrompt equivalent: navigates to chat with pre-filled message
     "Tell me more about the {opening_name} — key plans, traps and model games"
   - Or just a copy button that copies that prompt

---

### Board drawing

Reuse the same canvas board drawing logic from the bot game feature (or
BotGame.tsx if already built). Extract it to
`frontend/src/utils/drawBoard.ts` — a shared utility so it's not duplicated
across OpeningExplorer and BotGame.

Function signature: `drawBoard(canvas: HTMLCanvasElement, fen: string): void`

Draws an 8×8 board with pieces using Unicode chess symbols. Light/dark
aware (check `prefers-color-scheme`).

---

### API client: `frontend/src/api/openings.ts`

Typed functions for all three backend endpoints. Handle errors gracefully —
if Lichess API is down, show "Explorer temporarily unavailable" rather than
crashing.

---

### Loading states

- Tree node expansion: show 3 animated dots ("...") as placeholder children
  while the API call is in flight. Replace with real children on success.
- Eval badge: show a grey "—" while loading, replace with the value.
- Ideas paragraph: show 3 lines of skeleton (grey rounded bars, pulsing
  opacity) while generating. Replace with text on success.

---

## What makes this better than Chess.com and Lichess

These are non-negotiable quality bars:

1. **Mini board thumbnails on every node** — Chess.com shows only text moves
   in a table. Lichess shows only one board. We show the position at every
   node in the tree simultaneously, letting users visually scan lines.

2. **Lazy-loaded tree up to 10 moves deep** — neither Chess.com nor Lichess
   shows a tree UI. They show a flat list of moves. Our tree makes the
   hierarchical nature of opening theory visually navigable.

3. **AI-generated "typical ideas" paragraph** — neither Chess.com nor Lichess
   has this for every position. It's the difference between showing data
   and teaching.

4. **Engine eval on every node** — Lichess explorer shows no eval. Chess.com
   shows eval only in the analysis board. We show it directly in the tree.

5. **Instant expand/collapse** — already-loaded children must not re-fetch.
   State is preserved — collapsing and re-expanding a node is instant.

6. **WDL bar from millions of real games** — Lichess has this in their
   explorer but not in a tree UI. We combine real game statistics with the
   tree navigation.

---

## Performance requirements

- First paint of the tree (4 root moves): < 500ms
- Node expansion (fetch + render children): < 1.5s including Lichess API call
- Eval fetch: < 800ms (Stockfish depth-16 is fast)
- Ideas generation: < 4s (Groq is fast, skeleton shown during wait)
- Already-expanded nodes: instant (no re-fetch)

---

## Definition of done

- [ ] GET /api/openings/explore returns correct moves from Lichess API
- [ ] GET /api/openings/eval returns cached Stockfish eval
- [ ] POST /api/openings/ideas generates and caches Groq description
- [ ] Both DB tables created with Alembic migration
- [ ] /openings route renders the two-panel layout
- [ ] Tree shows 4 root moves on load
- [ ] Clicking a node expands it and fetches children
- [ ] Depth limit enforced at 10 half-moves
- [ ] Already-expanded nodes collapse/expand without re-fetching
- [ ] Detail panel shows board, name, ECO, eval, WDL, ideas
- [ ] Eval loads asynchronously with skeleton state
- [ ] Ideas load asynchronously with skeleton state
- [ ] Mini board thumbnails render correctly for all positions
- [ ] drawBoard extracted to shared utility
- [ ] "Openings" added to main navigation
- [ ] Handles Lichess API being down gracefully
- [ ] No auth required for any opening endpoint
- [ ] Ideas and eval are cached — never regenerated for same position
