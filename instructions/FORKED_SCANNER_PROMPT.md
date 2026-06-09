# Claude Code prompt — Forked OTB Scanner

## What this repo is

A React PWA that uses CameraChessWeb's pre-trained ONNX models to track
a live OTB chess game from a phone camera, reconstruct the PGN, and send
it to the Forked backend for blindspot analysis.

Repo name: forked-scanner

The CV heavy lifting (board corner detection + piece recognition) is done
by two pre-trained LeYOLO ONNX models from CameraChessWeb. Do not retrain
these models. Download and use them directly.

Model files (download to `public/models/`):
- `480L_leyolo_xcorners.onnx` — board corner detection
  https://drive.google.com/file/d/...  (from Pbatch/CameraChessWeb README)
- `480M_leyolo_pieces.onnx` — piece detection + classification
  https://drive.google.com/file/d/...  (from Pbatch/CameraChessWeb README)

Study the CameraChessWeb repo (github.com/Pbatch/CameraChessWeb) carefully
before writing any code. Understand:
- How they load and run the ONNX models in the browser
- How they map piece detections to board squares
- How they handle the perspective transform
- What the model output format is (bounding boxes + class labels)

Reuse their inference code as directly as possible. The goal is to wrap
their CV pipeline with Forked's game tracking logic and backend integration,
not to rebuild what they've already solved.

---

## Tech stack

- React + TypeScript + Vite
- ONNX Runtime Web (runs LeYOLO models in browser via WebAssembly)
- chess.js (move validation + PGN generation)
- react-chessboard (board display)
- Tailwind CSS
- Web Camera API
- No Python backend — all CV runs client-side

---

## Architecture

```
Phone camera (MediaDevices API, 5fps)
        ↓
Frame stability check
(skip frames with motion — hands mid-move)
        ↓
480L_leyolo_xcorners.onnx → 4 board corners
        ↓
Perspective transform → normalised board view
        ↓
480M_leyolo_pieces.onnx → piece bounding boxes + class labels
        ↓
Map detections to 64 squares (IoU assignment)
→ board state dict {square: piece}
        ↓
Diff vs previous stable state → candidate move
        ↓
chess.js legal move validation
        ↓
PGN accumulation
        ↓
POST to Forked backend on game end
```

---

## Core modules

### `src/cv/cornerDetector.ts`

Loads `480L_leyolo_xcorners.onnx` via ONNX Runtime Web.
Runs inference on a video frame.
Returns 4 corner points as `[x, y][]` in order:
top-left, top-right, bottom-right, bottom-left.
Returns null if confidence below threshold (0.7).

Study how CameraChessWeb handles this — replicate their preprocessing
(resize to 480×480, normalise to 0-1, CHW format) and postprocessing
(NMS, confidence filtering, corner ordering).

### `src/cv/pieceDetector.ts`

Loads `480M_leyolo_pieces.onnx` via ONNX Runtime Web.
Input: warped board image (after perspective transform).
Returns: list of `{ bbox: [x1,y1,x2,y2], class: string, confidence: number }`

Class labels from CameraChessWeb's training data:
wK, wQ, wR, wB, wN, wP, bK, bQ, bR, bB, bN, bP
(white/black + King/Queen/Rook/Bishop/Knight/Pawn)

### `src/cv/boardMapper.ts`

Takes piece detections + known square grid coordinates
(derived from the perspective transform).
Assigns each detection to a square using IoU or centroid distance.
Returns: `Record<string, string>` mapping square name → piece string.
e.g. `{ a1: 'wR', e1: 'wK', e8: 'bK', ... }`

### `src/cv/perspectiveTransform.ts`

Given 4 corner points, computes the homography matrix.
Warps input frame to a 480×480 frontal view of the board.
Also computes the 64 square bounding boxes in the warped space
(simple 8×8 grid division after warp).

### `src/cv/stabilityDetector.ts`

Frame differencing within the board region.
Returns true if no significant motion for 1.5 seconds.
Only run piece detection on stable frames.
Threshold: <2% pixels changed in board region.

### `src/game/moveInference.ts`

Compares current board state to previous board state.
Finds changed squares and infers the move:

```
Normal move: piece on src disappears, appears on dst
Capture: piece on src disappears, different piece on dst
Castling: king + rook both moved simultaneously
En passant: pawn moved diagonally, opponent pawn disappeared
Promotion: pawn on 7th rank moves to 8th, becomes queen/other
```

Returns: chess.Move | null
Null if: no change detected, change doesn't match any legal move pattern,
or multiple legal moves match (ambiguous — needs user correction).

Uses chess.js to validate: `chess.moves({ verbose: true })` to get all
legal moves, filter to those matching the detected change.

### `src/game/gameTracker.ts`

Main orchestrator. Combines all CV + game modules.

State machine:
```
idle → calibrating → playing → correction_needed → finished
```

Public interface:
```typescript
interface GameTracker {
  processFrame(frame: ImageData): TrackerUpdate
  confirmStartPosition(): void
  correctMove(uci: string): void
  finishGame(): string  // returns PGN
  reset(): void
}

interface TrackerUpdate {
  state: 'idle' | 'calibrating' | 'playing' | 'correction_needed' | 'finished'
  fen: string
  moves: string[]
  lastMove: string | null
  correctionOptions: string[]
  cornersDetected: boolean
  cornerConfidence: number
}
```

---

## Screens

### Screen 1 — Setup

Instructions with a diagram showing the optimal phone angle (30-45°).
"Start game" button.
Brief: "No login needed. Results go to your Forked profile."

### Screen 2 — Calibration

Live camera feed.
Corner overlay: 4 dots showing detected corners.
Confidence indicator: green (>0.85) / yellow (0.7-0.85) / red (<0.7).
"Board detected ✓" badge when confidence is good.
"Confirm starting position" button — active only when confidence >0.7.
Pressing it locks the board position and starts tracking.

### Screen 3 — Live tracking

Top half: camera preview with corner overlay (corners locked from calibration).
Bottom half: react-chessboard showing current tracked position.
Move counter and last move badge.
"Correction needed" modal when ambiguous move detected — shows 2-3
candidate moves as buttons, user taps the correct one.
"Resync" button — re-reads the full board position from current frame.
"Finish game" button.

### Screen 4 — Game finished

Full PGN text (selectable, copyable).
"Copy PGN" button.
"Analyse with Forked →" button — opens Forked main app.
  Link: `https://forked.chess/analyse?pgn={url_encoded_pgn}`
  Also try: `forked://analyse?pgn=...` for native deep link if installed.
"New game" button.

---

## Camera frame loop

```typescript
const processLoop = async (
  videoEl: HTMLVideoElement,
  tracker: GameTracker,
  onUpdate: (update: TrackerUpdate) => void
) => {
  const canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 480
  const ctx = canvas.getContext('2d')!

  const tick = async () => {
    ctx.drawImage(videoEl, 0, 0, 480, 480)
    const imageData = ctx.getImageData(0, 0, 480, 480)
    const update = await tracker.processFrame(imageData)
    onUpdate(update)
    requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
}
```

Process every frame via requestAnimationFrame but skip piece detection
if stability detector says the frame is unstable. Corner detection
runs every frame (cheap) to keep the overlay responsive.

---

## ONNX Runtime Web setup

```typescript
import * as ort from 'onnxruntime-web'

// Load once, reuse across frames
const cornerSession = await ort.InferenceSession.create(
  '/models/480L_leyolo_xcorners.onnx',
  { executionProviders: ['wasm'] }
)

const pieceSession = await ort.InferenceSession.create(
  '/models/480M_leyolo_pieces.onnx',
  { executionProviders: ['wasm'] }
)
```

Use `executionProviders: ['webgl', 'wasm']` if WebGL is available for
faster inference. Fall back to wasm only.

The models run at ~100-300ms per frame on a mid-range phone with wasm.
This is fine — stability detector naturally limits piece detection to
once every ~1.5 seconds anyway (only on stable frames).

---

## Error recovery

**Ambiguous move (2+ legal moves match):**
Show correction modal with candidate moves as buttons.
User taps the correct one. Move is pushed to PGN.

**Illegal position detected:**
Board state diff doesn't match any legal move.
Show "I missed a move" banner.
User inputs the move manually by tapping src then dst square on the board.

**Board drifted (position looks wrong):**
"Resync" button → re-reads full board state from current frame.
Validates the re-read position is reachable from the current PGN.
If valid: update state and continue.
If invalid: show manual correction option.

