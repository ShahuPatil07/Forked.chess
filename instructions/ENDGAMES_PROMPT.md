# Claude Code prompt — Endgames Theory Section

## Context

Read CLAUDE.md, OPENING_EXPLORER_PROMPT.md, and OPENING_COACH_PROMPT.md
before starting. This feature adds a new "Endgames" section to Forked,
parallel to the Openings section. It has three independent sub-features:
a theory tree, practice games vs Maia, and a theory chatbot.

No personalisation in this section — it serves all users equally.
The blindspot pipeline (Stage 1/2) is completely separate from this page.

---

## The three features

### Feature 1 — Endgame Theory Tree
### Feature 2 — Play vs Maia (endgame positions)
### Feature 3 — Endgame Coach (RAG chatbot)

Route: `/endgames`

Add "Endgames" to main navigation between Openings and Analysis Board.

---

## Architecture overview

The page has three tabs at the top:
- "Theory" → Feature 1
- "Practice" → Feature 2
- "Coach" → Feature 3

Each tab is fully independent. Default tab on load: Theory.

---

## Feature 1 — Endgame Theory Tree

### What it is

A navigable tree of solved endgame theory, organised by material
configuration. Unlike openings (which branch from a common root by move
sequence), endgames are organised by piece type — the user selects a
category, then navigates into sub-positions and key theoretical concepts.

The Syzygy tablebase API (`tablebase.lichess.ovh`) verifies every position
shown — the tree only shows positions with known perfect-play outcomes.

### Tree structure

Top level — material categories (always shown):
```
King + Pawn endings
King + Rook endings
King + Queen endings
King + Minor Piece endings
Rook endings
Minor piece endings
Pawn endings (multi-pawn)
```

Each category expands into named theoretical positions and concepts:

```
King + Pawn endings
├── King + Pawn vs King
│   ├── Rule of the Square
│   ├── Opposition
│   ├── Key Squares
│   └── Rook Pawn exceptions
├── King + 2 Pawns vs King
│   ├── Connected pawns
│   ├── Doubled pawns
│   └── Separated pawns
└── Opposition and related concepts
    ├── Direct opposition
    ├── Distant opposition
    └── Diagonal opposition

King + Rook endings
├── Lucena Position
│   ├── Building the bridge
│   └── Variations
├── Philidor Position
│   ├── Passive defence
│   └── Active defence (Rook behind)
├── King + Rook vs King
│   ├── Box method
│   └── Staircase method
└── Rook + Pawn vs Rook
    ├── Pawn on 7th rank
    ├── Pawn on 6th rank
    └── Pawn on 5th or below

King + Queen endings
├── King + Queen vs King (basic mate)
├── King + Queen vs King + Pawn
│   ├── Pawn on 7th rank
│   └── Rook pawn / Bishop pawn stalemate traps
└── Queen + Pawn vs Queen

King + Minor Piece endings
├── King + Bishop vs King (drawn)
├── King + Knight vs King (drawn)
├── King + 2 Bishops vs King
├── King + Bishop + Knight vs King
└── King + 2 Knights vs King (usually drawn)

Rook endings
├── Rook activity principles
├── Passive vs active rook
├── Rook behind passed pawn
└── Rook + Pawn vs Rook (see King + Rook endings)

Minor piece endings
├── Bishop vs Knight
│   ├── When bishop is better
│   └── When knight is better
├── Good bishop vs bad bishop
├── Bishop + Pawn vs Bishop
└── Knight endings

Pawn endings
├── Triangulation
├── Breakthrough combinations
├── Outside passed pawn
└── Zugzwang positions
```

Hardcode this full tree structure in a constants file
`frontend/src/data/endgameTree.ts`. Do not fetch it from an API —
it's static curriculum content that changes rarely.

### Each tree node

Every leaf node (a named theoretical concept) has:
- A canonical FEN representing the key position
- A short title (the concept name)
- A result indicator: "White wins" / "Black wins" / "Draw" / "Depends"
  (verified against Syzygy where applicable)
- A difficulty badge: Beginner / Intermediate / Advanced

