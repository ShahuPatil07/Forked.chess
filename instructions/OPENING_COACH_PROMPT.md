# Claude Code prompt — Opening Coach (RAG chatbot)

## Context

Read CLAUDE.md and OPENING_EXPLORER_PROMPT.md before starting. This feature
adds a conversational opening coach to the opening explorer page.

The tree and the coach are two independent tools on the same page. A user
can use only the coach (ask questions without touching the tree), only the
tree (browse without asking anything), or both together. The coach never
requires a tree selection to function. When a position is selected in the
tree, it becomes optional context the coach can use — but the coach answers
any opening question regardless.

The opening coach must outperform every existing opening resource. Answers
are grounded in real chess opening literature, not AI-generated content.

---

## What the coach is

A standalone RAG-powered chess opening coach. The user can ask any question
about chess openings at any time. The coach:

- Answers questions about any opening, any variation, any depth
- Handles "what are the plans in the Sicilian Najdorf?" with no tree
  interaction required
- If a position happens to be selected in the tree, uses it as additional
  context but does not require it
- Maintains multi-turn conversation within the session
- Knows the user's rating and tailors answer depth accordingly
- Is grounded in Wikibooks, Wikipedia, and Chess Stack Exchange content
- Cites sources visibly

Strictly opening-related questions only. Deflect anything else:
"I specialise in opening theory — for that question, the analysis board
would serve you better."

---

## Knowledge base construction

### Sources (CC-licensed, legally clean)

**Primary: Wikibooks Chess Opening Theory**
`https://en.wikibooks.org/wiki/Chess_Opening_Theory`
~1,500 opening variation pages. Each has plans, move explanations, named
traps, sub-variations. The core of the knowledge base.

**Secondary: Wikipedia chess opening articles**
`https://en.wikipedia.org/wiki/List_of_chess_openings`
~100 major opening articles. Historical context, notable players, strategic
themes. Supplements Wikibooks.

**Tertiary: Chess Stack Exchange**
`https://chess.stackexchange.com`
~3,000 Q&A pairs tagged with opening theory. Excellent for "what if opponent
plays X?" style questions that match real user queries.

**Quaternary: Lichess opening tree data**
Pre-fetch and store WDL stats + top moves for all 500 ECO positions AND for
every position in the Lichess opening explorer tree down to depth 8 moves.
This gives the coach real game frequency data for virtually any mainstream
position a user might ask about — not just the 500 ECO anchor positions.

Fetch from `https://explorer.lichess.org/lichess?fen={fen}&topGames=0` for
each position. Store as structured data in `opening_lichess_stats` table
keyed by FEN. This table is queried at chat time to inject real statistics
into any answer about any position.

---

### Step 1 — Scrape the text sources

Create `scripts/scrape_opening_sources.py`.

**Wikibooks scraper:**
Start from the Chess Opening Theory index page. Follow all internal links
to variation pages (URLs like `/wiki/Chess_Opening_Theory/1._e4/1...e5/...`).
Extract title + prose content per page. Strip navigation and wiki markup.
Store as `{ source, url, title, content }`. 1 second crawl delay. Cap 2,000
pages.

**Wikipedia scraper:**
Use Wikipedia API to fetch all pages in Category:Chess_openings and
Category:Chess_defences. Extract plain text, strip references sections.

**Chess Stack Exchange scraper:**
Use Stack Exchange API (no auth needed). Fetch questions + accepted answers
(score > 5) tagged with: openings, opening-theory, sicilian-defense,
ruy-lopez, queens-gambit, kings-indian, caro-kann, french-defense,
english-opening, nimzo-indian, queens-indian, grunfeld-defense, and 10 other
major opening tags. Store `{ source, url, title, content }`. Cap 3,000 pairs.

Store all to `data/opening_sources/` as JSONL files per source.

---

### Step 2 — Clean and chunk

Create `scripts/chunk_opening_sources.py`.

Clean: remove HTML, wiki markup, navigation boilerplate. Normalise chess
notation. Discard chunks under 100 characters.