---

## Backend integration

When game finishes, POST to Forked main API:

```typescript
const analyseWithForked = async (pgn: string, userToken: string | null) => {
  if (userToken) {
    // Authenticated: full pipeline + blindspot debrief
    await fetch('https://forked.chess/api/analysis/import-pgn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({
        pgn,
        source: 'otb_scanner',
        platform: 'otb'
      })
    })
    window.location.href = 'https://forked.chess/dashboard'
  } else {
    // No auth: open analyse page with PGN in URL
    const encoded = encodeURIComponent(pgn)
    window.open(`https://forked.chess/analyse?pgn=${encoded}`, '_blank')
  }
}
```

The main Forked repo must accept `?pgn=` on the `/analyse` route —
add that if not already present.

---

## PWA config

`public/manifest.json`:
```json
{
  "name": "Forked Scanner",
  "short_name": "Forked",
  "description": "Record OTB chess games — analyse with Forked",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f0f14",
  "theme_color": "#7c6af7",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Service worker: cache the app shell + ONNX model files on first load.
Models are ~30-50MB — cache them so the app works without re-downloading.
Use Workbox for service worker generation via vite-plugin-pwa.

---

## Project structure

```
forked-scanner/
├── public/
│   ├── models/
│   │   ├── 480L_leyolo_xcorners.onnx
│   │   └── 480M_leyolo_pieces.onnx
│   ├── manifest.json
│   └── icons/
├── src/
│   ├── cv/
│   │   ├── cornerDetector.ts
│   │   ├── pieceDetector.ts
│   │   ├── boardMapper.ts
│   │   ├── perspectiveTransform.ts
│   │   └── stabilityDetector.ts
│   ├── game/
│   │   ├── moveInference.ts
│   │   └── gameTracker.ts
│   ├── screens/
│   │   ├── Setup.tsx
│   │   ├── Calibration.tsx
│   │   ├── LiveGame.tsx
│   │   └── GameFinished.tsx
│   ├── components/
│   │   ├── CameraFeed.tsx
│   │   ├── CornerOverlay.tsx   (SVG overlay showing corner dots)
│   │   ├── BoardDisplay.tsx    (react-chessboard wrapper)
│   │   ├── CorrectionModal.tsx
│   │   └── MoveHistory.tsx
│   ├── hooks/
│   │   ├── useCamera.ts        (MediaDevices API)
│   │   └── useGameTracker.ts   (GameTracker state + React bridge)
│   └── App.tsx
├── package.json
└── vite.config.ts              (include vite-plugin-pwa)
```

---

## Build order

1. Download both ONNX models, place in `public/models/`
2. Study CameraChessWeb source to understand model I/O format
3. `src/cv/cornerDetector.ts` — load model, test on a static image
4. `src/cv/perspectiveTransform.ts` — warp a frame to frontal view
5. `src/cv/pieceDetector.ts` — load model, test piece detection
6. `src/cv/boardMapper.ts` — map detections to squares
7. `src/cv/stabilityDetector.ts` — frame diff
8. `src/game/moveInference.ts` — diff two board states → move
9. `src/game/gameTracker.ts` — state machine connecting everything
10. Screens: Setup → Calibration → LiveGame → GameFinished
11. PWA: manifest + service worker + model caching
12. End-to-end test: play a 10-move game, verify >80% moves detected

---

## Definition of done

- [ ] Both ONNX models load in browser without errors
- [ ] Corner detection draws 4 dots on a real chessboard photo
- [ ] Perspective transform produces a clean frontal board view
- [ ] Piece detection correctly identifies pieces on the warped image
- [ ] Board mapper assigns pieces to correct squares
- [ ] Move inference correctly detects: normal moves, captures, castling
- [ ] chess.js validation catches illegal move detections
- [ ] Stability detector ignores frames with hand motion
- [ ] Calibration screen shows live corner overlay with confidence
- [ ] Live game screen shows board updating after each move
- [ ] Correction modal appears and works for ambiguous moves
- [ ] Resync re-reads board from current frame
- [ ] Game finished screen shows PGN + Analyse with Forked button
- [ ] PWA installs on Android Chrome home screen
- [ ] ONNX models cached by service worker
- [ ] End-to-end: 10-move test game, >8/10 moves correct