When a leaf node is selected, the right panel shows:

1. **Interactive board** (202×202px) — the canonical position
   Reuse `drawBoard` utility from opening explorer

2. **Position name + result badge**
   e.g. "Lucena Position" + "White wins with correct play"

3. **Tablebase verification badge**
   "✓ Syzygy verified" for positions with ≤7 pieces
   Fetch from `tablebase.lichess.ovh/standard?fen={fen}` to confirm
   the result and best first move. Show DTM (distance to mate) or DTZ
   (distance to zeroing) where available.

4. **Typical ideas paragraph**
   Same RAG approach as opening coach — fetched from endgame knowledge
   base (see Feature 3 setup). If not yet cached, generate with Groq.

5. **"Practice this position" button**
   → switches to Practice tab with this position pre-loaded
   (passes the FEN to Feature 2)

6. **"Ask the coach" button**
   → switches to Coach tab with a pre-filled question:
   "Explain the {position_name} and how to play it correctly"

### Syzygy API integration

`GET https://tablebase.lichess.ovh/standard?fen={fen}`

Returns: `category` (win/loss/draw/cursed-win/blessed-loss),
`dtm` (distance to mate), `moves` (all legal moves with their category).

Use this to:
- Verify the result shown in the tree (one-time at build time, cache result)
- In the detail panel: show the tablebase-verified best move
- In Feature 2 (practice): verify whether user's move was optimal

Cache all Syzygy results in `endgame_syzygy_cache` table (fen PK, result,
dtm, best_move, fetched_at). Never re-fetch for the same FEN.

---

## Feature 2 — Practice vs Maia

### What it is

The user selects a material category and difficulty, gets a curated endgame
starting position, and plays it out against Maia at a chosen rating.
This reuses the entire bot game WebSocket infrastructure already built —
it's the same game loop, just with a non-starting position.

### UI

Full-width layout (no split panel — the game is the focus):

Top bar:
- "← Back to Endgames"
- Position name + difficulty badge
- "New position" button (gets a different position from same category)

Board area: same as bot game page (already built)

Right panel:
- Maia ELO selector: 1100 / 1300 / 1500 / 1700 / 1900
  (these are the actual Maia model weights available)
  Default to the nearest weight to the user's settings ELO on load,
  but let the user change it manually. Show as "Maia · {selected_elo}".
- Position info: material configuration, who to move, objective
  ("White to play — win this K+P endgame")
- Tablebase result for this position:
  "Syzygy: White wins in 23 moves with best play"
- After game ends: show whether user achieved the theoretical result
  "You drew — this position is a win for White. Try again?"
  "You won — correct! Syzygy confirms this is a win."
- Move history (same as bot game)
- "Ask coach about this position" → switches to Coach tab

### Position selection

Create `backend/routers/endgames.py`.

`GET /api/endgames/practice-position`
Query params: `category` (e.g. "kp_vs_k"), `difficulty` (beginner/intermediate/advanced), `exclude_fens` (comma-separated FENs to avoid repeating)

Returns a curated position from the endgame position database.

### Endgame position database

Create `scripts/build_endgame_positions.py`.

Curate a set of practice positions for each category and difficulty level.
Target: 20-30 positions per (category × difficulty) combination.
~500 positions total.

For each position:
- FEN
- Category
- Difficulty
- Objective (win/draw for the side to move)
- Syzygy-verified result and DTM
- Short description ("Lucena position — White rook on a1, pawn on e7")

Source positions from:
- Endgame studies in public domain (pre-1928 compositions)
- Programmatically generated positions that are Syzygy-verified
  (generate random positions meeting material criteria, verify with
  Syzygy API, keep the instructive ones)
- Well-known theoretical positions (Lucena, Philidor, Vancura, etc.)

Store in `endgame_positions` table:
```
id            uuid PK
category      text
difficulty    text
fen           text
objective     text  (win_white / win_black / draw)
dtm           int nullable
description   text
active        bool default true
```

### WebSocket integration

Reuse `WS /ws/bot-game/{game_id}` entirely. The only change: pass
`starting_fen` in the POST /api/bot-game/create request body instead of
always using the initial position.

