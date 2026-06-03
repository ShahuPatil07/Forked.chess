# Claude Code prompt — Chess DNA Card

## Context

Read CLAUDE.md before starting. This feature extends Feature 5
(Fingerprint Card) which is already built. The existing card shows
blindspot clusters + counterfactual rating. This replaces it with
a richer "Chess DNA" card that combines blindspot identity with a
playing style profile derived from the user's game history.

The existing fingerprint card generation endpoint and PNG output
infrastructure is already working — extend it, don't rebuild it.

---

## What the Chess DNA card is

A single shareable 1200×630px PNG that tells a player two things:
1. How they play (style profile — their chess identity)
2. How they lose (blindspot profile — their recurring weaknesses)

These are the two most compelling pieces of self-knowledge in chess.
No other tool shows both together, derived from the user's own games.

---

## Part 1 — Style profile computation

### New pipeline step: `ml/style/extractor.py`

Run this after Stage 1 annotation completes for a user. It analyses
ALL moves (not just mistakes) across the user's game history.

### The 5 style axes

Each axis is scored 0–100. The score reflects where the user sits on a
spectrum. Store all 5 scores in the user's profile JSON.

---

**Axis 1: Tactical ↔ Positional (0 = pure positional, 100 = pure tactical)**

Measure from mistake events + winning patterns:
- Compute the distribution of `threat_type` across the user's mistake
  events. Tactical types: fork, pin, skewer, discovered_attack,
  back_rank, removing_defender, deflection, trapped_piece, king_attack.
  Positional types: piece_activity, endgame_technique, passed_pawn,
  pawn_structure.
- Tactical ratio = tactical_threat_count / total_classified_mistakes
- Also factor in game sharpness: for each game compute the standard
  deviation of Stockfish eval across all annotated positions. High
  variance = tactical game. Average this across all games.
- Combine: tactical_ratio * 0.6 + normalised_eval_variance * 0.4
- Scale to 0–100.

---

**Axis 2: Aggressive ↔ Solid (0 = solid/defensive, 100 = aggressive)**

Measure from opening choices and eval trajectory:
- Average Stockfish eval at move 10 across all games from the user's
  perspective (positive = user is ahead early = aggressive opening
  choices led to advantage)
- Frequency of games where the user had the initiative (eval > +0.5)
  at move 15
- Average eval drop per game for the opponent (user is creating threats
  = eval drops for opponent)
- Combine these three signals, normalise to 0–100

---

**Axis 3: Risk-tolerant ↔ Conservative (0 = conservative, 100 = risk-taker)**

Measure from game outcomes and eval volatility:
- Variance of final game outcomes vs expected outcomes (Elo-based
  expected score). High variance = risk-taker (wins and losses more
  extreme than expected).
- Frequency of positions where the user voluntarily allowed eval to
  drop below -1.0 pawn (accepted a worse position for complexity)
- Average maximum eval swing per game (peak - trough). High swings = risky.
- Combine, normalise to 0–100.

---

**Axis 4: Middlegame ↔ Endgame specialist (0 = endgame, 100 = middlegame)**

Measure from phase-specific accuracy:
- Compute average eval_drop per mistake, separately for opening
  (moves 1-20), middlegame (moves 21-40), endgame (moves 41+)
- Endgame_accuracy = 1 - (avg_endgame_eval_drop / max_possible_drop)
- Middlegame_accuracy = same formula for middlegame phase
- Score = middlegame_accuracy / (middlegame_accuracy + endgame_accuracy) * 100
  (higher score = better in middlegame = middlegame specialist)
- If the user has fewer than 20 mistakes in a phase, mark that axis
  as "insufficient data" and don't display it on the card.

---

**Axis 5: Time management (0 = struggles under time pressure, 100 = calm)**

Measure from clock data (already stored in mistake events):
- Compute correlation between `time_remaining` and `eval_drop` across
  all mistake events. Negative correlation = more time pressure = bigger
  mistakes = poor time management. Score = 1 - abs(correlation) * 100
  capped at 0-100, but only meaningful if correlation is significant
  (p < 0.05 via scipy). If not significant, omit this axis.
