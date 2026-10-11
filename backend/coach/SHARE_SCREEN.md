# Share Screen coach: implementation, limits, and testing

This is the handoff for the first **Forked Analysis Board-only** voice session,
added alongside the existing Coach. Read [README.md](README.md) for the underlying
position investigation and its verification limits. Nothing replaces the original
Coach, Analysis Board, or other training sections.

## What is implemented

- `/share-screen`, with a navigation entry immediately above Dashboard.
- A static tutorial and call preview before permissions are requested.
- A separate linked Analysis Board tab, with New game, Checkmate, and Knight fork
  starting positions. Normal board moves, undo, reset, and flip remain available.
- Actual browser tab capture and a muted live video preview in the call.
- Exact position and last-move synchronization after **2.5 seconds** without a
  position change, rather than attempting to recover incomplete FEN state from pixels.
- English voice questions and English spoken replies. The call renders statuses
  and controls, but no question transcript, answer text, chat feed, or evidence cards.
- Move review using the position **before** the last move; current-position
  questions use the board **after** it. The backend validates the relationship.
- Stockfish investigation, candidate comparison, checked tactical evidence,
  concise local narration, and optional existing Groq narration.
- Mute/unmute, interrupt, repeat answer, end call, stale-board detection, and
  cancellation of outdated answers when the position or shared source changes.
- A small banner in the linked board tab shows the call state and lets the user
  interrupt without returning to the call tab.

This is a working first slice, **not a measured SOTA claim**, arbitrary-screen
vision model, or full-duplex low-latency audio model. Physical microphone/speaker
quality and native browser-picker behavior require the user's hardware trial.

## Start a session

1. Run the existing frontend/backend (commands in the Coach README), then open
   `http://localhost:5173/share-screen` after resuming a local user profile.
2. Use desktop **Chrome first**. Edge is feature-detected but speech-service
   availability depends on its browser/device configuration. Use localhost or HTTPS.
3. Optionally press **Test English voice**. Check the browser's sound setting and
   use headphones to reduce feedback.
4. Choose a starting position and click **Open Analysis Board**. Return to the
   Share Screen tab, leaving that board open.
5. Click **Start sharing**. In the browser picker, select the browser tab named
   **Forked • Board for live coach**. Do not choose the entire desktop, an application
   window, an unrelated board, or the call itself.
6. Allow microphone access when the browser asks. Wait until the coach says it has
   your board. Keep the call tab open while making moves in the board tab.
7. Pause briefly, then ask “Was that a good move?” or “What should I play now?”
8. Use **Interrupt coach** in the board tab, or **Interrupt** in the call, to stop
   an answer. **End call** releases capture and stops speech/listening.

The browser decides which picker choices to offer and always owns capture
permission. Forked cannot silently choose a tab or retain capture permission.

## Free operation and configuration

The default path uses local Stockfish, browser SpeechRecognition, and browser
SpeechSynthesis. It does not invoke a hosted model and requires **no new API key,
subscription, model download, or dependency installation** in this checkout.

**Use AI wording (Groq)** is an explicit, off-by-default option. It uses the
existing server-side `GROQ_API_KEY`, `FORKED_COACH_MODEL`, evidence prompt, and
narration checks. It never invokes C1. Enable it only when the account has free
quota available: code cannot certify an account's billing state or promise that
a provider's quota is unlimited. Missing credentials, rate limits, model failures,
and rejected prose fall back to the local spoken summary. No key reaches the browser.

Local wording is a deterministic summary of evidence. It can discuss the move,
score gap when comparable, a checked tactical fact/defense, and an alternative.
It does **not** give the flexible semantic follow-ups of a language model. Groq
wording enables that conversational layer while preserving the same investigation.
Neither mode proves arbitrary strategic explanations; the existing Coach caveats
still apply.

Browser speech recognition can send audio to the browser vendor's speech service
and can require internet even when the chess explanation is local. Browser TTS
prefers an English local voice when available and otherwise uses an available
English voice. No paid speech API is integrated.

## Why this does not reconstruct FEN from an image

A board image does not reveal castling rights, en passant, halfmove counters, or
reliable move history. Since the approved first scope is Forked's own board, the
implementation uses an explicit connection to that board's chess.js state.

The screen is genuinely captured for the call preview. **No screenshot is sent
to a vision model or OCR service.** Selecting a valid board tab also exposes a
browser Capture Handle. That handle binds the captured source to the exact board
publisher. The coach gets FEN through this connection, not by recognizing piece
pixels. It does not verify whether the board is currently scrolled into view.

External sites, physical boards, entire-display capture, and window capture are
outside this slice. They are rejected rather than silently paired with an arbitrary
open Forked board. Another Forked tab cannot overwrite the selected board's state.