Add `starting_fen` field to the game creation endpoint. If provided, the
game starts from that FEN instead of the standard starting position.

The Maia engine already handles non-starting positions — it just needs
the FEN passed to it.

After game ends, call Syzygy API to determine if the user achieved the
correct theoretical result (win when it's a win, draw when it's a draw).
Show a result evaluation: "Correct result ✓" or "Incorrect — you {drew/lost}
a {winning/drawing} position."

---

## Feature 3 — Endgame Coach (RAG chatbot)

Same architecture as the opening coach. Independent — not connected to
what position is selected in the Theory tab.

### Knowledge base

**Primary sources (scrape once, embed, cache forever):**

Wikibooks Chess Strategy — endgame chapters:
`https://en.wikibooks.org/wiki/Chess_Strategy/Endgame`
`https://en.wikibooks.org/wiki/Chess/Endgame`
Extensive coverage of endgame principles and specific positions.

Wikipedia endgame articles:
Fetch all pages in Category:Chess_endgames. ~80 pages covering every
major endgame type with theory, examples, and historical context.

Chess Stack Exchange — endgame questions:
Fetch Q&A tagged: endgame, king-and-pawn-endgame, rook-endgame,
pawn-endgame, minor-piece-endgame, queen-endgame, tablebase.
~2,000 Q&A pairs. Excellent for "why is this a draw?" type questions.

**Public domain endgame literature:**
Scrape and include content from freely available endgame references.
Reuben Fine's "Basic Chess Endings" (1941) — copyright expired, available
at archive.org. This is the most comprehensive endgame reference ever
written and is now public domain. Extract the text and include it.
`https://archive.org/details/basicchessending00fine`

This alone makes the Forked endgame coach more knowledgeable than anything
Chess.com or Lichess offers — a full professional endgame reference book
as the knowledge base.

Create `scripts/scrape_endgame_sources.py` — similar to the opening scraper
but targeting endgame URLs. Store to `data/endgame_sources/`.

Create `scripts/embed_endgame_chunks.py` — same chunking/embedding approach
as openings (all-MiniLM-L6-v2, 384-dim, pgvector).

Store in `endgame_knowledge_chunks` table — same schema as
`opening_knowledge_chunks` but separate table.

### Backend endpoint

`POST /api/endgames/coach/chat`

Same structure as `/api/openings/coach/chat` with these differences:

- **User rating from settings** — fetch the user's ELO from their
  settings profile (same field used everywhere else in Forked). Pass
  it into the system prompt so every answer is calibrated to their level.
  A 1200-rated player asking "how do I play the Lucena?" gets a different
  answer than a 1800-rated player asking the same question. The 1200
  gets "start by getting the rook to the a-file and build the bridge
  step by step." The 1800 gets the full Lucena with the key defensive
  tries and how to meet them.

  Level descriptions (same as opening coach):
  - < 1000:   "beginner — focus on basic mating patterns and king activity"
  - 1000-1400: "club beginner — learning fundamental endgame technique"
  - 1400-1800: "intermediate — can handle specific plans and manoeuvres"
  - 1800-2000: "advanced — full technique with defensive resources"
  - > 2000:   "strong player — theoretical depth and practical nuances"

- System prompt includes user rating from settings profile.
  Fetch user ELO at request time and pass into the prompt.
  Tailor every answer to their level — a 1200 gets the core idea and
  key moves, a 1800 gets the full technique with defensive resources.
  Level descriptions: <1000 beginner, 1000-1400 club beginner,
  1400-1800 intermediate, 1800-2000 advanced, 2000+ strong player.
- Scope: endgame theory and technique only. Decline opening questions:
  "I specialise in endgame theory — for opening questions, the Opening
  Coach would serve you better."
- Tablebase integration: for positions with <=7 pieces, query Syzygy
  and include verified result in context. "Syzygy confirms this is a
  win for White in 31 moves." Cite as verified fact, not opinion.
- No position context required (chatbot is standalone)

