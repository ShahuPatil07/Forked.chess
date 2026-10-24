# Build a new section in Forked: "Warm-Up" (pre-game blunder-prevention warm-ups)

You are working in the Forked codebase. Forked is an adaptive chess blindspot coach. Your job is to add a new **Warm-Up** section: short (5–10 min) activities a player does right before playing online, designed to reduce blunders in the games that follow.

Read this whole prompt before writing code. **Start with Phase 0 and stop for my approval before building.**

---

## 1. What Forked already has (reuse it, don't rebuild it)

Forked currently includes:

- A **3-stage ML pipeline**: ingestion → classification → retrieval, built on the user's real game history.
- **Chessformer**: a 64-square-token transformer (Shaw relative attention, 6 layers, SupCon + CE) that classifies each blunder's tactical motif into **14 threat categories**.
- A deterministic **5-family blindspot taxonomy** keyed by stable `cluster_id`s. It drives live alerts, mistake replay and counterfactual rating.
- A persistent **agentic coach**: Groq Llama-3.3-70B, 6 callable tools, SSE streaming, 3 personalization layers.
- A **Stockfish depth-18** fallback chain.
- An **SM-2 spaced-repetition engine** indexing **100K+ Lichess puzzles** by theme and rating band.

The new section must plug into these:

- Use the user's **blindspot families / cluster_ids** to personalize which drills appear.
- Use the existing **puzzle index** (theme + rating band) for puzzle-based drills.
- Use the existing **Stockfish** service for validation and outcome measurement.
- Expose the section to the **coach** as a new tool (see §7).

---

## 2. Phase 0: explore and plan (do this first, then stop)

1. Map the repo: frontend framework, backend framework, DB/ORM, auth, how games are imported (chess.com / Lichess), where the taxonomy, puzzle index, SM-2 and coach tools live, and how existing sections/routes are registered.
2. Find the 5 blindspot family definitions and the 14 Chessformer categories in code. Quote them back to me.
3. Propose:
   - the file/folder layout for the Warm-Up section,
   - the DB schema additions,
   - the API endpoints,
   - the mapping from each blindspot family to the drills in §4 (your proposal, based on what each family actually means),
   - anything in this prompt that conflicts with the existing architecture.
4. **Stop and wait for my approval.**

Follow existing conventions (naming, styling, state management, testing). Do not introduce a new framework or UI library unless I approve it.

---

## 3. Design principles (from the research; these are requirements)

1. **Chess-specific perception beats generic brain games.** Long-term "far transfer" from generic cognitive training is near zero (Sala & Gobet meta-analyses). Expert perception is tied to real chess visuals (Reingold et al.). So: **no Sudoku, n-back, abstract shape games.** Every perception drill uses real chess pieces on real board geometry.
2. **Two kinds of activity, two purposes:**
   - *Skill priming* = chess perception and thinking drills.
   - *State regulation* = routine, breathing, worry-dump, movement nudge, tilt gate. These target arousal, anxiety and tilt, not skill.
3. **Short and easy.** A full session is 5–10 minutes, and drills should mostly succeed (target ~80–90% accuracy; this is a design heuristic, not a research number). A warm-up must not fatigue or demoralize the user.
4. **Match the upcoming time control.** Bullet/blitz warm-ups use faster time caps than rapid/classical.
5. **Honesty in UI copy.** No controlled study has yet tested pre-game chess warm-ups. UI text must **never** claim warm-ups are "proven" or "scientifically shown" to reduce blunders. Allowed framing: "based on research into how chess players perceive the board and how athletes prepare."
6. **Measure everything** (see §8). Forked's own data is how we find out what works.

---

## 4. Activities to build

Each drill is a self-contained module with: generator → UI → scoring → logged result. All positions must be legal (validate with python-chess or the existing chess library).

### A. Perception drills (skill priming)