Chunk: 400-600 tokens per chunk, split on paragraph boundaries, 50-token
overlap between adjacent chunks. Each chunk keeps metadata: source, url,
title, opening_name (extracted from title/URL), eco_hint where detectable.

Output: `data/opening_chunks/all_chunks.jsonl`. Expected ~10,000 chunks.

---

### Step 3 — Embed and store

Create `scripts/embed_opening_chunks.py`.

Use `sentence-transformers` with `all-MiniLM-L6-v2` (384-dim, runs on CPU,
~2ms per chunk). Batch size 64. No external embedding API.

Store in pgvector table `opening_knowledge_chunks`:
```
id            uuid PK
source        text
url           text
title         text
opening_name  text
eco_hint      text nullable
content       text
embedding     vector(384)
created_at    timestamp
```

Add ivfflat index: `USING ivfflat (embedding vector_cosine_ops) WITH (lists=100)`

Sanity check after embedding:
- "Ruy Lopez plans for White" → top 3 must be Ruy Lopez content
- "Sicilian Najdorf traps" → top 3 must be Najdorf content
Log results before proceeding.

---

### Step 4 — ECO index + Lichess stats

**ECO index:**
Fetch `https://raw.githubusercontent.com/niklasf/eco/master/dist/eco.tsv`
(public domain, maintained by Lichess). Store all 500 ECO entries in
`opening_eco_index` table: eco, name, fen, moves, chunk_ids (top 10
most relevant chunk IDs by semantic similarity to opening name).

**Lichess stats for all positions:**
Pre-fetch WDL + top moves from Lichess explorer API for:
- All 500 ECO FEN positions
- All positions reachable within 8 half-moves from the starting position
  (this covers virtually everything a user will ask about)

Store in `opening_lichess_stats` table: fen (PK), top_moves (JSON),
total_games (int), w_pct, d_pct, l_pct, fetched_at.

At chat time, when a user asks about a position, look up this table by FEN
to inject real statistics. The coach can say "Nf3 is played in 79% of
master games here" as a fact, not an estimate.

---

## Backend

### New file: `backend/routers/opening_coach.py`

---

#### `POST /api/openings/coach/chat`

Auth required. Streaming endpoint (Server-Sent Events).

Request body:
```json
{
  "message": "What are the main plans in the Sicilian Najdorf?",
  "conversation_history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "selected_position": {
    "fen": "...",
    "name": "Ruy Lopez",
    "eco": "C65",
    "moves_played": "e4 e5 Nf3 Nc6 Bb5"
  }
}
```

`selected_position` is OPTIONAL. Null if user hasn't selected anything in
the tree. The endpoint must work fully without it.

**Pipeline:**

1. **Scope check** — keyword heuristic for non-opening questions. Deflect
   endgame, tactical puzzle, material count questions immediately. Edge cases:
   proceed rather than refuse.

2. **Query construction:**
   Combine the user's message with any position context if provided:
   ```
   "{user_message}"
   ```
   If selected_position exists, append: `"in the context of {name} {eco}"`
   This keeps retrieval focused on what the user actually asked, not locked
   to the selected position.

3. **Retrieval — two-stage:**

   Stage A: If eco is provided in selected_position, fetch the ECO index
   chunk_ids for that ECO and rank by similarity to query. Top 4 chunks.

   Stage B: Semantic search across ALL chunks. Top 6 by cosine similarity
   to query embedding. Deduplicate against Stage A results.

   Final: up to 8 chunks total. Stage A preferred, Stage B fills gaps.
   If no position selected: Stage B only (pure semantic search).

4. **Lichess stats injection:**
   If selected_position FEN provided: look up `opening_lichess_stats` for
   that FEN and include.
   If no position: skip stats injection. The coach answers from text sources.

5. **User context:** fetch user ELO from profile.

6. **Groq streaming call** with the full prompt below.

7. **Source attribution:** collect unique source URLs from retrieved chunks.

