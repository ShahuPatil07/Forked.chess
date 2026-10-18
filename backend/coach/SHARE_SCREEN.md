# Share Screen: current implementation and testing

Updated October 2026. Read [Coach architecture](README.md) for the underlying
investigation and [Game Review](../GAME_REVIEW.md) for the other new study surface.
The accepted scope is **Forked's own Analysis Board**. External website recognition
and arbitrary-screen FEN recovery are not implemented.

## What changed and why

The original version opened a second Analysis Board tab and defaulted to a shorter
local summary. Background-tab microphone behavior made people switch back to the
call repeatedly, and local wording was much less helpful than ordinary Coach.

The current version embeds the same Analysis Board inside Share Screen. The board,
voice controls and browser speech recognition stay in one foreground document.
The default is now the **same configured Groq narrator as text Coach**, using the
same evidence and 8-second investigation budget. Local fallback also gained quiet
move observations and a concrete continuation. There is no separate weaker voice
analysis policy. All users get the same policy; profiles and prior sessions are
not loaded.

## Start and use a session

1. Open `http://localhost:5173/share-screen` in desktop Chrome (or a compatible
   Edge setup). Enter through the home page if there is no local profile.
2. The initial screen is a static tutorial/demo. Test English voice if desired.
3. Select New game, Checkmate or Knight fork, or paste your own starting FEN.
4. Click **Open Analysis Board**. The board opens **in this workspace**.
5. Click **Start sharing**. Select this browser tab, named
   **Forked - Board for live coach** (the actual title uses a bullet separator).
   Choose the browser-tab source, not an entire display/application window.
6. Allow microphone access and wait about 2.5 seconds for a stable position.
7. Play on the embedded board, pause briefly, and ask "Was that a good move?"
   Ask "What should I play now?" to analyze the current side to move instead.
8. Use Mute, Interrupt, Repeat answer and End call as needed. No tab switching
   is necessary. Undo, Reset, Flip and move navigation remain available.

The browser always owns the capture picker/permission. The app requests that the
current tab be offered; it cannot silently select it. There is no live video
thumbnail of the current tab, avoiding a recursive screen-within-screen effect.
The capture track still binds the chosen source to the exact board publisher.

## Data flow

1. The embedded Analysis Board owns chess.js state and publishes a session-scoped
   snapshot: board ID, full FEN, previous FEN, last move in UCI.
2. `setCaptureHandleConfig` identifies that document/board. The capture track's
   handle and origin must match the session and publisher before any snapshot
   is accepted. A different Forked tab cannot replace it accidentally.
3. BroadcastChannel carries snapshots and status inside the same origin. A second
   channel instance in the same document receives the embedded board's messages.
4. A snapshot must remain unchanged for **2500 ms**. Heartbeats expire after
   **5500 ms**; stale, changed, muted or mismatched capture sources invalidate it.
5. Browser SpeechRecognition collects a final English question. Requests carry
   exact state, a short in-session conversation and a previous question target.
6. `POST /api/coach/live-turn` validates that the legal last move actually transforms
   `before_fen` into `fen`. Deterministic temporal routing selects the last move's
   pre-move root or the current position. It does not ask an LLM to guess the board.
7. The shared investigator calculates candidates, alternatives, checked claims,
   defenses and teaching observations. The shared narrator explains them.
8. SAN is expanded for speech (e.g. Nf6+ becomes "knight to f 6, check"). Browser
   SpeechSynthesis speaks the English answer in sentence chunks. Listening pauses
   while the coach speaks, then restarts; Interrupt gives control back immediately.

Responses contain structured evidence for debugging, but the call displays only
statuses and controls. **No question transcript, answer text or chat feed** is
rendered. Video stays in the browser and is not sent to an OCR/vision service.
Speech recognition can send audio to the browser vendor's speech service. Forked
does not record calls. Position/question context goes to Groq only when narration
is enabled; credentials stay on the backend.

## Free tools and fallback

