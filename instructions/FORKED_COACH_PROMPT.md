# Claude Code prompt — Forked Coach (Persistent Agentic Chess Coach)

## Context

Read CLAUDE.md before starting. This is the most complex feature in Forked.
It is a persistent agentic AI coach that knows the user's game history,
remembers prior conversations, and can actively assist through multiple
interaction modes within a single chat interface.

The Forked Coach is the capstone that ties the entire product together.
Every other feature feeds into it: live sync alerts, blindspot clusters,
mastery scores, drill history, game replay — the coach has access to all
of it and uses it proactively.

---

## Architecture overview

Three layers of personalisation:

**Layer 1 — Questionnaire context (cold start)**
Captured once on first visit. Injected into every session as part of
the user profile. Overridden gradually by real game data.

**Layer 2 — Chat memory (cross-session)**
A rolling ~500-token "coach memory" document summarising prior sessions.
Updated after every session. Travels with every prompt so the coach
never re-introduces itself or repeats advice already given.

**Layer 3 — Live game data (Forked's unique advantage)**
A structured JSON context block injected automatically into every
system prompt. Contains: blindspot clusters, mastery scores, recent
games, alert history, drill performance. The coach starts every session
already knowing the user's current state — no retrieval needed.

---

## LLM strategy

The coach is **not** a single LLM call. It is a hybrid system:

**Primary LLM: Groq — `llama-3.3-70b-versatile`**
Handles all coaching conversation, memory management, motivational
communication, and tool orchestration. Use the same Groq client already
integrated in the project (opening coach, endgame coach both use it).

Model: `llama-3.3-70b-versatile`
Free tier: 14,400 requests/day, 30 RPM — more than sufficient for a
coaching session. Budget 1,000-2,000 tokens per exchange.

Tool use: Groq supports function calling with Llama 3.3 70B. Use the
same `tools` parameter format as the Groq API supports. Test tool
calling thoroughly — Llama 3.3 70B handles it well but occasionally
needs the tool schema descriptions to be very explicit.

No prompt caching available on Groq free tier. Keep the system prompt
concise — stay under 2,000 tokens for the system + user context block
combined to avoid burning token budget on context.

**Position explanation tool: C1 model (CSSLab)**
When the coach needs to explain a specific chess position — why a move
was wrong, what the correct plan is, what the pattern is — call C1
locally via its UCI-like interface. C1 generates grounded chain-of-thought
chess reasoning (see github.com/CSSLab/C1). C1 is used as a tool, not
the primary model. The coach receives C1's explanation and wraps it in
coaching language appropriate to the user's level.

C1 is only called when: a position/FEN is being discussed, a puzzle
explanation is requested, or a game moment needs detailed breakdown.
Not for general questions about plans or theory.

**Fallback for position explanation: Stockfish + template**
If C1 is not available or takes >3 seconds: fall back to Stockfish
depth-18 analysis + a structured explanation template filled with
the engine's output. Less natural but always reliable.

---

## Onboarding questionnaire

Shown once on first visit to the Coach page, before any chat.
5 questions, visual, completable in 90 seconds.

```
Q1 (button select): What's your current rating?
    [Under 800] [800–1200] [1200–1600] [1600–2000] [2000+]

Q2 (button select): How do you play?
    [Sharp & tactical] [Solid & positional]
    [Mixed / adaptable] [Still figuring it out]

Q3 (button select): Main goal right now?
    [Reach a specific rating] [Stop making blunders]
    [Understand chess better] [Beat a specific person]
    [Just enjoy improving]

Q4 (button select): Study time per week?
    [< 1 hour] [1–3 hours] [3–7 hours] [7+ hours]

Q5 (text input, optional, max 200 chars):
    "Anything specific you're struggling with? (optional)"
    placeholder: "e.g. I always blunder in time pressure, I lose rook endgames"
```

Store answers in `data/output/{username}_coach_profile.json`.
After 5 games are analysed, the game data becomes the primary source
of truth and the questionnaire answers become secondary context.
Never ask the questionnaire again.

---

## Session memory system

### coach_memory.json structure (per user)

```json
{
  "created_at": "...",
  "updated_at": "...",
  "session_count": 7,
  "summary": "...(rolling 500-token summary of all prior sessions)...",
  "topics_covered": [
    "Lucena position explanation — session 2",
    "Back-rank alert after game vs pedrominarelli — session 3",
    "User struggling with time pressure in blitz — session 4"
  ],
  "advice_given": [
    "Recommended drilling back-rank threats daily for 2 weeks",
    "Suggested switching to rapid from blitz to reduce time pressure errors"
  ],
  "breakthroughs": [
    "User understood back-rank pattern after seeing their own game replay"
  ],
  "communication_style": "technical",
  "preferred_depth": "detailed"
}
```

### Summary update (after each session)

After the user closes the coach or after 30 minutes of inactivity,
send the full session transcript to Groq with this prompt:
```
Update the coach memory for this user. The existing summary is:
{existing_summary}

The session that just happened (last {N} messages):
{session_transcript}

Write a new 500-token summary that:
1. Preserves important prior context
2. Adds key points from this session
3. Notes any changes in user understanding or progress
4. Notes the user's communication preferences
Return only the new summary text.
```

The updated summary replaces the old one. This is the only persistent
memory mechanism — no vector DB, no embedding, just a rolling prose summary.

---

## Layer 3 — User context block (injected every session)

Build this at session start from live data. Inject as the first user
turn prepended to the system prompt:

```python
def build_user_context(username: str) -> str:
    profile = load_profile(username)
    blindspots = get_blindspot_clusters(username)
    recent_games = get_recent_games(username, n=5)
    alerts = get_unseen_alerts(username)
    drill_history = get_drill_summary(username, days=14)

    return f"""
USER CONTEXT (always current — auto-injected):

Rating: {profile.elo} | Style: {profile.archetype}
Goal: {profile.questionnaire.goal}
Study time: {profile.questionnaire.study_time}

BLINDSPOT CLUSTERS (ranked by urgency):
{format_clusters(blindspots)}  # cluster_id, rank, label, mastery, last_triggered

RECENT GAMES (last 5):
{format_games(recent_games)}  # date, opponent, result, blindspot_triggered

UNREAD ALERTS:
{format_alerts(alerts)}  # if any

DRILL PERFORMANCE (last 14 days):
{format_drills(drill_history)}  # cluster drilled, accuracy, sessions

COACH MEMORY (prior sessions):
{profile.coach_memory.summary}
"""
```

This block is ~300-400 tokens. Prepend it to the system prompt.
Keep total system prompt + context under 2,000 tokens for Groq efficiency.

---

## Agent tools (function calling)

The coach has 6 tools it can call during a conversation.
Use Groq's tool use / function calling API (same client already in the project).

```python
TOOLS = [
    {
        "name": "get_mistake_positions",
        "description": "Fetch the actual board positions where the user "
                       "made mistakes matching a specific blindspot cluster. "
                       "Use when the user wants to see their real mistakes "
                       "or when a replay would help understanding.",
        "input_schema": {
            "cluster_id": "string",
            "limit": "integer (default 3, max 10)"
        }
    },
    {
        "name": "explain_position",
        "description": "Get a chess explanation for a specific FEN position. "
                       "Calls C1 model to generate grounded chain-of-thought. "
                       "Use when discussing a specific position or move.",
        "input_schema": {
            "fen": "string",
            "question": "string (e.g. 'why is Rd8 better than Qe4 here?')"
        }
    },
    {
        "name": "get_puzzle",
        "description": "Fetch a puzzle matching a specific tactical theme "
                       "or the user's top blindspot. Returns a FEN and "
                       "solution for inline display in the chat.",
        "input_schema": {
            "theme": "string (optional, e.g. 'back_rank', 'fork')",
            "cluster_id": "string (optional — use user's top blindspot)",
            "difficulty_elo": "integer (optional, default = user's elo)"
        }
    },
    {
        "name": "analyze_pgn",
        "description": "Run Stage 1 pipeline on a user-provided PGN or FEN. "
                       "Returns: mistakes found, threat types, eval drops. "
                       "Use when user pastes a game for analysis.",
        "input_schema": {
            "pgn_or_fen": "string"
        }
    },
    {
        "name": "get_opening_theory",
        "description": "Query the opening knowledge base (RAG) for theory "
                       "about a specific opening. Use in theory mode or when "
                       "user asks opening questions.",
        "input_schema": {
            "query": "string",
            "eco_hint": "string (optional)"
        }
    },
    {
        "name": "get_endgame_theory",
        "description": "Query the endgame knowledge base for theory. "
                       "Use when user asks endgame questions.",
        "input_schema": {
            "query": "string"
        }
    }
]
```

---

## Interaction modes

The coach supports 6 modes. The user can switch between them using
mode buttons at the top of the chat interface, or the coach auto-suggests
switching when appropriate ("Want me to show you a puzzle on this?").

### Mode 1 — Coach (default)
Conversational coaching. The coach uses Layer 3 data proactively.
It can call any tool. This is the primary mode.

The coach's default behaviour:
- Opens each session with a brief personalised greeting referencing
  recent activity: "You played 3 games yesterday — I noticed that
  back-rank pattern came up again on move 22. Want to talk about it?"
- Tracks conversation coherence — if the user seems confused, simplifies
- Remembers communication_style from memory (technical vs intuitive)
- Never re-explains something marked as a breakthrough in the memory

### Mode 2 — Puzzle mode
User requests a puzzle. The coach:
1. Calls `get_puzzle` tool (targeting top blindspot by default)
2. Renders an interactive board in the chat (see frontend section)
3. Waits for the user to solve or ask for a hint
4. After solve/fail: explains why the move works, connects it to the
   user's blindspot, updates mastery score

The puzzle is rendered inline — the user doesn't leave the chat.

### Mode 3 — FEN/PGN import mode
User pastes a FEN or PGN. The coach:
1. Detects the paste (FEN regex or PGN header detection)
2. Automatically calls `analyze_pgn` tool
3. Renders a board in the chat showing the position
4. Presents the analysis: mistakes found, threat types, eval drops
5. Cross-references against known blindspot clusters
6. Explains the most significant mistake using C1 explanation tool

### Mode 4 — Theory mode
User explicitly switches to theory mode (button) or asks an opening/
endgame question. The coach:
1. Routes opening questions to `get_opening_theory` tool
2. Routes endgame questions to `get_endgame_theory` tool
3. Answers from the RAG knowledge base (Wikibooks + Chess SE + Fine)
4. Does NOT use Layer 3 game data in theory mode — answers are
   universal, not personalised
5. After answering, offers: "Want to practice this in a puzzle?"

### Mode 5 — Audio mode
User enables audio (microphone icon). Speech-to-text converts user
speech to text (Web Speech API, browser-native, no API cost). Coach
responses are read aloud (Web Speech API synthesis, also browser-native).
The underlying model and tools are identical — audio is a pure UI layer.

No additional backend needed. The frontend handles STT/TTS entirely
via the Web Speech API. Restrict to Chrome/Edge where it's reliable.
Show a "Not supported in this browser" message on others.

### Mode 6 — Game review mode
Triggered when the user says "review my last game" or clicks a game
from their history. The coach:
1. Fetches the game and its annotation
2. Renders a navigable board in the chat (same useGameReview hook)
3. Steps through the game move by move, highlighting mistakes
4. At each mistake: calls C1 to explain what happened
5. Connects patterns to known blindspots

---

## System prompt

```
You are the Forked Coach — a personal chess coach with access to this
specific player's complete game history, mistake patterns, and improvement
data. You are not a generic chess assistant. You know this player.

YOUR ROLE:
- Coach this specific player on their chess improvement journey
- Use their actual game data (injected below) to give specific, grounded advice
- Remember prior conversations (summary injected below)
- Adapt your communication style to what works for this player
- Proactively connect current questions to their known blindspots

WHAT YOU CAN DO:
- Answer any chess question (opening, endgame, tactics, strategy)
- Show puzzles inline for the user to solve
- Analyse positions or games they paste
- Explain why specific moves in their actual games were mistakes
- Track their progress and celebrate genuine improvement

TONE:
- Warm but direct. Not sycophantic.
- Specific. Never generic ("play more actively" is not advice).
- Reference their actual data constantly ("your back-rank cluster
  score is 0.82 — this is still your most urgent weakness")
- Honest about what will and won't help at their level

CONSTRAINTS:
- Do not calculate long tactical variations yourself — use the
  explain_position tool for position-specific analysis
- Do not invent game data — only reference what is injected below
- Do not give advice inconsistent with their data
  (don't say "your endgame is strong" if the data shows otherwise)

{user_context_block}
```

---

## Backend

### New file: `backend/routers/coach.py`

`POST /api/coach/chat`
Body:
```json
{
  "message": "...",
  "conversation_history": [...],
  "mode": "coach|puzzle|theory|import",
  "username": "..."
}
```

Response: Server-Sent Events stream (same pattern as opening coach).

Pipeline:
1. Build user context block from live data
2. Load coach memory from `data/output/{username}_coach_memory.json`
3. Assemble system prompt with caching headers
4. Stream Groq Llama response with tool use enabled
5. Handle tool calls mid-stream:
   - `get_mistake_positions` → query mistake events DB
   - `explain_position` → call C1 locally or Stockfish fallback
   - `get_puzzle` → query puzzle retrieval system
   - `analyze_pgn` → run through Stage 1 pipeline
   - `get_opening_theory` → query opening knowledge chunks
   - `get_endgame_theory` → query endgame knowledge chunks
6. Return tool results to Groq, continue streaming
7. After response complete: async update coach memory if session
   has been going >10 minutes or >10 exchanges

`POST /api/coach/save-questionnaire`
Body: questionnaire answers. Saves to coach profile.

`GET /api/coach/profile/{username}`
Returns coach profile (questionnaire, memory summary, communication style).

`POST /api/coach/update-memory/{username}`
Called after session ends. Triggers memory summarisation.

---

## Frontend

### New page: `frontend/src/pages/Coach.tsx`

Route: `/coach`

Add "Coach" to main navigation with a special icon (robot/sparkle).
Show an "AI" badge on the nav item to signal this is different.

### Layout

Full-height chat interface. No split panels — the coach is the focus.

**Header:**
"Forked Coach" with mode selector buttons:
[💬 Coach] [♟ Puzzle] [📋 Import] [📖 Theory] [🔊 Audio]
Active mode highlighted. Clicking switches mode.

**Onboarding gate:**
If questionnaire not completed: show the 5-question questionnaire
before any chat interface. After completion: immediately enter Coach mode
with a personalised first message from the coach.

**Chat area:**
- User messages: right-aligned
- Coach messages: left-aligned with typing animation
- Inline board component: rendered when coach calls get_puzzle,
  analyze_pgn, or get_mistake_positions (see below)
- Tool use indicator: subtle "Checking your game data..." spinner
  shown while tool calls are in flight
- Mode-specific placeholder text in input:
  - Coach: "Ask me anything about your chess..."
  - Puzzle: "Requesting a puzzle for your top weakness..."
  - Import: "Paste a FEN or PGN to analyse..."
  - Theory: "Ask about any opening or endgame..."
  - Audio: [mic button replaces text input]

**Opening message (generated by Groq Llama, not hardcoded):**
The coach's first message in a new session references the user's current
state. Example for a returning user:
"Welcome back. I saw you played 3 games yesterday — you won 2 but that
back-rank pattern came up again on move 22 vs pedrominarelli.
Your mastery on that cluster is down to 0.20 after the reset.
Want to work on it, or is there something else on your mind?"

### Inline board component

`frontend/src/components/coach/CoachBoard.tsx`

Rendered inside the chat when the coach delivers a puzzle or position.
Props: `{ fen, mode: 'puzzle'|'view'|'review', solution?, onSolve? }`

Puzzle mode:
- Interactive board, user drags pieces
- "Show hint" button (costs a small mastery penalty)
- After correct move: green flash, coach message explains why it works
- After wrong move: red flash, "Try again" — coach gives a hint

View mode:
- Static board, not interactive
- Shows the position for discussion

Review mode:
- Navigable with ← → arrows (useGameReview hook)
- Shows eval bar on the side
- Highlights mistake squares

### Audio mode implementation

`frontend/src/hooks/useAudioCoach.ts`

```typescript
// Speech-to-text (browser-native, no API cost)
const recognition = new (window.SpeechRecognition ||
                         window.webkitSpeechRecognition)()
recognition.continuous = false
recognition.interimResults = false
recognition.lang = 'en-US'

// Text-to-speech (browser-native)
const speak = (text: string) => {
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 1.0
  utterance.pitch = 1.0
  window.speechSynthesis.speak(utterance)
}
```

Strip markdown from coach responses before speaking (remove **bold**,
bullet points etc.). Only read the first 200 words if the response is
very long — show the rest visually.

Check `window.SpeechRecognition || window.webkitSpeechRecognition`
on mode switch — if unavailable, show:
"Audio mode requires Chrome or Edge. Switch browser to use it."

---

## C1 integration

C1 is a 4B parameter model (github.com/CSSLab/C1). Check if weights
are available on HuggingFace at `UofTCSSLab/C1` or the C1 repo.

If C1 weights are available:
- Load as a local inference service (similar to how Maia2 is run)
- Expose as an internal endpoint: `POST /internal/c1/explain`
  Body: `{ "fen": "...", "question": "..." }`
  Returns: `{ "explanation": "..." }`
- Call from the `explain_position` tool handler

If C1 weights are not yet available:
- Implement the Stockfish fallback:
  Run depth-18 analysis, extract PV and eval
  Generate explanation: "The position after {best_move} gives White
  a {eval}cp advantage. The key idea is {threat_type}: {rule_based_description}"
  This is less natural but always works.
- Add a TODO comment to swap in C1 when weights release

Do not block the feature on C1 availability. The fallback must work.

---

## Files to create/modify

**New:**
- `backend/routers/coach.py`
- `backend/services/coach_memory.py`
- `backend/services/user_context.py`
- `frontend/src/pages/Coach.tsx`
- `frontend/src/components/coach/CoachBoard.tsx`
- `frontend/src/hooks/useAudioCoach.ts`
- `frontend/src/hooks/useCoachSession.ts`
- `data/output/{username}_coach_memory.json` (auto-created per user)
- `data/output/{username}_coach_profile.json` (questionnaire + prefs)

**Modify:**
- Main navigation — add Coach item
- `backend/main.py` — register coach router

---

## Definition of done

- [ ] Questionnaire shown on first visit, stored, never shown again
- [ ] User context block built from live data every session
- [ ] Coach memory loaded and injected every session
- [ ] Memory updated (summarised) after session ends
- [ ] POST /api/coach/chat streams Groq Llama 3.3 70B responses
- [ ] All 6 tools implemented and callable
- [ ] get_mistake_positions returns real FENs from mistake store
- [ ] explain_position calls C1 or Stockfish fallback
- [ ] get_puzzle fetches and returns a puzzle with FEN + solution
- [ ] analyze_pgn runs Stage 1 on pasted PGN/FEN
- [ ] get_opening_theory queries opening knowledge base
- [ ] get_endgame_theory queries endgame knowledge base
- [ ] Coach mode: personalised opening message referencing recent data
- [ ] Puzzle mode: inline board renders, user can solve, coach explains
- [ ] FEN/PGN import: auto-detected, analysed, board rendered
- [ ] Theory mode: routes to correct knowledge base
- [ ] Audio mode: STT and TTS work in Chrome/Edge
- [ ] Audio mode: graceful unsupported browser message
- [ ] CoachBoard renders in puzzle, view, and review modes
- [ ] Prompt caching implemented for system prompt + user context
- [ ] C1 called for position explanation (or Stockfish fallback)
- [ ] Coach added to main navigation
- [ ] No regressions in existing features