| ID | Name | Mechanic | Generation | Score |
|---|---|---|---|---|
| `check_flash` | Check or Not? | Mini-board (3×3 to 5×5 region) with a king and 1–3 potential attackers is flashed. User answers Check / Not check. | Procedural: place king + attackers, compute check with the chess library. Balance ~50/50. | Accuracy + median RT |
| `threat_count` | Threat Count | Full position shown. "How many of your pieces are attacked?" (variant: "...and undefended?") | Real positions from the puzzle DB / user's own games, answers computed by attack maps. | Exact-match accuracy, RT |
| `what_changed` | What Changed? | Position shown, blank flicker (~250 ms), same position with **one** piece moved. User taps the changed piece/square. Repeat flicker until answered or timeout. | Take a real position, apply one legal move. | Accuracy, time to detect |
| `loose_pieces` | Loose Pieces | Tap every undefended piece (both colours) within the time cap. | Real positions; ground truth from attack/defend maps. | Precision + recall (F1), RT |
| `double_check_hunt` | Double-Check Hunt | Grid of 6 mini-boards (4×4), each with a king + 2 attackers. Tap the one showing double check; others show single or no check. | Procedural. | Accuracy, RT |

### B. Thinking drills (skill priming)

| ID | Name | Mechanic | Generation | Score |
|---|---|---|---|---|
| `opponent_threat` | What Does It Threaten? | Show position + opponent's last move (animated). User selects the threat (piece en prise, mate threat, fork, discovered attack, none). | Positions where the opponent's move created a threat; prefer the user's own games and their blindspot motifs. | Accuracy |
| `two_candidates` | Two Candidates (anti-Einstellung) | Position contains a tempting good move and a better one. User must enter **two** candidate moves before submitting their choice. | Positions where the engine's best move beats the most "natural" move by a set margin. Use Stockfish multi-PV; optionally a human-likeness model (Maia) to pick the tempting move. | Picked best move? Was best move among the candidates? |
| `easy_sprint` | Easy Tactic Sprint | 8–15 easy puzzles, 5–15 s each. | Existing puzzle index, **below** the user's puzzle rating (target ~85–90% solve rate). | Solved count, RT |

**Important:** warm-up puzzle attempts should be **logged but not update SM-2 scheduling** by default (put this behind a config flag). Warm-up is priming, not study, and failures under a time cap shouldn't distort the SRS queue.

### C. State-regulation activities

| ID | Name | Mechanic | Notes |
|---|---|---|---|
| `routine_builder` | My Pre-Game Routine | User assembles and saves their own ordered routine from the activities here; runs it in one tap. | Pre-performance routine research: consistency matters more than which elements are used. This is the default entry point for returning users. |
| `breathing_reset` | Reset Breathing | 60–120 s guided paced breathing with a visual pacer. | Offer mainly **after losses**. Single-session mindfulness has mixed evidence for attention but helps regulate negative mood. |
| `worry_dump` | Clear Your Head | Optional free-text box: "Write what's on your mind about this game." Timer 2–5 min. | **Opt-in only.** Store text on-device or discard after the session; never send to the LLM or server without explicit consent. Evidence is from high-anxiety test-takers; frame as optional. |
| `move_nudge` | Move First | Prompt: "Stand up and move for 2–5 minutes" with a timer. | Acute-exercise research supports a small-to-moderate cognitive boost. Simple nudge, no tracking. |
| `setup_check` | Setup Check | Checklist: fresh air / ventilation, water, notifications off, time control chosen. | Indoor air quality has been linked to more chess errors. |
| `tilt_gate` | Tilt Check | If the user's imported recent games show a loss streak, show a cooldown suggestion with a countdown before the "Play" link. | **Never hard-block.** Suggest a ~30-min break after a streak; let the user dismiss. Thresholds in §5. |

---

## 5. Rating-band configuration (chess.com ratings)

Put this in **one config file**, not scattered through code. The band → drill mapping is a design hypothesis to be tested, not a research finding.

| Band | Emphasis (default session mix) | Time-cap multiplier | Tilt-gate trigger |
|---|---|---|---|
| < 800 | `check_flash`, `loose_pieces`, `easy_sprint` (mate-in-1). Closing routine prompt: "Is every piece safe?" | 1.5× | after 2 consecutive losses |
| 800–1200 | `threat_count`, `opponent_threat`, `loose_pieces`, `easy_sprint` | 1.3× | after 2 consecutive losses |
| 1200–1600 | `what_changed`, `opponent_threat`, `easy_sprint` (2–3 move tactics), intro `two_candidates` | 1.0× | after 3 consecutive losses |
| 1600–2000 | `two_candidates`, `opponent_threat` (quieter threats), `what_changed` | 0.9× | after 3 consecutive losses |
| 2000+ | `two_candidates`, harder `easy_sprint`, optional opening-recall from user's repertoire | 0.8× | after 5 consecutive losses |