**System prompt:**
```
You are an expert chess opening coach with deep knowledge of opening theory.
Your answers are grounded in real chess literature — be specific, cite named
variations, mention concrete moves and plans.

RULES:
- Answer any opening theory question — you are not limited to any specific
  position. Answer whatever the user asks.
- If a "current position" is provided below, you may use it as additional
  context, but answer the user's actual question even if it's about a
  different opening entirely.
- Only decline questions that are clearly not about opening theory
  (endgames, tactics, general evaluation). Use this exact message:
  "I specialise in opening theory — for that question, the analysis board
  would serve you better."
- Ground every answer in the provided source material. Reference specific
  content — named traps, specific move orders, historical players.
- When Lichess statistics are available, cite them as facts.
- Tailor depth to the user's rating level.
- Prose only — no bullet points. 3-6 sentences for simple questions,
  up to 2 short paragraphs for complex ones.
- For unusual opponent moves, give the specific best response.

User rating: {user_elo} ({level_description})

Current position (optional context, may be unrelated to user's question):
{selected_position_or_none}

SOURCE MATERIAL (from chess opening literature):
{retrieved_chunks_with_sources}

Lichess master game statistics (if available):
{lichess_stats_or_none}

Conversation history:
{conversation_history}
```

Level descriptions same as before (beginner/intermediate/advanced/strong).

---

#### `GET /api/openings/coach/suggestions`

Query params: `eco` (optional), `user_elo`

Returns 4 quick-prompt chips. Behaviour differs based on whether eco is
provided:

**If eco provided** (position selected in tree):
Generate position-specific suggestions for that ECO.
Example for Ruy Lopez: ["Why Ba4 over Bxc6?", "Black's main counterplay?",
"Best line for my rating?", "Common traps here?"]

**If no eco** (coach opened standalone):
Return general opening study prompts appropriate for user's rating level.
Examples for 1400: ["Best openings for my level?", "How to handle the Sicilian?",
"Explain the Ruy Lopez", "What is the Queen's Gambit?"]

Cache position-specific suggestions per ECO (30 day TTL).
General suggestions cached per rating band (1 week TTL).

Fallback defaults always available instantly — never block on Groq.

---

### New DB tables (Alembic migration)

```
opening_knowledge_chunks    — scraped + embedded text chunks
opening_eco_index           — ECO → chunk mapping
opening_lichess_stats       — FEN → WDL stats + top moves
opening_suggestions_cache   — eco (nullable) + rating_band → suggestions
```

---

## Frontend

### Layout

The opening explorer page has two independent panels:

Left panel (flex: 1): the opening tree
Right panel (fixed 280px): the opening coach

Both panels are always functional. The coach panel is never in a "disabled"
or "waiting for selection" state. It's an active chat interface from the
moment the page loads.

When a user selects a node in the tree:
- The tree highlights that node (existing behaviour)
- The coach receives the position as optional context
- The coach's suggestion chips refresh for that ECO
- A subtle context indicator appears at the top of the coach panel:
  "Context: {opening name}" with a small board icon and an X to dismiss it
- The user can dismiss this context and the coach returns to general mode

When no position is selected (or context dismissed):
- The coach operates in general mode
- Suggestions are rating-appropriate general opening questions
- All questions answered from full knowledge base

---

### New component: `frontend/src/components/openings/OpeningCoach.tsx`

Props: `{ selectedNode: OpeningNode | null, userElo: number }`

**Header:**
Robot/sparkle icon + "Opening coach" title

**Context indicator** (shown only when a position is selected):
Small dismissable banner below the header:
```
[mini board icon] Ruy Lopez (C65)  [×]
```
Clicking × clears the selected position context (does not deselect the tree
node — tree and coach state are independent).

**Conversation area (scrollable, flex: 1):**
- User messages: right-aligned, purple background
- Coach messages: left-aligned, secondary background
- Chess moves in coach messages: monospace bold (e.g. **Nf3**)
- Source attribution below each coach message in small text with links:
  "Sources: Wikibooks · Chess Stack Exchange"
- Responses stream word by word
- Loading: animated dots while first token pending

**Suggestion chips:**
- 4 chips always shown below welcome message and after each response
- Context-aware when position selected, general when not
- Clicking fills and submits input
- Skeleton chips while loading, instant fallbacks always available