## File map

| File | Responsibility |
| --- | --- |
| `frontend/src/pages/ShareScreen.tsx` | Tutorial, demo, starting positions, call preview, status and controls. |
| `frontend/src/features/share-screen/boardLink.ts` | Capture Handle identity, session-scoped BroadcastChannel, exact board publication. |
| `frontend/src/features/share-screen/useShareSession.ts` | Capture lifecycle, stabilization, stale detection, turn requests, history and cancellation. |
| `frontend/src/features/share-screen/useLiveVoice.ts` | Browser recognition, English TTS, turn-taking, errors and cleanup. |
| `frontend/src/pages/AnalysisBoard.tsx` | Opt-in publisher for `?coachShare=<uuid>`, live banner and interruption. Illegal drag attempts now return false rather than throwing. |
| `backend/coach/live.py` | Request validation, temporal question routing, local spoken summary and notation expansion. |
| `backend/coach/router.py` | `POST /api/coach/live-turn`. |
| `backend/coach/explain.py` | Optional short spoken-style prompt on the existing evidence narrator. |
| `tests/test_coach_live.py` | Root selection, special moves, stale transition rejection, free-mode isolation, scores and speech notation. |
| `scripts/test_share_screen.cjs` | Browser integration test using the real board and local API, with simulated capture/speech hardware by default. |

## Session flow and lifecycle

1. A Share Screen page creates a random session UUID, held in memory.
2. Opening its Analysis Board passes the UUID in `coachShare`. The board creates
   its own random board ID and publishes `forked:<session>:<boardId>` as a Capture
   Handle visible **only to the same origin**. Unlinked boards do not publish.
3. The board broadcasts `{type, boardId, fen, beforeFen, lastMove}` on a channel
   named for the session. `lastMove` is UCI, including promotion; `beforeFen`
   comes from chess.js verbose history, not inferred from square changes.
4. After the user grants capture, the coach checks the actual video track's Capture
   Handle and origin. Only messages from that board ID are accepted.
5. The board sends a heartbeat every 750 ms and responds to coach polls every
   500 ms. A snapshot settles after 2,500 ms; silence over 5,500 ms disconnects it.
   Timers can be throttled by the browser; reconnection waits for fresh state.
6. A question received while the known board is still settling is queued for that
   exact snapshot. A further board change discards it; ask again after settling.
7. Each request has an AbortController and generation counter. Changed FEN/history,
   lost source, interrupted turns, unmounting, or ending the call invalidate the
   request and stop speech. Late responses cannot narrate the old board.
8. Source changes and muted capture invalidate immediately, with polling as a
   fallback. The browser's Stop sharing event ends the call.
9. A board change clears the previous answer and short conversation history. Up
   to six user/assistant messages are held only for the current snapshot.
10. End/unmount stops capture tracks, recognition, TTS, timers and the channel.
    No call, audio, transcript, or screenshot persistence is added.

Aborting an HTTP request suppresses its answer; it does not kill an already-running
backend Stockfish call. The existing bounded investigation/engine lock continues
until it completes. Searches normally have a 5-second budget; hosted narration
has its separate timeout. The frontend abandons requests after 35 seconds.

## Backend contract and move quality