- Also factor in: percentage of mistakes made with < 30 seconds remaining
  vs mistakes made with > 60 seconds remaining. High ratio = time pressure.

---

### Style archetype derivation

After computing all 5 axes, map to one of 8 archetypes. This is the
single-label identity displayed prominently on the card.

```
Tactical + Aggressive + Risk-tolerant → "The Attacker"
Tactical + Aggressive + Conservative  → "The Tactician"
Tactical + Solid + Risk-tolerant      → "The Gambiteer"
Tactical + Solid + Conservative       → "The Calculator"
Positional + Aggressive + Risk-tolerant → "The Strategist"
Positional + Aggressive + Conservative  → "The Grinder"
Positional + Solid + Risk-tolerant     → "The Pragmatist"
Positional + Solid + Conservative      → "The Fortress"
```

Thresholds: Tactical if axis1 > 55, Aggressive if axis2 > 55,
Risk-tolerant if axis3 > 55.

Store `{ archetype, axis1..5, computed_at }` in the user profile JSON.

---

### Minimum data requirements

Style profile requires at least 50 annotated games to be meaningful.
If the user has fewer than 50 games, do not show the style axes — show
a message: "Play 50+ games to unlock your Chess DNA profile."
Show only the blindspot section of the card in that case.

---

## Part 2 — The card design