`GET /api/endgames/coach/suggestions`
Same as opening coach suggestions but endgame-themed defaults:
"How to play Lucena?", "When is K+B+N vs K a draw?",
"Explain the Philidor position", "Rook endgame principles"

### Frontend

Same component structure as OpeningCoach.tsx — copy the pattern, not
the code. Create `EndgameCoach.tsx` as an independent component.

Key difference: add a "Tablebase verified" badge on responses where
Syzygy data was used to ground the answer. This is the unique trust
signal — "this answer is mathematically verified, not an opinion."

---

## Backend routes summary

All in `backend/routers/endgames.py`:

```
GET  /api/endgames/practice-position     — get curated position
GET  /api/endgames/syzygy?fen={fen}      — tablebase lookup (cached)
POST /api/endgames/coach/chat            — streaming RAG chat
GET  /api/endgames/coach/suggestions     — quick prompt chips
```

---

## Database tables (Alembic migration)

```
endgame_positions          — curated practice positions
endgame_syzygy_cache       — fen → tablebase result (permanent cache)
endgame_knowledge_chunks   — scraped + embedded endgame theory
endgame_suggestions_cache  — quick prompt cache
```

---

## Frontend structure

```
frontend/src/pages/Endgames.tsx          — main page with 3 tabs
frontend/src/components/endgames/
  EndgameTree.tsx                        — Feature 1 tree
  EndgameDetail.tsx                      — right panel for theory tab
  EndgamePractice.tsx                    — Feature 2 practice tab
  EndgameCoach.tsx                       — Feature 3 chatbot
frontend/src/data/endgameTree.ts         — hardcoded tree structure
frontend/src/api/endgames.ts             — API client
frontend/src/hooks/useEndgameCoach.ts    — coach state management
```

---

## Build order

1. `frontend/src/data/endgameTree.ts` — hardcode full tree structure
2. DB migrations for all 4 tables
3. `scripts/build_endgame_positions.py` — curate and store ~500 positions
4. `scripts/scrape_endgame_sources.py` — scrape Wikibooks, Wikipedia,
   Chess SE, and archive.org Fine book
5. `scripts/embed_endgame_chunks.py` — embed and store
6. `backend/routers/endgames.py` — all 4 endpoints
7. Add `starting_fen` param to bot-game creation endpoint
8. `EndgameTree.tsx` + `EndgameDetail.tsx` — Feature 1
9. `EndgamePractice.tsx` — Feature 2 (reuses bot game WebSocket)
10. `EndgameCoach.tsx` + `useEndgameCoach.ts` — Feature 3
11. `Endgames.tsx` — main page with tabs wiring all three
12. Add Endgames to navigation

---

## Definition of done

- [ ] Endgames added to main navigation
- [ ] Three tabs render: Theory, Practice, Coach
- [ ] Theory tree shows all 7 top-level categories
- [ ] All categories expand to named theoretical positions
- [ ] Selecting a leaf node shows detail panel with board, result, ideas
- [ ] Syzygy result fetched and cached for all leaf node FENs
- [ ] "Practice this position" navigates to Practice tab with FEN
- [ ] "Ask the coach" navigates to Coach tab with pre-filled question
- [ ] Practice tab shows Maia ELO selector (1100/1300/1500/1700/1900)
- [ ] Practice tab loads curated position from selected category
- [ ] Game plays via existing WebSocket infrastructure with starting_fen
- [ ] After game ends: Syzygy result compared to user's result
- [ ] "Correct result" / "Incorrect" evaluation shown after game
- [ ] ~500 curated positions in endgame_positions table
- [ ] Endgame sources scraped (Wikibooks, Wikipedia, Chess SE, Fine book)
- [ ] ~8,000 endgame chunks embedded in pgvector
- [ ] Sanity check queries return relevant endgame content
- [ ] POST /api/endgames/coach/chat streams grounded responses
- [ ] Syzygy data injected into coach answers for specific positions
- [ ] "Tablebase verified" badge shown on relevant responses
- [ ] Coach declines opening questions with redirect message
- [ ] Suggestion chips work with and without position context
- [ ] All Syzygy results cached permanently
- [ ] No regressions in opening explorer or bot game
