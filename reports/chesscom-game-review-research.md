# Reproducing Chess.com Game Review

Research date: 19 October 2026. Scope: move annotations and counts, player accuracy, and single-game performance rating from a PGN.

## Finding

I did not find a verified public implementation of Chess.com's complete production algorithm. Its public material exposes useful components, but it does not supply enough to guarantee the identical report for an arbitrary PGN. Several projects implement similar labels; their formulas and validation evidence differ substantially.

The most useful discovery was a first-party Reddit AMA with Chess.com's Director of Product, Dylan Rittman. It adds rules absent from the ordinary expected-points table: concrete material/mate punishment for Blunder; an exclusion for obvious recaptures from Great; a distinction between rating-aware annotations and rating-independent accuracy; and a planned change to Game Rating. These details materially change how a compatibility implementation should be designed. [S4–S6]

| Component | What the evidence establishes | What remains missing |
|---|---|---|
| Ordinary move categories | Published expected-points loss boundaries | The fitted rating-dependent evaluation conversion, exact ties, precision, and all contextual overrides |
| Book | Opening-theory annotation | Exact book corpus and membership/continuation rules |
| Great | Critical/only-good moves, with obvious recaptures excluded | Numerical gates, exceptions, and precedence |
| Brilliant | Strong piece/exchange sacrifices; additional context matters | Exact sacrifice detector, tolerances, rating adjustments, phase rules, and precedence |
| Miss versus Blunder | Missed opportunities differ from concretely punishable errors | Exact tactical/material detector and search horizon |
| Accuracy | CAPS2; stored values sometimes available through PubAPI | Complete transformation and game aggregation |
| Game Rating | Published rating-relative description; an independent replacement was announced | Formula, coefficients, rounding, and verified replacement rollout status |

This is a research result and implementation specification, not a claim that an exact clone has been built or tested.

## 1. Move classification

### Published numerical layer

Chess.com's Classification V2 documentation gives this table. Values are expected game points lost on a 0–1 scale, not centipawns and not a relative percentage reduction. [S1]

| Category | Published lower limit | Published upper limit |
|---|---:|---:|
| Best | 0.00 | 0.00 |
| Excellent | 0.00 | 0.02 |
| Good | 0.02 | 0.05 |
| Inaccuracy | 0.05 | 0.10 |
| Mistake | 0.10 | 0.20 |
| Blunder | 0.20 | 1.00 |

For example, an expected-score change from 0.60 to 0.48 loses 0.12 game points: it lies inside the ordinary Mistake band.

An implementation-oriented mathematical description is:

\[
L_i=\max\left(0,E(v_i^\star,r,\ldots)-E(v_i^{\mathrm{played}},r,\ldots)\right).
\]

Here both evaluations use the mover's perspective; the star denotes the best available continuation. This expresses the published loss concept. It does **not** establish Chess.com's precise search procedure or the unknown function E.

Important implementation limits:

- The documentation identifies rating and engine evaluation as inputs to its expected-points model. It does not provide its fitted conversion. Substituting a logistic curve is a hypothesis.
- Adjacent printed ranges share endpoints. The page does not resolve every strict versus inclusive comparison or the overlap between Best and Excellent at zero.
- Engine-top identity, near-equivalent alternatives, rounded evaluations, mate scores and probability saturation require separate investigation.
- The table alone is insufficient to recover the final annotation because contextual rules can intervene.

“Expected points” should not casually be equated with literal win probability. In ordinary chess scoring, expected score is P(win) + 0.5 P(draw). Stockfish's native WDL is calibrated to engine games, while Chess.com's documented classification model is human/rating dependent. The sources do not establish that the latter is simply Stockfish WDL. [S1, S9]

### Blunder has an additional condition

In the staff AMA, Dylan explains the distinction:

> This led us to rethink our definition of blunder and require a "concrete" punishment of material or mate. And also had us differentiate Misses vs Blunders. [S4]