**Input area:**
- Placeholder: "Ask about any opening, plan, or variation..."
- ALWAYS active — never disabled
- Send on Enter, Shift+Enter for newline
- Disabled only while a response is actively streaming

**No position board in the coach panel** — the tree already shows the board
when a node is selected. Duplicating it in the coach panel creates confusion
about which tool owns the board. Remove this from the earlier design.

---

### Conversation persistence

Conversation resets only on full page navigation away from /openings.
Selecting/deselecting tree nodes does not reset conversation.

When position context changes (new node selected):
- Keep all prior messages
- Insert subtle divider: "— {opening name} selected as context —"
- Refresh suggestion chips

When context dismissed:
- Keep all prior messages
- Insert subtle divider: "— Context cleared —"
- Return to general suggestion chips

---

### Hook: `frontend/src/hooks/useOpeningCoach.ts`

Manages: `messages`, `isStreaming`, `suggestions`, `positionContext`,
`sendMessage()`, `clearContext()`.

`positionContext` is set when the user selects a tree node. `clearContext()`
sets it to null. Both happen independently of tree state — the coach hook
owns its own copy of context, not a reference to the tree's selected node.

---

## What makes this better than everything else

1. **Completely standalone** — no tree interaction required. Works like a
   pure chess opening chatbot. This is the use case Chess.com and Lichess
   have nothing for.

2. **Grounded in real literature** — Wikibooks, Wikipedia, Chess SE.
   Named traps, specific variations, historical depth. Sources visible.

3. **Rating-aware** — tailored answers at every level.

4. **Multi-turn context across topics** — conversation persists and the
   coach remembers prior discussion even when topics change.

5. **Optional position context** — tree and coach are independent tools
   that can collaborate but don't require each other.

6. **Lichess stats for any position** — pre-fetched for all mainstream
   positions, injected as facts when relevant.

7. **Source citations** — every answer shows where it came from with links.

---

## Build order

1. `scrape_opening_sources.py` — run and verify
2. `chunk_opening_sources.py` — clean + chunk
3. `embed_opening_chunks.py` — embed + verify sanity checks
4. Populate `opening_eco_index` from Lichess ECO TSV
5. Pre-fetch `opening_lichess_stats` for all ECO FENs + depth-8 positions
6. Alembic migrations for all four tables
7. `backend/routers/opening_coach.py`
8. `frontend/src/hooks/useOpeningCoach.ts`
9. `frontend/src/components/openings/OpeningCoach.tsx`
10. Wire into `OpeningExplorer.tsx` — replace static right panel with coach

---

## Definition of done

- [ ] Wikibooks ~1,500 pages scraped
- [ ] Wikipedia ~100 articles scraped
- [ ] Chess Stack Exchange ~3,000 Q&A pairs scraped
- [ ] ~10,000 chunks embedded in pgvector
- [ ] Sanity check queries return relevant results
- [ ] opening_eco_index populated for 500 ECO codes
- [ ] opening_lichess_stats populated for ECO FENs + depth-8 positions
- [ ] POST /api/openings/coach/chat works with NO selected_position
- [ ] POST /api/openings/coach/chat uses selected_position as optional context
- [ ] Responses grounded in scraped literature, sources returned
- [ ] Lichess stats injected when position context available
- [ ] User ELO used to tailor depth
- [ ] Conversation history maintained and used
- [ ] Non-opening questions deflected correctly
- [ ] GET /api/openings/coach/suggestions works with and without eco param
- [ ] General suggestions returned when no ECO provided
- [ ] Position-specific suggestions returned when ECO provided
- [ ] Coach panel always active — input never disabled
- [ ] Context indicator shown when position selected, dismissable
- [ ] Dismissing context clears it from coach without affecting tree
- [ ] Suggestions refresh on position change
- [ ] Responses stream word by word
- [ ] Source attribution shown below each coach message
- [ ] Conversation persists across position changes
- [ ] Position-change dividers inserted automatically
- [ ] No position board in coach panel
- [ ] No regressions in opening tree behaviour
