# Claude Code prompt — Forked Homepage Redesign

## Context

Read CLAUDE.md before starting. This is a pure frontend task — no backend
changes. The goal is to redesign the homepage (`/` or the landing page
component) to be a world-class SaaS landing page that sells Forked's full
capability. The current homepage undersells the product — it shows fragments
of features without conveying the complete, differentiated picture.

The homepage must do three things: make a strong first impression visually,
communicate the unique value proposition clearly, and convert visitors into
users within 60 seconds of landing.

Study the current homepage carefully before making changes.

---

## Design principles

**Dark, premium, chess-inspired.** The existing dark purple/navy palette is
right — keep it. The product already has a strong visual identity. Elevate
it, don't replace it.

**Show, don't tell.** Every section should have a visual: a real screenshot,
an interactive demo element, or a animated mockup. No wall-of-text sections.

**Specificity over generality.** "83.1% accuracy" beats "AI-powered."
"Detects your back-rank blindspot from 200 games" beats "personalised."
Use real numbers from the product everywhere.

**One CTA, repeated.** The primary call to action is "Analyse my games →"
It appears in the hero, at the end of every major section, and in the
sticky header. No confusion about what to do next.

**Mobile responsive.** Every section must work on mobile. Chess players
are frequently on phones.

---

## Section 1 — Hero (above the fold)

The current hero is good but the subtitle is too long and the visual is
abstract. Improve it.

**Headline (keep):** "A coach who knows exactly how you lose."

**Subheadline (replace current):**
"Forked analyses your real games, finds the tactical and strategic
patterns behind every mistake, and builds a personalised training plan
that targets exactly those patterns — not generic puzzles."

**Three trust badges** below subheadline (inline, small):
- "No login · username only"
- "83.1% threat classification accuracy"  
- "100K+ Lichess puzzles indexed"

**CTAs:**
Primary: "Analyse my games →" (purple, large)
Secondary: "See how it works ↓" (ghost button, scrolls to section 2)

**Hero visual (right side):**
Replace the abstract glowing orb with a live animated mockup showing
the core product loop in 3 steps. Use a CSS/JS animation that cycles
through three states every 3 seconds:

State 1 — "Analysing games"
A mini terminal-style card: "Fetching 95 games... Annotating with
Stockfish... 315 mistakes found across 5 skill families"

State 2 — "Blindspot found"  
The dashboard alert card from the real product:
"⚠ You repeated a known weakness on move 22 vs pedrominarelli
Loose-piece awareness · pattern confidence 100%"
With "Drill" and "View" buttons (visual only)

State 3 — "Chess DNA"
The DNA card preview showing "The Attacker" archetype with 4 bars

Each state transitions with a smooth fade. This shows the product
doing real things, not abstract animation.

---

## Section 2 — The problem (new section)

Short, punchy. Two columns.

**Left — The problem:**
Large quote-style text:
"Chess.com tells you what's wrong.
Nobody fixes it."

Body: "Every platform shows you accuracy scores and blunder counts.
None of them know that *you specifically* miss back-rank threats
23 times a month — or build a drill plan around it."

**Right — The Forked difference:**
Three comparison rows, clean and visual:

```
Chess.com Insights    →    Forked
─────────────────────────────────────
"You made 24 blunders"  →  "Loose-piece awareness — 99 mistakes,
                             avg −260cp, costing +31 rating points"

Generic puzzle feed    →  Drills matched to your exact failure modes

Accuracy report        →  Live alert when you repeat a blindspot
                          in a real game
```

---

## Section 3 — Core loop (replace current "What Forked does")

The current section has three cards that are too abstract. Replace with
a horizontal step-by-step visual flow:

**Header:** "Four steps from your games to your improvement"

**Step 1 — Ingest**
Icon: database
"Enter your Lichess or Chess.com username. No login, no password.
Forked fetches your last 80–200 public games automatically."

**Step 2 — Classify**  
Icon: brain/circuit
"A chess transformer (83.1% accuracy, trained on 2M positions) reads
every mistake and classifies the tactical motif — fork, pin, back-rank,
loose piece, king safety."

**Step 3 — Profile**
Icon: fingerprint
"Mistakes collapse into your 5 skill families, ranked by urgency.
Each family gets a score, a mastery level, and an estimated rating cost."

**Step 4 — Train**
Icon: target
"Spaced repetition serves puzzles from your weakest families. When you
blunder the same pattern in a live game, the system detects it and
resets that cluster's mastery."

Use a connecting arrow or line between steps. The step numbers should
be large and the descriptions short.

---

## Section 4 — Feature showcase (the most important new section)

Six feature cards in a 2×3 grid. Each card has: an icon, a bold title,
a one-sentence description, and a key differentiator highlighted in
purple.

**Card 1 — Blindspot Profile**
Title: "Your personal mistake map"
Body: "95 games → 315 mistakes → 5 skill families ranked by urgency.
Not what everyone struggles with. What *you* struggle with."
Differentiator: "↗ +67 rating points if fixed"

**Card 2 — Forked Coach**
Title: "An AI coach that knows your games"
Body: "A persistent agentic coach that opens every session knowing your
recent games, top blindspot, and drill history. Shows inline puzzles,
analyses pasted games, remembers prior sessions."
Differentiator: "Audio mode · 6 tools · streaming"

**Card 3 — Live Sync**
Title: "Instant feedback on every game"
Body: "Background sync detects when you repeat a known weakness in a
live game — within minutes. Resets your mastery and queues drills
automatically."
Differentiator: "No manual trigger needed"