Consequently, crossing the 0.20 band does not by itself specify every final Blunder label. A reproduction needs a concrete-punishment detector. Its depth, material accounting, treatment of positional losses and interaction with Miss are not disclosed in that answer.

An immediate hanging-piece test is a possible feature, not a recovered definition. Multi-move combinations, forced mates and material compensation make a one-ply capture check inadequate as a universal substitute. This is an implementation inference.

### Great

The product director's explanation includes an often omitted exception:

> The direct answer to your question is that a Great move is when you find the only good move in the position (excluding too-obvious moves like recapturing a piece). Plus some other cases like finding a move that gives you a winning position or gets you back to equality from a losing position. [S5]

The reply provides no numeric definition of only-good, winning, equal or too-obvious. A gap to the second-best move is a useful feature; a fixed gap is not established as their algorithm.

When interpreting a turnaround, preserve the preceding opponent move. Under ideal minimax evaluation, the opportunity already exists before the player chooses the correct reply. Do not implement “a good move increases the mover's minimax evaluation” as a required condition.

### Brilliant

The classification help page also requires an acceptable resulting position, rules out moves unnecessary to preserve an already decisive advantage, and describes greater sacrifice generosity for newer players. The numerical tests are unpublished. [S1]

Chess.com's instructional article supplies additional operational detail: a strong piece or exchange sacrifice is typical; an endgame sacrifice must be the only good option, whereas an opening/middlegame sacrifice can be one of several strong choices. The position must remain competitive. Its repeated-rook example shows that a sacrifice can qualify even when the opponent declines to accept it. The article is useful evidence, dated February 2024, rather than a complete current specification. [S3]

The staff answer also settles whether the sacrifice must be the engine's literal first choice:

> It doesn't have to be exactly the best move, but it needs to be close to it. Literal best moves per the engine vs a move only some small centipawn below it is not a real distinction in human terms. And there's engine jitter so if you let the engine think longer it could change its mind anyways. [S6]

Unknowns include the allowable evaluation loss, legal offer and exchange accounting, compensation horizon, phase detector, rating generosity and already-winning counterfactual. A large pre-move advantage alone should not be assumed to veto Brilliant: the sacrifice might be the only continuation preserving that advantage. That last point is a logical implication of assessing the alternatives, not a recovered numerical rule.

Avoid the outdated explanation that Brilliant means the engine initially failed to see the move. It does not describe the current published definition.

### Book and Miss

The general product guide calls Book a conventional opening move. It does not expose the exact database. An ECO name attached to a position is not evidence that all of Chess.com's book annotations can be reproduced from that ECO file. [S2]

The classification documentation describes Miss in terms of failing to exploit an opponent's error, with rating-sensitive outcome judgments. Exact missed-mate rules, material tests and precedence against Blunder remain open. [S1, S4]

Do not silently import additional labels from clones. For example, some projects add Forced, Interesting, Critical or Theory. Those projects' category sets are not proof of the target product's category set.

## 2. Accuracy

Chess.com names its current system CAPS2 and describes engine-relative quality, without publishing the complete formula. Accuracy is a 0–100 score; it is not simply the fraction of moves matching the first engine line. [S7]

Crucially, the staff AMA describes Accuracy as independent of the player's rating. That statement should prevent automatically reusing rating-adjusted annotation probabilities for numerical accuracy. [S4]

### A frequently misattributed formula

Lichess publicly documents:

\[
W(c)=\frac{100}{1+\exp(-0.00368208c)},
\]

\[
a_i=103.1668\exp(-0.04354\,\Delta W_i)-3.1669.
\]

Here c is the engine's centipawn evaluation and the loss ΔW is measured in percentage points on the 0–100 scale. Its game-level method combines volatility-weighted and harmonic means. Source implementation details can add clamping and a search-uncertainty adjustment. These are Lichess methods; finding them in a repository or Reddit post does not identify CAPS2. [S8]

### Backrank's matching result