No new API key, paid speech API, model download or dependency is required for this
checkout. Existing local Stockfish handles calculation; browser APIs handle speech.
**Coach explanations** defaults on and uses the existing `GROQ_API_KEY` and
`FORKED_COACH_MODEL` configuration, subject to the configured account's free quota.
Missing credentials, quota limits, provider failure or rejected prose trigger the
local engine explanation; the voice explicitly announces that fallback. C1 is
bypassed in both active text-position and voice paths.

Disable the checkbox for completely local chess wording. Browser speech may still
need internet. Local explanations describe verified changes, material/terminal
consequences, sampled defenses and legal continuations. They are less flexible on
semantic follow-ups than the model. Neither path proves every strategic claim.

## Lifecycle and limitations

- Board change cancels a pending answer, speech and stale follow-up context. The
  question can queue briefly while its unchanged position settles.
- Capture source change, track end, page exit and End call release/invalidate the
  stream and stop speech. Generation checks discard late responses.
- The frontend times out an analysis turn after 35 seconds. A disconnected client
  can stop receiving a result; the underlying bounded Coach engine search may
  finish before releasing its shared lock.
- Screen capture, Capture Handle and SpeechRecognition availability limit support
  to appropriate desktop browsers on localhost/HTTPS. Mobile and Firefox are not
  supported by this preview. Headphones help avoid feedback.
- This is turn-taking conversation, not a full-duplex low-latency audio model.
- FEN preserves castling/en-passant/counters; this voice API does not reconstruct
  repetition from a full PGN history. Pixel recognition cannot recover those
  hidden rights reliably, which is why the approved Forked-only scope uses state.
- Capture proves source identity, not that the board is currently visible in the
  captured pixels. No claim of arbitrary screen recognition or measured SOTA.

## Files

| File | Role |
| --- | --- |
| `frontend/src/pages/ShareScreen.tsx` | Tutorial, starting FEN, embedded board and audio-only call controls. |
| `frontend/src/pages/AnalysisBoard.tsx` | Existing board plus a compact embedded mode; automatic background eval disabled in that mode. |
| `frontend/src/features/share-screen/boardLink.ts` | Capture identity, exact-state publisher and session channel. |
| `frontend/src/features/share-screen/useShareSession.ts` | Stable snapshots, request cancellation, temporal context and call lifecycle. |
| `frontend/src/features/share-screen/useLiveVoice.ts` | STT/TTS, interruption, recognition restart and audio errors. |
| `backend/coach/live.py` | Legal transition validation, question routing, shared narrator and speech conversion. |
| `backend/coach/teaching.py` | Shared concise explanation and board-derived quiet-move observations. |

## Validation and feedback checklist

Automated: `node scripts/test_share_screen.cjs` with servers running and desktop
Chrome installed. It uses simulated capture/STT/TTS but the real embedded board,
BroadcastChannel and local Stockfish API. It checks default narrator selection,
wrong-source rejection, no popup/tab switching, pre-move root, meaningful local
center explanation, audio-only output, stale-answer cancellation, reconnection,
mute/unmute, undo and cleanup. `--real-capture` attempts the native picker in an
appropriate browser environment; mocked success does not certify native hardware.

Please try these with your microphone:

1. New game, play e4 or Nf3, ask why. Expect central control/development plus an
   actual continuation; compare the same FEN/move in text Coach.
2. Knight fork example, play Nf6+, ask if it wins. The queen capture leads to an
   insufficient-material **draw**, not a won game. Ask about an alternative.
3. Checkmate example, play Ra8#. Expect checkmate, with no invented continuation.
4. Stay on the board for several successive questions. Recognition should restart
   after every answer without navigating to another section.
5. Ask a question and immediately move again. The old answer must not play.
6. Interrupt a long answer, mute/unmute, repeat, then End call. Browser capture and
   microphone indicators should clear when the session ends.
7. Disable Coach explanations, then repeat a quiet-move question. Local wording
   should still explain a board change and a legal line.

For a bad explanation, keep the initial FEN, moves played, exact question, whether
AI wording was enabled, the spoken answer and expected correction. That is more
useful for the next research step than adding a larger agent framework blindly.