Replace the existing fingerprint card with this layout.
Same dimensions: 1200×630px, dark background (#0f0f14),
Forked purple (#7c6af7) accent.

```
┌─────────────────────────────────────────────────────────────┐
│  ♟ Forked                                      forked.chess │
│                                                              │
│  ShahuPatil27 · Rapid 1421                                  │
│                                                              │
│  ┌────────────────────────┐  ┌─────────────────────────┐   │
│  │   CHESS DNA            │  │   BLINDSPOTS            │   │
│  │                        │  │                         │   │
│  │  THE ATTACKER          │  │  #1 [cluster label]  99 │   │
│  │                        │  │  #2 [cluster label]  93 │   │
│  │  Tactical  ████░░  72  │  │  #3 [cluster label]   2 │   │
│  │  Aggressive████░░  68  │  │                         │   │
│  │  Risk      ██░░░░  41  │  │  Fix all: +67 pts       │   │
│  │  Middlegame████░░  78  │  │  Potential: 1867        │   │
│  │  Time mgmt ███░░░  58  │  │                         │   │
│  └────────────────────────┘  └─────────────────────────┘   │
│                                                              │
│  "A coach who knows exactly how you lose"    forked.chess   │
└─────────────────────────────────────────────────────────────┘
```

Left panel: Chess DNA (archetype name large, 5 axis bars, scores)
Right panel: Blindspots (cluster labels, scores, rating impact)

The archetype name is the hero element — large font, purple colour,
centred in the left panel. This is what players screenshot and share.

For each axis bar: filled portion uses the Forked purple gradient,
empty portion uses a dark grey. Score number on the right.

Axis labels on the card should be the spectrum label, not the axis name:
- Axis 1: show "Tactical" if > 50, "Positional" if ≤ 50
- Axis 2: show "Aggressive" if > 50, "Solid" if ≤ 50
- Axis 3: show "Risk-taker" if > 50, "Conservative" if ≤ 50
- Axis 4: show "Middlegame" if > 50, "Endgame" if ≤ 50
- Axis 5: show "Time pressure" if < 50 (inverted), "Time calm" if ≥ 50

If an axis has insufficient data, replace with a dash "—" and "Not enough data".

User avatar: top-left corner circle (48px). Fetch from Lichess public API
`https://lichess.org/api/user/{username}` → `profile.image` if available.
Fallback: circle with username initial, purple background.

---

## Part 3 — Backend

### New endpoint in `backend/routers/profile.py` (or equivalent)

`POST /api/profile/{username}/compute-style`
Triggers style computation for the user. Called after Stage 2 clustering
completes (add to the post-cluster job). Also callable manually.
Returns: `{ archetype, axis1..5, computed_at }`

`GET /api/profile/{username}/style`
Returns cached style profile. 404 if not computed yet.

`GET /api/profile/{username}/dna-card`
Generates and returns the DNA card PNG (replaces the old /card endpoint).
Regenerate when: new clustering run OR style profile update.
Cache at `data/output/{username}_dna_card.png`.

### Style computation placement

Run `compute_style(username)` at the end of `run_clustering_pipeline()`
in `ml/clustering/pipeline.py` — after clusters are saved, compute and
cache the style profile. This means the DNA card is always ready after
the first full analysis.

---

## Part 4 — Frontend updates

### Dashboard

Replace the "Share your fingerprint" section with "Share your Chess DNA":

Show a preview of the card (scaled down, ~400px wide) directly on the
dashboard below the blindspot cards. This is a live preview — it updates
when clusters or style changes. Don't make the user navigate to a separate
page to see their card.

Below the preview:
- "Download card" button
- "Copy share link" button — copies `forked.chess/dna/{username}`
- Two pre-written share texts (copy buttons):
  - Twitter: "My chess DNA via Forked — I'm a {archetype} 🧬
    My top weakness is costing me ~{pts} rating points
    forked.chess/dna/{username}"
  - Reddit: "Analysed {N} of my games — here's my chess style profile
    and my biggest recurring mistake patterns"

### Style section on Dashboard

Above the fingerprint card preview, add a small "Your chess style" row:
Show the archetype name in large text with a one-line description:

Archetype descriptions:
- "The Attacker" → "You play sharp, risky chess and look for the kill"
- "The Tactician" → "You spot combinations but choose your battles"
- "The Gambiteer" → "You sacrifice material for initiative and complexity"
- "The Calculator" → "You calculate precisely and exploit tactical chaos"
- "The Strategist" → "You outmanoeuvre opponents with long-term plans"
- "The Grinder" → "You convert advantages slowly and surely"
- "The Pragmatist" → "You adapt your style to what the position demands"
- "The Fortress" → "You defend tenaciously and wait for opponent errors"

Show the 5 axis bars in a compact horizontal layout (same bars as the card).

### Public DNA page

Route `/dna/{username}` — public, no auth.
Shows the full card image + the archetype name + one-line description.
CTA: "Analyse your games on Forked →" linking to the home/onboarding page.
This is the landing page when someone clicks a shared link.
OG meta tags: `og:image` = the card PNG URL, `og:title` = "{username}'s
Chess DNA — {archetype}", `og:description` = "Analysed {N} games.
Top weakness: {cluster_label_1}. Potential rating: {counterfactual_rating}"

---

## Files to create/modify

**New:**
- `ml/style/extractor.py` — style axis computation
- `frontend/src/components/ChessDNACard.tsx` — card preview component
- `frontend/src/pages/DNAPage.tsx` — public `/dna/{username}` route

**Modify:**
- `ml/clustering/pipeline.py` — call compute_style after clustering
- `backend/routers/profile.py` — add style endpoints + dna-card endpoint
- `frontend/src/pages/Dashboard.tsx` — add DNA preview + style section
- Replace old fingerprint card generation with new DNA card generation

---

## Definition of done

- [ ] All 5 style axes computed from game history
- [ ] Archetype derived from axis scores using threshold rules
- [ ] Minimum 50 games enforced — graceful fallback for fewer games
- [ ] Insufficient data handled per-axis (omit, show dash)
- [ ] Style computation triggered automatically after clustering
- [ ] GET /api/profile/{username}/style returns cached profile
- [ ] DNA card generated as 1200×630px PNG with Pillow
- [ ] Left panel: archetype name + 5 axis bars
- [ ] Right panel: blindspot clusters + rating impact
- [ ] Cluster labels on card fetched at generation time from current profile
- [ ] User avatar included (Lichess API or initial fallback)
- [ ] Card cached, regenerated on re-cluster
- [ ] Dashboard shows live card preview (~400px wide)
- [ ] Dashboard shows archetype name + one-line description
- [ ] Dashboard shows 5 axis bars in compact layout
- [ ] "Download card" and "Copy share link" buttons work
- [ ] Two pre-written share texts with copy buttons
- [ ] Public /dna/{username} route renders card + CTA
- [ ] OG meta tags set correctly for social preview
- [ ] Old /card endpoint redirects to /dna-card or is replaced
- [ ] No regressions in existing features