**Card 4 — Opening Explorer**
Title: "Opening tree with AI ideas on every node"
Body: "Lazy-loaded tree from real Lichess games, filtered to your rating.
Engine eval, WDL bars, and AI-generated typical ideas on every variation.
Fuzzy search jumps to any named line."
Differentiator: "Better than Chess.com · better than Lichess"

**Card 5 — Endgame Trainer**
Title: "Tablebase-verified endgame coaching"
Body: "Theory tree of canonical positions (Syzygy-verified). Practice
from any material config vs a human-like bot. Endgame coach cites
tablebase results as verified fact."
Differentiator: "Syzygy verified · not generic AI text"

**Card 6 — Chess DNA**
Title: "A shareable profile of how you play"
Body: "5 style axes (Tactical 88, Aggressive 62, Time calm 93) render
your playing identity as 'The Attacker'. Counterfactual rating shows
what fixing your blindspots is worth."
Differentiator: "Shareable card · forked.chess/dna/{username}"

Each card should have a subtle hover effect (slight lift + border glow).

---

## Section 5 — Live demo / onboarding widget (keep current, improve)

The current "Start with public games" form on the right side is good.
Keep it but improve it:

- Move it into a more prominent position — centred, not buried in a
  two-column layout
- Add a platform toggle (Lichess / Chess.com) that is visually clear
- Add a games slider with labels: "20 fast · 80 balanced · 200 thorough"
- Below the form: three reassurance lines in small text:
  "No account needed · Reads only public games · Takes ~40 seconds"
- After clicking "Analyse my games": show a progress indicator with
  real steps: "Fetching games... Annotating... Building your profile..."
  Don't navigate away immediately — show progress inline

On the left side of this section (the "live map" column):
Replace the static mistake list with an animated sequence showing 3
real-looking mistakes cycling:
- Each row: a mini board position (canvas, simplified), the move played,
  the threat type detected, and the eval drop in red
- Cycles every 2.5 seconds with a fade

---

## Section 6 — Competitive comparison (new section)

A clean comparison table. This is the conversion-critical section for
anyone who already uses Chess.com or Lichess.

**Header:** "Everything in one place. Nothing else comes close."

Table — 5 columns: Feature | Forked | Chess.com | Lichess | Chessable

Rows:
- Uses your real games for training
- Detects personal recurring blindspots
- Live alert when you repeat a mistake
- Agentic AI coach that knows your games
- Spaced repetition per blindspot
- Opening tree with eval + AI ideas
- Endgame trainer vs human-like bot
- Tablebase-verified endgame coach
- Requires login

Forked column: all green checkmarks
Others: mix of partial (yellow ~) and no (grey ×)
Use the existing competitive table from README.md as the source of truth.

Style: clean dark table, Forked column highlighted in subtle purple.
Don't make it look like marketing fluff — make it look like a feature
comparison a developer would make.

---

## Section 7 — Social proof (new section)

**Header:** "Built on real data, not vibes"

Three stat cards, large numbers, minimal text:

"83.1%"    — Threat classification accuracy (Chessformer, 14 classes)
"100K+"    — Lichess puzzles indexed for drill retrieval  
"2M"       — Training positions for the chess transformer

Below the stats, a quote-style callout:
"The feedback loop is the key: when a user blunders the same pattern in
a real game, the system detects it — No static puzzle platform does this."

---

## Section 8 — Final CTA

Simple, high-contrast section:

**Headline:** "Find out how you lose. Fix it."

**Subline:** "Enter your username. No account, no password. Results in 40 seconds."

**Inline onboarding form:** Same form as Section 5, repeated here.

Small text below: "Works with Lichess and Chess.com · Free · Open source"
GitHub link: icon + "ShahuPatil07/Forked"

---

## Navigation (sticky header improvements)

Current nav is minimal. Improve:

- Logo + "Forked" text on the left
- Centre: nav links — Features · Openings · Endgames · Coach (links to
  the respective app sections, only shown when user is logged in or
  grayed out with "after analysis" tooltip when not)
- Right: "Start analysis →" button (purple, small)
- On scroll: header gains a subtle backdrop blur + border bottom
- Mobile: hamburger menu

---

## Technical notes

- Use the existing Tailwind CSS setup — no new CSS framework
- All animations: CSS transitions or lightweight JS, no heavy animation
  libraries
- The hero animated mockup uses setInterval with React state
- The live demo board thumbnails are canvas elements using the existing
  drawBoard utility (already in the codebase)
- The onboarding form already exists — reuse its logic, just restyle
- All images/screenshots: use real screenshots from the product where
  possible, or create high-fidelity mockups using existing components
- Performance: no section should cause layout shift on load. Use
  min-height on sections that load dynamic content.
- The page must score >90 on Lighthouse performance. No blocking scripts.

---

## What NOT to change

- The actual routing and app logic — this is purely the landing page
- The existing dark colour palette and typography
- The "Start with public games" form functionality
- Any component used inside the authenticated app

---

## Definition of done

- [ ] Hero has animated 3-state mockup cycling every 3 seconds
- [ ] Hero subheadline updated, trust badges added
- [ ] Section 2 (problem/solution) added with comparison rows
- [ ] Section 3 (core loop) shows 4-step visual flow
- [ ] Section 4 (feature showcase) has 6 cards in 2×3 grid
- [ ] Section 5 (demo form) is centred with improved styling and progress
- [ ] Section 6 (comparison table) added with correct data
- [ ] Section 7 (stats) added with 3 large-number cards
- [ ] Section 8 (final CTA) added with inline form
- [ ] Sticky header with backdrop blur on scroll
- [ ] All sections mobile responsive
- [ ] No horizontal scroll on mobile
- [ ] Hover effects on feature cards
- [ ] Page loads without layout shift
- [ ] All existing form functionality preserved
- [ ] No regressions in authenticated app routes
