# Forked — Five Priority Features
# One prompt per feature. Run them in order. Each is self-contained.
# Read CLAUDE.md before starting any feature.

---

# FEATURE 1 — Live Game Sync with Blindspot Alert

## What and why

The blindspot pipeline currently runs only when the user manually triggers
analysis. This feature makes it continuous: a background sync watches for
new games every 15 minutes, re-runs Stage 1 on any new game, checks if a
blindspot cluster was repeated, and surfaces an in-app alert immediately.

The learning signal is strongest when feedback arrives close to the mistake.
This is the product's core loop made real-time.

## Background sync

Add a per-user sync loop that:
1. Polls Chess.com/Lichess for games newer than `last_synced_at`
2. Runs any new games through Stage 1 pipeline
   (fetcher → annotator → mistake_extractor → hybrid_classifier)
3. For each new mistake event, build its feature vector and compute
   cosine similarity against every known blindspot cluster centroid.
   Use cluster IDs and centroid vectors only — never cluster label strings.
   The LLM-generated label is a display name for humans and must not be
   used in any similarity calculation or matching logic.
4. A match requires cosine similarity > 0.72. If no cluster exceeds this
   threshold, the mistake is genuinely unmatched — log it to the mistake
   history for future re-clustering but take no alert action. Do not force
   the closest cluster as a match. Do not lower the threshold.
5. If a confident match is found (similarity > 0.72): create a
   BlindspotAlert record, reset that cluster's mastery score, re-queue
   3 targeted drills for the next session.
6. Update `last_synced_at`.

Run sync in a background thread per active user. Throttle: minimum 15
minutes between syncs per user. Only sync users active within last 7 days.

Store alerts in `data/output/{username}_alerts.json`:
```json
[{
  "id": "...",
  "game_id": "...",
  "opponent": "Priya_84",
  "move_number": 34,
  "cluster_id": "cluster_uuid_here",
  "cluster_rank": 1,
  "similarity": 0.84,
  "eval_drop": 320,
  "fen": "...",
  "best_move": "Rd8",
  "played_move": "Qe4",
  "timestamp": "...",
  "seen": false
}]
```

Note: the alert stores `cluster_id` and `cluster_rank`, not the cluster
label. The frontend fetches the display label separately from the profile
data at render time. This means the displayed name always reflects the
current cluster label, even if it was re-named on a subsequent re-cluster.

## No-match behaviour

When a game has mistakes but none confidently match any existing cluster:
- Log the mistake events to the user's running history (they contribute
  to the next re-clustering cycle and may form new clusters)
- Do not create an alert
- Update `last_synced_at` as normal
- Do not show any alert or banner for this game

This is correct behaviour. A mistake that doesn't match a known pattern is
either a one-off error or an emerging new blindspot — not a confirmed repeat.

## API

`GET /api/alerts/{username}` — returns unseen alerts, newest first.
  Each alert includes `cluster_id` and `cluster_rank`. The frontend
  resolves the display label from the profile clusters endpoint.
`POST /api/alerts/{username}/mark-seen` — body: `{ "alert_ids": [...] }`
`GET /api/sync/status/{username}` — `{ last_synced_at, is_syncing }`
`POST /api/sync/trigger/{username}` — manual trigger, also called on login

## Frontend

**Alert banner on Dashboard:**
Show when unseen alerts exist. Fetch the cluster label from the user's
current profile data (not from the alert record itself).

```
⚠ You repeated a known weakness on move 34 vs Priya_84 · 2 hours ago
  [View position]  [Start drill]  [×]
```

Most recent alert shown; "and 2 more" link if multiple unseen.

**Alert detail modal:**
- Board at the mistake position
- What was played vs best move + eval drop
- Which cluster rank it matched (display label from profile endpoint)
- Similarity score as a visual bar: "Pattern confidence: 84%"
- "Start drill" → Drill Session with that cluster pre-queued as priority
- "See all alerts" link

**Notification dot:** red dot on Dashboard nav item, clears on visit.

**Sync status:** subtle "Last synced: 12 min ago" top-right. Clicking
triggers manual sync with spinner.

---

# FEATURE 2 — Post-Game Debrief for Maia Games

## What and why

The Maia game currently ends with a Stockfish accuracy report. This feature
adds a debrief tab that cross-references every mistake against the user's
blindspot clusters — making the game a direct test of whether drilling works.

## Algorithm