The [Reddit post](https://www.reddit.com/r/Chesscom/comments/1u9jc2q/we_reverseengineered_chesscoms_accuracy_score/) titled “We reverse-engineered Chess.com's Accuracy Score” links to the author's own [technical write-up](https://backrank.io/blog/how-chess-accuracy-works). The article reports 928 games, correlation 0.934, approximately zero mean bias and 75% of scores within three points. It uses a power-mean construction with a floor. [S10]

This is the strongest explicit accuracy-agreement result located in this search, not an independently reproduced leaderboard of every implementation. Its sample consists of games from Hikaru, GothamChess and Naroditsky. Broad rating/time-control transfer is unestablished. The article does not disclose a complete numerical parameter set or reusable raw benchmark sufficient to reproduce its result.

The author's suggestion that remaining error is probably engine/version differences is a hypothesis. Without holding evaluations fixed, it does not isolate engine error from scoring-model error. High correlation and zero bias do not establish identical outputs.

### A useful approximation family, not recovered CAPS2

One family worth comparing experimentally is:

\[
a_i=\operatorname{clip}\left(Ae^{-k\Delta W_i}+B,0,100\right),
\qquad
Q=\operatorname{clip}\left[
\left(\frac{\sum_iw_i\max(a_i,f)^p}{\sum_iw_i}\right)^{1/p}+b,0,100\right].
\]

The p=0 limit is the weighted geometric mean. Parameters A, k, B, f, p, b and weights w must be fitted or otherwise specified. This is a proposed family combining common public approximation ideas; none of its parameters is presented as a recovered Chess.com coefficient. Keep a Lichess aggregation baseline as a separate candidate.

Do not infer undisclosed handling of opening moves, forced moves, short games, decided positions, mate transitions or display rounding from any one clone.

## 3. Single-game rating

Chess.com's February 2026 help article describes Game Rating relative to expected move quality at the player's normal rating. Historical user experiments changed PGN rating headers while preserving the moves and obtained different Game Ratings. The experiment is community evidence, not a reproduced test in this session. [S11, S12]

However, the product director announced a replacement:

> Game Rating is a feature I agree needs a quality improvement. And it's one we're actively working on. When the new version is released, the player's rating will not be taken into account when determining Game Rating (just like Accuracy today). So if you and Magnus play the exact same game, you'll get the exact same Game Rating! [S4]

I did not locate a verified rollout announcement or a controlled current comparison establishing that replacement as the universal production behavior by the research date. The announcement is evidence of planned behavior; it is not evidence that rollout completed.

Therefore:

- Preserve WhiteElo, BlackElo and other original game metadata.
- Establish which rating model the specific target review uses before fitting.
- Run rating-header interventions under fixed review settings when a permitted normal review workflow is available.
- Record both players' scores, all annotations, accuracy and Game Rating in each intervention, rather than assuming what changed.
- Keep an unknown-rating case; do not silently replace missing ratings with 1500 and call it equivalent.

No verified coefficients for the production rating model were recovered. Expressions such as 3100 exp(-0.01 ACPL), an accuracy-to-rating lookup table or a blend with the PGN rating belong to particular alternative implementations. Their simplicity does not establish their identity with Chess.com's system. [S16]

This display is also distinct from updating an account's competitive rating and from a tournament performance rating computed from a sequence of results.

## 4. Engine configuration is part of the target

Chess.com's August 2026 engine help page identifies its server-side Game Review engine as Stockfish 18 with full NNUE. This contradicts older third-party README claims that their Stockfish 16.1 default necessarily matches the current service. [S13]

Another official article distinguishes the quick local post-game summary from the deeper server review and states that review strength settings can change the result. [S14]

For exact compatibility, record or investigate:

| Dimension | Why it matters |
|---|---|
| Engine binary and NNUE | Evaluation, principal variation and top-move identity |
| Search budget | Node, time or depth limits can produce different choices |
| Threads and hash state | Search history, resource allocation and repeatability |
| MultiPV and restricted searches | Alternative quality and played-move evaluation |
| Full position history | Repetition, draw rules and state-dependent search |
| Tablebases | Terminal/result handling in small endgames |
| Score precision and perspective | Boundary decisions, Black sign and mate handling |
| Product/review version and platform | Classification and scoring changes over time |

These are engineering variables to control, not a claim that each specific value is known to differ in Chess.com's production system. More search depth can improve chess analysis while reducing agreement with a shallower target review. Do not optimize compatibility by assuming deeper is always closer.

Stockfish explicitly documents that it does not itself emit Brilliant or Blunder labels. Those are application logic layered on its evaluations. [S9]

An attempted read of the public Chess.com analysis page returned HTTP 403 in this environment. I did not inspect its current frontend bundles, access a signed-in review, bypass that response or recover production classifier code from it.

## 5. GitHub audit

Source code was retrieved from public GitHub repository trees at the commits listed below. These are inspection results. I did not rerun each project's engine pipeline or its published calibration experiments.

| Project | What I inspected/found | Relevance to exact reproduction |
|---|---|---|
| [WintrCat/freechess](https://github.com/WintrCat/freechess) | `classification.ts` uses quadratic evaluation-loss limits. `analysis.ts` averages fixed category values to obtain accuracy. | An older heuristic design; neither mechanism is recovered CAPS2. |
| [WintrCat/wintrchess](https://github.com/WintrCat/wintrchess) | `expectedPoints.ts` defaults to logistic slope 0.0035. `accuracy.ts` uses 103.16 exp(-4 ΔE) - 3.17 and a mean of stored move accuracies. | Different scoring from the old repository. Exact compatibility is not established. |
| [GuillaumeSD/Chesskit](https://github.com/GuillaumeSD/Chesskit) | `accuracy.ts` implements a Lichess-derived exponential, a +1 adjustment, volatility weights, and a harmonic calculation with a floor. | Useful baseline; Lichess provenance is explicit. |
| [TxClaudes/chess](https://github.com/TxClaudes/chess) | Configurable expected-loss thresholds, explanatory helpers, and a calibration script fitting stored Chess.com accuracy. Default decay is 0.055; optional power/floor/offset aggregation is fitted rather than recovered. | Useful starting point for a compatibility experiment. README explicitly calls it an approximation. [S16] |
| [T-Julsgaard/Chess-Review](https://github.com/T-Julsgaard/Chess-Review) | Public methodology explicitly says its current fitting evidence uses no Chess.com review outputs; numerical models are independently calibrated. | Inspectable independent design, not evidence of identifying CAPS2. [S17] |
| [SailingSF/chesslens-core](https://github.com/SailingSF/chesslens-core) | Elo-adjusted sigmoid, concrete-blunder rules and many fitted exceptions. Comments report 72.72% classification agreement on a 796-game/~46k-move corpus for one tuning stage. | Useful features/harness, substantially short of exact parity. The referenced corpus was absent from the retrieved tree; I could not independently reproduce that claim. [S18] |

The final row's percentage measures **move-label agreement**, not the player's accuracy score. Its config comments describe multiple stages and do not establish that 72.72% is the latest independently held-out production result.

Pinned inspected revisions:

| Repository | Commit |
|---|---|
| WintrCat/freechess | `c593326761ed30fd1adfd3349a60aa78953e5a1f` |
| WintrCat/wintrchess | `d145b20968955ca955cafe3fc3b51305f3bf41f9` |
| GuillaumeSD/Chesskit | `9622d502ab9fc84fc1486e22310a7df229a37e93` |
| TxClaudes/chess | `6fa47bb94f76b44596825d332dce7604d07f554e` |
| T-Julsgaard/Chess-Review | `d062fa1884863279ed5d321996949165e7aab09e` |
| SailingSF/chesslens-core | `ec309617b6027f096d70c9bf2ada934efdce4b10` |

Particularly useful source files:

- [Old WintrCat classification](https://github.com/WintrCat/freechess/blob/c593326761ed30fd1adfd3349a60aa78953e5a1f/src/lib/classification.ts) and [aggregation](https://github.com/WintrCat/freechess/blob/c593326761ed30fd1adfd3349a60aa78953e5a1f/src/lib/analysis.ts).
- [Current WintrCat expected points](https://github.com/WintrCat/wintrchess/blob/d145b20968955ca955cafe3fc3b51305f3bf41f9/shared/src/lib/reporter/expectedPoints.ts) and [accuracy](https://github.com/WintrCat/wintrchess/blob/d145b20968955ca955cafe3fc3b51305f3bf41f9/shared/src/lib/reporter/accuracy.ts).
- [Chesskit accuracy](https://github.com/GuillaumeSD/Chesskit/blob/9622d502ab9fc84fc1486e22310a7df229a37e93/src/lib/engine/helpers/accuracy.ts).
- [TxClaudes calibration](https://github.com/TxClaudes/chess/blob/6fa47bb94f76b44596825d332dce7604d07f554e/tools/calibrate.py), [configuration](https://github.com/TxClaudes/chess/blob/6fa47bb94f76b44596825d332dce7604d07f554e/config.py) and [summary](https://github.com/TxClaudes/chess/blob/6fa47bb94f76b44596825d332dce7604d07f554e/review/summary.py).
- [Chesslens configuration](https://github.com/SailingSF/chesslens-core/blob/ec309617b6027f096d70c9bf2ada934efdce4b10/config/classification.py) and [comparison harness](https://github.com/SailingSF/chesslens-core/blob/ec309617b6027f096d70c9bf2ada934efdce4b10/tests/_classification_comparison.py).

Several deep GitHub links were unavailable to the web retrieval tool; the corresponding files were successfully read through GitHub's public raw-file service at the pinned commits. No complete production Chess.com source was recovered by either route.

## 6. Exact stored accuracy through the documented API

The Published-Data API documents an optional `accuracies` object in monthly game archives when those accuracies were previously calculated. [S15]

Documented endpoint pattern:

```text
https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}
```

This session made one serial, read-only request to:

```text
https://api.chess.com/pub/player/erik/games/2026/06
```

The response contained 11 games, all with an `accuracies` field. One observed record was:

```json
{
  "game_url": "https://www.chess.com/game/daily/978256050",
  "accuracies": {"white": 75.07, "black": 64.84}
}
```

This verifies retrieval of actual stored scores, not their recalculation. The observed record did not contain the per-move review labels or estimated Game Ratings. Do not substitute account ratings in the white/black objects for Game Ratings.

For a known Chess.com game, match the archive entry by its game URL/identifier. For a PGN-only import, normalize legal moves and initial state and then match candidate records; player names, end month and a game link make this far more reliable. Do not use a free-form substring comparison as proof of game identity.

Archive month follows game end, which matters for Daily games spanning months. Preserve the raw accuracy value and establish the target UI's display rounding separately.

The API route does not calculate a new review, guarantee that every game has accuracy, or expose a documented full-review service for arbitrary PGNs. Its official documentation also distinguishes permitted public API use from scraping/undocumented endpoint workarounds. [S15, S19]

## 7. Implementation path for the stated goal

The following is a proposed investigation plan. It has not been executed as a calibrated reproduction.

### Establish an observable target

Choose full server review, a specific strength setting, platform and observation date. Keep the quick game-over summary as a separate target. Determine the current rating-model behavior with controlled PGN rating-header changes; the 2026 announcement makes this necessary.

Start with roughly 100–200 consented or otherwise permitted reference reviews to diagnose missing signals; expand to a diverse corpus before claiming transfer. This sample size is a suggested starting budget, not a proven sufficiency threshold.

Capture PGN and metadata, ordered per-ply labels, displayed evaluations, both raw/displayed accuracies when available, both Game Ratings, review settings and timestamps. Save exact copies of the observed outputs. Avoid treating an old cached review as a newly computed review.

### Separate the unknown functions

1. **Engine compatibility:** compare target evaluations/top moves with a pinned local engine before changing the category thresholds.
2. **Annotation mapping:** estimate a monotone rating-aware expected-score function and test it against ordinary labels. Keep the published bands as a documented baseline.
3. **Contextual rules:** add sacrifice, legal material offer, endgame/only-move, trivial-recapture, concrete-punishment and missed-opportunity features. Treat rule precedence as an explicit unknown.
4. **Accuracy:** fit separately without automatically incorporating rating-dependent category labels. Compare arithmetic, Lichess and power-mean baselines.
5. **Game Rating:** fit the observed target version; compare rating-relative and rating-independent candidates rather than conflating them.

This decomposition helps distinguish a wrong engine evaluation from a wrong mapping. End-to-end fitting alone can hide one error by compensating for another.

### Experiments with high diagnostic value

| Intervention | Question it answers |
|---|---|
| Same moves, changed rating tags | Which outputs depend on rating in this product version? |
| Same game, repeated identical review settings | How stable is the target itself? |
| Same game, changed review strength | How much disagreement originates in search? |
| Positions near each ordinary boundary | What are comparison, precision and tie conventions? |
| Declined sacrifice, exchange sacrifice, persistent hanging piece | What material-offer conditions matter? |
| Only-winning sacrifice versus several winning alternatives | What is the competitive-relevance gate? |
| Endgame versus middlegame sacrifices | Does the published phase-specific requirement still apply? |
| Obvious recapture versus nontrivial only move | What excludes Great? |
| Large positional loss versus immediate/delayed material loss | What separates Blunder, Mistake and Miss? |
| Forced moves, book-heavy short games and long decided endings | What enters accuracy aggregation? |
| Mate-to-mate, mate-to-CP and tablebase transitions | What special score rules apply? |

These require reference outputs obtained through a permitted workflow. This session did not generate a new Chess.com review or conduct these interventions.

### Measure exactness directly

| Output | Evaluation |
|---|---|
| Per-move labels | Exact agreement, confusion matrix, per-class precision/recall and macro-F1 |
| Complete breakup | Fraction of games whose entire ordered annotation sequence and both count vectors match |
| Accuracy | MAE, median/95th-percentile error, bias, exact displayed-value agreement, within 0.1/1/3 points |
| Game Rating | MAE and exact displayed agreement, separated by model version and rating band |
| Engine layer | Evaluation differences and top-move/alternative agreement |
| Target stability | Disagreement rate across repeats of the same target configuration |

Split by game and preferably by player. Keep both sides of a game together. Maintain a final untouched test set. A fit on one account or only titled-player games does not establish general parity. Counts alone can match despite different moves being mislabeled.

Finite black-box observations can support measured compatibility on a domain. They cannot uniquely identify an arbitrary hidden algorithm on all unseen inputs. Exact guarantees require the actual specification or an authorized call to the same production computation, plus compatible engine behavior.

## 8. Instructions for a coding agent

- Label recovered/public rules, source-specific approximations and newly fitted hypotheses separately.
- Preserve original PGN metadata and legal position history.
- Keep annotation scoring, numerical accuracy and game-rating estimation as distinct modules.
- Pin engine build, network, search settings and model versions in every result.
- Do not call Lichess's constants Chess.com's CAPS2 constants.
- Do not assume matching 2/5/10/20 boundaries means matching final categories.
- Do not require the opponent to accept a sacrifice merely because material has not yet disappeared.
- Do not require Brilliant to be the exact top engine move.
- Do not treat the old rating-aware Game Rating as an immutable current specification.
- Do not assign fixed accuracy weights to categories and advertise the result as recovered CAPS2.
- Keep imported official accuracy separate from a locally estimated score.
- Report measured parity and its test cohort. Do not promise identical arbitrary-PGN output without evidence.

## Sources

Primary product documentation and staff statements:

- **S1:** [Chess.com — How are moves classified?](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc), February 2026. Ordinary bands, rating-aware expected points and special-label descriptions.
- **S2:** [Chess.com — How does Game Review work?](https://support.chess.com/en/articles/8584089-how-does-game-review-work). Product categories and Book meaning.
- **S3:** [Chess.com — How To Play A Brilliant Move](https://www.chess.com/article/view/how-to-play-a-brilliant-move), updated February 2024. Endgame requirement, exchange sacrifices and declined repeated-rook offers.
- **S4:** [Dylan Rittman staff AMA — concrete blunders, accuracy independence and planned Game Rating change](https://www.reddit.com/r/Chesscom/comments/1tp1pc9/comment/oom4p69/). First-party statement; rollout not established by the announcement.
- **S5:** [Dylan Rittman staff AMA — Great and obvious recaptures](https://www.reddit.com/r/Chesscom/comments/1tp1pc9/comment/oolw3ik/).
- **S6:** [Dylan Rittman staff AMA — Brilliant may be near-best](https://www.reddit.com/r/Chesscom/comments/1tp1pc9/comment/oomc77v/).
- **S7:** [Chess.com — How is accuracy in Analysis determined?](https://support.chess.com/en/articles/8708970-how-is-accuracy-in-analysis-determined). CAPS2 description; no complete formula.
- **S8:** [Lichess — Accuracy metric](https://lichess.org/page/accuracy). Public win-chance and accuracy formulas; game aggregation.
- **S9:** [Stockfish — FAQ](https://official-stockfish.github.io/docs/stockfish-wiki/Stockfish-FAQ.html). WDL calibration and separation of engine evaluations from annotations.
- **S10:** [Backrank — How we reverse-engineered Chess.com's accuracy score](https://backrank.io/blog/how-chess-accuracy-works), June 2026. First-party approximation and agreement claims.
- **S11:** [Chess.com — How is Game Rating calculated in Game Review?](https://support.chess.com/en/articles/10773754-how-is-game-rating-calculated-in-game-review), February 2026.
- **S12:** [Reddit — Changing PGN rating headers changes Game Rating](https://www.reddit.com/r/chess/comments/15o7z7g/chesscom_rating_review_estimates_are_biased_by/). Historical first-person experiment; not independently repeated here.
- **S13:** [Chess.com — How do the chess engines work?](https://support.chess.com/en/articles/9462780-how-do-the-chess-engines-on-chess-com-work), August 2026.
- **S14:** [Chess.com — Why did my move classification change?](https://support.chess.com/en/articles/11845102-why-did-my-move-classification-change-in-game-review). Local quick summary, server review and strength settings.
- **S15:** [Chess.com — Published-Data API](https://www.chess.com/news/view/published-data-api). Monthly archive, optional stored accuracies and game metadata.
- **S16:** [TxClaudes/chess README](https://github.com/TxClaudes/chess), with pinned code links in the audit above. Explicit approximation, calibration approach and heuristic rating.
- **S17:** [T-Julsgaard/Chess-Review — public methodology](https://github.com/T-Julsgaard/Chess-Review/blob/main/tools/calibration/PUBLIC_METHOD.md). Explicitly independent fitting evidence.
- **S18:** [SailingSF/chesslens-core](https://github.com/SailingSF/chesslens-core), with pinned configuration and harness links in the audit above. Source-specific fitted rules and unreplicated agreement comments.
- **S19:** [Chess.com — What is the PubAPI and how do I use it?](https://support.chess.com/en/articles/9650547-what-is-the-pubapi-and-how-do-i-use-it). Permitted API access and request behavior.

Other community leads checked include the [2026 Reddit classification explainer](https://www.reddit.com/r/Chesscom/comments/1re18pl/this_is_how_move_classification_actually_works/) and the [2026 Chess Ramp accuracy-matching write-up](https://www.chessramp.com/blog/how-chess-com-game-review-works). The former presents a familiar Lichess coefficient without establishing it as Chess.com's fitted model. The latter describes another fitted approximation rather than recovered production code. Neither closes the missing-specification gap.