Time-control modifiers: bullet ×0.6, blitz ×0.8, rapid ×1.0, classical ×1.2 on per-item time caps.

Determine the band from the user's chess.com rating for the selected time control. If only Lichess is linked, use the Lichess rating but flag in the UI that bands are calibrated for chess.com (do not invent a conversion formula).

---

## 6. Session composer

- Inputs: rating band, upcoming time control, minutes available (3 / 5 / 10), user's top blindspot families, recent results (for tilt gate), saved routine (if any).
- Default order: `setup_check` → (state activity if tilt/anxiety flagged) → 2–3 perception drills → 1 thinking drill → `easy_sprint` → close with "Ready" screen + routine cue.
- Personalization: weight drills by the user's blindspot families using the mapping approved in Phase 0. Use the **same `cluster_id`s** as the rest of Forked.
- Adaptive difficulty within a session: if accuracy drops below ~70%, ease the next items; above ~95%, harden slightly. Keep the session feeling successful.
- End screen: short summary (accuracy, speed vs. user's baseline), one cue for the game ("Before each move: what did their last move change?"), and a "Play now" button linking out to chess.com/Lichess.

---

## 7. Coach integration

Add a 7th coach tool (match the existing tool interface and SSE conventions), for example:

- `get_warmup_plan(time_control, minutes)` → returns the composed session for the current user.
- `get_warmup_stats(period)` → returns drill accuracy/RT trends and the experiment outcomes from §8.

The coach can then say things like "You've been missing discovered attacks; today's warm-up leans on What Changed." Keep tool outputs compact.

---

## 8. Measurement and experiment (core feature, not optional)

1. **Event logging:** every drill item logs `user_id, session_id, drill_id, item_id, band, time_control, correct, response_ms, difficulty, timestamp`.
2. **Outcome linking:** after a session, match the user's next imported game(s) within a window (default: started within 30 min of session end) and compute accuracy, blunder count, and blunders per 40 moves with the existing Stockfish service.
3. **Randomized comparison (opt-in, with clear consent copy):** for consenting users, randomly assign some "I'm about to play" moments to *warm-up* vs *no warm-up* (control = straight to Play). Store the assignment. This gives a causal comparison by band and drill type.
4. Build a simple internal dashboard: blunder rate in warm-up vs. control games, by band, by time control, by drill mix.
5. Do not show users "warm-ups reduce your blunders by X%" until the data supports it with adequate sample size.

---

## 9. Non-goals and guardrails

- No generic brain-training games.
- No hard blocks on playing; tilt gate is advisory.
- `worry_dump` text never leaves the device without explicit consent and never goes to the LLM.
- Drill rendering must be fast and mobile-friendly (flicker timing must be accurate; use `requestAnimationFrame`, not `setTimeout`, for flashes).
- Accessibility: colour-blind-safe highlights, keyboard controls, reduced-motion mode that replaces the flicker with a side-by-side comparison.

---

## 10. Build phases and acceptance criteria

**Phase 1:** `check_flash`, `loose_pieces`, `what_changed`, `easy_sprint`, `setup_check`, session composer (band + time control only), event logging.
- Accept when: generators produce only legal positions (unit tests on 1,000 generated items each), answers verified against the chess library, a 5-minute session runs end-to-end on mobile, events persist.

**Phase 2:** `threat_count`, `double_check_hunt`, `opponent_threat`, `two_candidates`, blindspot-family personalization, `routine_builder`, `breathing_reset`, `tilt_gate`, `move_nudge`, `worry_dump`.
- Accept when: personalization uses existing `cluster_id`s, `two_candidates` items verified with multi-PV, tilt gate triggers correctly on fixture game histories.

**Phase 3:** coach tool, outcome linking, randomized comparison with consent, internal dashboard.
- Accept when: next-game linking works on fixture data, assignment is random and stored, dashboard shows warm-up vs. control by band.

After each phase: run the full test suite, summarize what changed, and list anything you were unsure about.