After `game_over` WebSocket message:
1. Collect every position where the user's move had eval_drop > 80cp
   (lighter than the main pipeline's 100cp — want near-misses too)
2. Run Stage 1 classification on each
3. Build the feature vector for each classified mistake
4. Compute cosine similarity against every cluster centroid using cluster
   IDs and vectors. Never use cluster label strings in matching logic.
5. A blindspot match requires similarity > 0.72. If no cluster exceeds
   this threshold, that mistake is unmatched — report it honestly as an
   unmatched mistake, not as a known blindspot.
6. Return three lists:
   - `matched`: mistakes with similarity > 0.72 to a known cluster
   - `unmatched`: mistakes that didn't confidently match any cluster
   - `clean_moves`: nothing notable (not needed in the UI, just for completeness)

New endpoint: `POST /api/bot-game/{game_id}/debrief`
Body: `{ "username": "..." }`
Returns the debrief data. Run asynchronously — show accuracy report first,
debrief loads in background with skeleton state.

Response shape:
```json
{
  "matched": [{
    "move_number": 31,
    "fen": "...",
    "played": "Qe4",
    "best": "Rd8",
    "eval_drop": 320,
    "cluster_id": "...",
    "cluster_rank": 1,
    "similarity": 0.84
  }],
  "unmatched_count": 2,
  "total_mistakes": 3
}
```

The frontend resolves cluster display labels from the profile endpoint
using `cluster_id`. Never store or return LLM label strings from this
endpoint — they can change on re-cluster and the debrief data is cached.

## Three honest debrief states

**State 1 — Blindspot repeated:**
"You triggered 1 known weakness in this game."
Show matched mistake cards (see below). Reset mastery, push drills.

**State 2 — Mistakes made, none matched:**
"You made {N} mistake(s) this game, but none matched your known patterns.
These may be emerging new weaknesses — we'll watch for them."
Do not show a blindspot card. Do not name a blindspot. Do not force a match.

**State 3 — No significant mistakes:**
"Clean game — no known weakness patterns detected 🎯
Your drilling is showing results."

## Frontend debrief tab

Two tabs after game: "Accuracy" (existing) + "Blindspot debrief" (new).

**Per matched mistake card:**
- Mini board at the mistake position
- "Move {N}: you played {move}, best was {move} (−{eval}cp)"
- "⚠ Cluster #{rank} — matched with {similarity}% confidence"
  (display label fetched from profile endpoint by cluster_id)
- Mastery impact: "Mastery reset from 0.71 → 0.20" (before/after bar)

**Unmatched mistakes section** (if any):
- Collapsed by default, expandable
- "2 other mistakes — not matched to known patterns"
- Shows the positions but without blindspot labelling

**CTA for matched results:**
"Drill these patterns now →" → Drill Session with matched clusters queued

---

# FEATURE 3 — Mistake Replay Mode

## What and why

The user sees blindspot cluster names and counts on the dashboard. This
feature shows them every real game position where they blundered that
specific pattern — in sequence. Watching yourself fail is more emotionally
resonant than abstract puzzles. It also answers "why is this my pattern?"
in a way that a cluster name alone cannot.

## Where it lives

On each blindspot card on the Dashboard: "Replay mistakes →" link.
Route: `/replay/{username}/{cluster_id}`

Note: the route uses `cluster_id` (UUID), not the cluster name. The page
fetches the display label from the profile endpoint on load. This keeps the
URL stable even if the LLM renames the cluster on re-clustering.

## The replay experience

Focused screen, no sidebar, minimal chrome:

**Header:**
Cluster display label (fetched from profile) + "· {N} mistakes"
e.g. "Cluster #1 · 23 mistakes" if the label hasn't loaded yet,
then updates to the real label once fetched.

**Navigation:** "← 1 of 23 →" with left/right keyboard arrows.

**Per-mistake view:**
- Full-size board at the moment of the mistake, oriented from user's side
- Grey arrow: the wrong move (from → to)
- Green arrow: the best move
- "You played: Qe4 (−320cp)" in red
- "Best was: Rd8" in green
- Game context: "vs Priya_84 · Rapid · Move 34 · 18 days ago"
- Expandable section: "Why was this a mistake here?" → calls the
  endgame/opening coach with the FEN pre-loaded as context

**Pattern insight after mistake 5:**
Send the top 3 positions by cluster similarity to Groq with:
"In one sentence, what do these chess positions have in common?
Describe only the tactical or structural pattern visible on the board."
Show the response as a callout: "Notice: {insight}"

**End screen:**
"You've reviewed all {N} mistakes. Ready to fix them?"
→ "Start drill session" targeting this cluster

## Data endpoint

`GET /api/cluster/{username}/{cluster_id}/mistakes`
Returns:
```json
{
  "cluster_id": "...",
  "cluster_rank": 1,
  "mistakes": [{
    "fen": "...",
    "move_played": "Qe4",
    "best_move": "Rd8",
    "eval_drop": 320,
    "game_date": "...",
    "opponent": "Priya_84",
    "move_number": 34,
    "user_color": "white",
    "game_id": "..."
  }]
}
```

The response does not include the cluster label — the frontend fetches
that separately from the profile endpoint using `cluster_id`.

---

# FEATURE 4 — Counterfactual Rating

## What and why

"If you'd handled this pattern correctly in your last 200 games, your
rating would be 1623 instead of 1421." A single number that makes the
cost of a blindspot concrete.

## Algorithm

This is a simulation. Be explicit in the UI that it is an estimate.

For each game in the user's history:
1. Find every mistake event that matched a blindspot cluster (similarity
   > 0.72) — identified by cluster_id, not cluster label
2. For the first such mistake per game only (don't stack corrections):
   check if eval_before was >= -50cp (position was not already lost)
   and best_move_eval was >= +100cp (playing correctly would have been
   winning)
3. If both: count this game as "recoverable" — flip the outcome
   (loss → win, draw → win) for the simulation
4. Recount W/L/D across all games with corrections applied
5. Recompute Elo delta: for each game, calculate expected score
   `E = 1 / (1 + 10^((opponent_rating - user_rating) / 400))`
   compare to corrected actual score, sum the Elo deltas
6. Corrected rating = actual rating + sum of Elo gains from corrections

Run per cluster (how much does fixing cluster_id X alone add?) and
cumulatively (how much do all clusters together add?).

## Display

On the Dashboard below stat cards, a "Rating impact" card:

```
Your actual rating:         1421
Fix cluster #1:            +38 pts → 1459
Fix cluster #2 also:       +21 pts → 1480
Fix all patterns:          +74 pts → 1495 (ceiling estimate)
```

Show cluster display labels (fetched from profile by cluster_id) in the
actual UI. The example above uses generic labels only for illustration.

Disclaimer: "Estimate based on your last {N} games. Assumes correct play
only at your known pattern moments."

On each blindspot card: a "+{N} pts" badge showing that cluster's
individual rating impact.

## Caching

Run once after clustering completes. Store in profile JSON.
Re-run on every re-cluster. If a cluster is re-labelled, the rating
impact stays the same (it's keyed to cluster_id, not the label).

---

# FEATURE 5 — Blindspot Fingerprint Card (shareable)

## What and why

A shareable card: top blindspot clusters + counterfactual rating.
Chess players love self-analysis content. Each share is free acquisition.

## The card

Generate server-side as PNG using Pillow (add to requirements if needed).
Dimensions: 1200×630px (Open Graph size — previews correctly when shared).

Layout:
```
┌─────────────────────────────────────────┐
│  ♟ Forked                    forked.io  │
│                                          │
│  ShahuPatil27 · Rapid 1421              │
│  "A coach who knows exactly how you lose"│
│                                          │
│  YOUR CHESS BLINDSPOTS                  │
│                                          │
│  #1  [cluster label]        ████████ 88 │
│  #2  [cluster label]        ██████   71 │
│  #3  [cluster label]        █████    52 │
│  #4  [cluster label]        ███      34 │
│                                          │
│  Fix all patterns: +74 rating points    │
│  Potential rating: 1495                  │
└─────────────────────────────────────────┘
```

Use cluster display labels from the current profile data at card generation
time. Cache the card PNG. Invalidate and regenerate on re-cluster (since
labels may change). The card reflects a snapshot of the user's profile
at the time it was generated — this is fine and expected.

Include user's Lichess/Chess.com avatar if fetchable from public API.
Fallback: coloured initial avatar using username first letter.

## Implementation

`GET /api/profile/{username}/card` — returns PNG (image/png).
Cache at `data/output/{username}_card.png`, invalidate on re-cluster.

On Dashboard: "Share your fingerprint" button →
- "Download PNG" — direct download
- "Copy link" — copies `https://forked.io/card/{username}`

Public route `/card/{username}` — renders card full-screen, no auth,
with "Analyse your own games →" CTA. Landing page for shared links.

Pre-written share copy:
- Twitter/X: "My chess blindspots via @ForkedChess — pattern #{rank}
  is costing me ~{pts} rating points 😅 forked.io/card/{username}"
- Reddit: "Analysed my last 200 games — here are my biggest recurring
  mistake patterns"

Copy buttons for each.

---

# Notes for Claude Code

- Run features strictly in order: 1 → 2 → 3 → 4 → 5.
- Read CLAUDE.md before starting Feature 1.
- Existing pipeline, WebSocket, Maia engine: do not refactor, only extend.
- SQLite + flat JSON files for all new data (consistent with existing arch).
- Pillow is the only expected new dependency (Feature 5).
- Each feature should be testable end-to-end before starting the next.

## CRITICAL — cluster identity rule (applies to all 5 features)

Blindspot clusters are identified exclusively by their `cluster_id` (UUID)
and `centroid` vector. The LLM-generated label string (e.g. "Back-rank
threats") is a display name generated by Groq after clustering — it is
human-readable but semantically unreliable and can change on re-cluster.

This means:
- All similarity matching uses centroid vectors, never label strings
- All alert records store cluster_id, never label strings
- All API responses return cluster_id; the frontend resolves the current
  display label from the profile endpoint at render time
- No feature should hardcode, compare, or store cluster label strings
  as identifiers or matching keys
- The debrief and replay endpoints return cluster_id only; UI fetches
  the display label separately so it always reflects the current name