`POST /api/coach/live-turn` accepts:

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "before_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "last_move": "e2e4",
  "question": "Was that a good move?",
  "previous_target": null,
  "history": [],
  "budget_seconds": 5,
  "use_llm": false
}
```

The backend validates full legal FENs, requires before/move together, replays the
move, and compares the resulting complete canonical FEN. Castling, promotion,
en passant and counters must match. No model decides whether a transition is legal.

With a last move, ordinary move reviews analyze `before_fen` with `last_move` as an
explicit focus. Questions with “now,” “next,” “who is better,” or “what should I
play” analyze the current FEN. A brief follow-up reuses `previous_target` unless
explicit temporal wording overrides it. This is a bounded English heuristic;
ambiguous questions may need rephrasing. The last move belongs to whichever side
just moved on the board, not an inferred permanent user color.

Explicit spoken piece/square phrases such as “knight to f 3” are normalized to
SAN-like notation for the existing legal-move extractor. Homophones and vague
references such as “the horse here” are not guessed. The endpoint returns
`speech`, `target`, `analyzed_fen`, `focus_move`, `source`, `status`, and `evidence`.
Only `speech` is played; evidence is available in the network response for diagnosis.

The local verdict uses original-mover-relative cp scores **only when both searches
were refined at matching completed depths**. A gap under 0.30 pawns is described
as close, 0.30 to under 1.00 as a small concession, and 1.00 or greater as significant.
These are simple communication thresholds, not calibrated accuracy/brilliancy
labels or win probabilities. Mate scores are never subtracted as centipawns.
Unequal-depth and incomplete searches are qualified. Verified short terminal
consequences outrank generic material claims; e.g. the demonstration fork saves a
draw even though it captures a queen.

SAN is expanded for speech: `Nf6+` becomes “knight to f six, check”, castling names
the side, and capture/promotion/disambiguation are retained. English TTS receives
short sentence chunks, avoiding long-utterance stalls and preserving decimal scores.

## Relation to AIM.txt and the end goal

[AIM.txt](../../AIM.txt) remains direction material, not an override of the user's
current request. This feature takes its position explanation, counterfactual move
comparison, grounded teaching, and conversational interaction goals into a spoken
setting. Calculation stays in Stockfish; legal state and tactical checks stay in
chess libraries; a language model optionally explains the checked evidence.

The long-term goal remains a reliable conversational chess coach that explains
why a move works, investigates alternatives, answers follow-ups, and teaches from
the actual position. The screen-share layer makes the context effortless. It
does not by itself advance or validate the underlying research on causal chess
explanations. Improved strategic verification, explanation quality benchmarks,
lower response latency, richer memory, flexible visual input and full-duplex
conversation remain separate future work guided by user feedback.

## Validation and manual acceptance tests

Automated commands (from the repo root):

```powershell
& .\.venv\Scripts\python.exe -m pytest tests/test_coach_live.py tests/test_coach_investigation.py -q -p no:cacheprovider
node scripts/test_share_screen.cjs
Set-Location frontend
npm.cmd run build
```

The Python tests passed (57 at implementation time). The browser test passed with
the actual app, two tabs, BroadcastChannel, legal moves, and real Stockfish API.
It checks the tutorial/nav, local default, rejected wrong source, exact pre-move
request, audio-only rendering, stale-answer cancellation, source changes, mute,
undo and cleanup. Capture streams/handles and speech devices are simulated in the
default test. `--real-capture` attempted Chrome/Edge's native picker but timed out
in this environment; it is **not** counted as a passing physical capture test.
Browser screenshots under ignored `logs/` illustrate UI, not successful speech
recognition or actual captured board pixels. The build has the repo's existing
large-bundle warning. No new runtime dependencies were added.

Please try these tests on your actual microphone/speaker setup:

| Test | Steps | Expected result |
| --- | --- | --- |
| Start and sound | Test English voice, open New game, share the named browser tab, allow microphone. | Live board preview, greeting after about 2–3 seconds, listening status. No answer text. |
| Review the last move | Play e2–e4 and ask “Was that a good move?” | Coach reviews White's e4 from the starting position; does not call Black's next move your move. |
| Current position | After e4 ask “What should I play now?” | Coach explicitly discusses Black to move. |
| Checkmate | Start a new call with Try a checkmate. Move the rook a2–a8; ask about it. | Checkmate explanation; no suggested opponent reply after mate. |
| Counterfactual | In the same sample, undo and play a2–a3; ask about the move. | Coach considers Ra8 as a stronger alternative, with mate handled separately from pawn evaluation. |
| Fork versus win | Start Try a knight fork, play d5–f6, ask why it works. | Check/fork; taking the queen leads to insufficient-material draw, not a winning endgame. |
| Follow-up | Keep the board fixed, ask “Why is the alternative better?” | Same comparison context. Local mode repeats bounded facts; optional AI wording can explain them conversationally. |
| Change mid-answer | Move a piece while the coach analyzes or speaks. | Old analysis/speech stops; new position settles before another question. |
| Undo/reset/flip | Undo, reset, then flip and ask again. | Current visible position stays authoritative. Flip alone doesn't change FEN or restart a turn. |
| Wrong source | Choose an unrelated tab/window or the call tab. | Clear rejection; no analysis based on another open board. |
| Disconnect | Close the board or navigate away; then use browser Stop sharing. | Board becomes unavailable; call ends on Stop sharing, microphone and playback stop. |
| Mute/interruption | Mute, speak, unmute; interrupt a long reply from the board banner. | No questions submitted while muted; coach stops and resumes listening after interruption. |
| Permissions | Cancel capture; deny microphone; retry after allowing it. | Recoverable status/error, no stuck call or hidden recording. |
| Optional AI | Enable AI wording only with free Groq quota. Ask a follow-up. | Same engine evidence, more natural spoken reply. Provider failure produces an announced local fallback. |

For useful feedback, note browser/version, starting sample, move, exact spoken
question, which board the coach seemed to discuss, answer accuracy, pronunciation,
and delay. If possible inspect `/api/coach/live-turn` in DevTools and save the
response manually; the UI deliberately has no text transcript or automatic recording.
