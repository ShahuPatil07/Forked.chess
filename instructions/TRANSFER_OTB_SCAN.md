# Transfer guide — ship the OTB Scanner into PawnPrint as the "OTB Scan" section

**Audience:** a Claude Code agent working inside the **PawnPrint** repo
(`C:\Users\Shahu Patil\Desktop\PawnPrint`). You have filesystem access to the
standalone scanner repo at:

```
C:\Users\Shahu Patil\Desktop\OTB-Scanner        # SOURCE (read from here)
C:\Users\Shahu Patil\Desktop\PawnPrint\frontend  # TARGET (frontend)
C:\Users\Shahu Patil\Desktop\PawnPrint\backend   # TARGET (backend — mostly done)
```

Goal: add a new product section **"OTB Scan"** to PawnPrint — a route under the
existing `AppShell` sidebar that lets a user digitise an over-the-board game two
ways (live phone-camera tracking, or scoresheet photo → OCR), then hands the
recorded game to PawnPrint's existing **Analysis Board** for move-by-move review.

The scanner was built against PawnPrint's design system from day one (same
Tailwind tokens, `.card`/`.btn-*`/`.input`/`.badge` classes, Inter, framer-motion,
lucide-react, the gradient **Forked** wordmark), so it drops in visually with no
restyling.

---

## 0. What is ALREADY done (do not redo)

- **Backend OCR endpoint is already merged** into PawnPrint:
  - `backend/scoresheet.py` — `POST /api/ocr/scoresheet` (router already included
    in `backend/main.py`).
  - `backend/scoresheet_parser.py` — grid + legality-constrained parser.
  - `requirements.txt` already has `python-multipart` + `pytesseract`.
  - **Verify only:** confirm `backend/main.py` still has
    `from backend.scoresheet import router as scoresheet_router; app.include_router(scoresheet_router)`.
- **The Vite dev proxy already routes `/api/*` to the FastAPI backend**, so the
  frontend OCR call (`/api/ocr/scoresheet`) works with no proxy changes.

### Backend env (in PawnPrint root `.env`) — OCR engine selection

The scanner's OCR is engine-pluggable (priority: Vision-LLM → Google Vision →
Tesseract). The user is shipping with **Qwen2.5-VL via local Ollama** (free,
offline). Ensure the root `.env` has:

```
VLM_OCR_BASE=http://localhost:11434/v1
VLM_OCR_MODEL=qwen2.5vl:7b
# optional tuning: VLM_OCR_MAX_EDGE=1500  VLM_OCR_TIMEOUT=600  VLM_OCR_KEEP_ALIVE=30m
# OpenRouter alt: VLM_OCR_BASE=https://openrouter.ai/api/v1 + VLM_OCR_MODEL=... + VLM_OCR_KEY=sk-or-...
```

Requires Ollama running with the model pulled (`ollama pull qwen2.5vl:7b`). No
backend code changes are needed here — this is operational config only.

---

## 1. Frontend dependencies to add

PawnPrint's `frontend/package.json` already has `chess.js`, `react-chessboard`,
`framer-motion`, `lucide-react`. Add only the CV/geometry deps the scanner needs:

```powershell
cd "C:\Users\Shahu Patil\Desktop\PawnPrint\frontend"
npm install @tensorflow/tfjs-core@^4.22.0 @tensorflow/tfjs-backend-webgl@^4.22.0 @tensorflow/tfjs-converter@^4.22.0 chessops@^0.15.0 delaunator@^5.0.1 vectorious@^6.1.14
npm install -D @types/delaunator@^5.0.3
```

> **chess.js + chessops coexist intentionally.** The OTB feature's game engine is
> built on `chessops` (ported verbatim from CameraChessWeb); PawnPrint's analysis
> code uses `chess.js`. Both stay. The hand-off to the Analysis Board (Step 6)
> uses `chess.js`, which PawnPrint already has.

---

## 2. Copy the TFJS model files (~8 MB)

```powershell
$src = "C:\Users\Shahu Patil\Desktop\OTB-Scanner\public\models"
$dst = "C:\Users\Shahu Patil\Desktop\PawnPrint\frontend\public\models"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "$src\480M_pieces_float16" $dst -Recurse -Force
Copy-Item "$src\480L_xcorners_float16" $dst -Recurse -Force
```

The loader references `/models/480M_pieces_float16/model.json` and
`/models/480L_xcorners_float16/model.json` — Vite serves `public/` at the web
root, so these paths work unchanged. (PawnPrint already has `/logo.png`,
`/logo-knight-cutout.png`, which the scanner UI also uses.)

---

## 3. Copy the feature source (preserve structure)

Copy these seven subtrees from `OTB-Scanner/src/` into a single self-contained
feature folder so **every internal relative import keeps working unchanged**:

```powershell
$src = "C:\Users\Shahu Patil\Desktop\OTB-Scanner\src"
$dst = "C:\Users\Shahu Patil\Desktop\PawnPrint\frontend\src\features\otb-scan"
New-Item -ItemType Directory -Force $dst | Out-Null
foreach ($d in "cv","game","components","hooks","screens","ui","api") {
  Copy-Item "$src\$d" $dst -Recurse -Force
}
```

Resulting layout: `frontend/src/features/otb-scan/{cv,game,components,hooks,screens,ui,api}/`.

**Do NOT copy** these scanner-only files (they're app-shell/build glue, replaced
by PawnPrint's): `src/App.tsx`, `src/main.tsx`, `src/index.css`,
`src/vite-env.d.ts`, `index.html`, `vite.config.ts`, `tailwind.config.js`,
`postcss.config.js`.

### File inventory (for reference / verification)

| Folder | Files |
| --- | --- |
| `cv/` | `constants.ts`, `math.ts`, `models.ts`, `detect.ts`, `pieceDetector.ts`, `cornerDetector.ts`, `warp.ts`, `boardMapper.ts`, `stabilityDetector.ts` |
| `game/` | `types.ts`, `board.ts`, `moves.ts`, `moveInference.ts`, `gameTracker.ts` |
| `components/` | `CameraFeed.tsx`, `CornerOverlay.tsx`, `BoardDisplay.tsx`, `CorrectionModal.tsx`, `MoveHistory.tsx` |
| `hooks/` | `useCamera.ts`, `useGameTracker.ts`, `useOCR.ts` |
| `screens/` | `Home.tsx`, `Setup.tsx`, `Calibration.tsx`, `LiveGame.tsx`, `GameFinished.tsx`, `ScoresheetUpload.tsx`, `MoveReview.tsx` |
| `ui/` | `Brand.tsx`, `SectionHeader.tsx` (self-contained duplicates of PawnPrint's — keep inside the feature to avoid import churn; dedupe later if desired) |
| `api/` | `ocr.ts`, `forked.ts` |

> The `ui/Brand.tsx` and `ui/SectionHeader.tsx` are byte-compatible re-creations of
> PawnPrint's `components/layout/AppShell.tsx` `ForkedWordmark` and
> `components/layout/SectionHeader.tsx`. Keeping the feature's copies makes the
> port self-contained and risk-free. Optional follow-up: delete them and re-point
> the feature's imports at PawnPrint's versions.

### CSS / Tailwind — nothing to do

The scanner's `index.css` component classes (`.card`, `.btn-primary`,
`.btn-ghost`, `.btn-danger`, `.input`, `.badge`) and all color tokens already
exist in PawnPrint's `frontend/src/index.css` and `tailwind.config.js`
(identical). Do not copy the scanner's CSS or Tailwind config.

---

## 4. Vite env types

The feature reads two optional env vars (`api/ocr.ts`, `api/forked.ts`). Add them
to PawnPrint's `frontend/src/vite-env.d.ts` so TypeScript is happy (both are
optional and default to `/api`):

```ts
interface ImportMetaEnv {
  // ...existing keys...
  readonly VITE_FORKED_APP_URL?: string
  readonly VITE_FORKED_API_URL?: string
}
```

`api/ocr.ts` defaults its base to `/api`, which is exactly PawnPrint's proxied
backend — so OCR works with no `.env` frontend changes.

---

## 5. Create the section page

Create `frontend/src/features/otb-scan/OTBScanPage.tsx`. This is the scanner's
old `App.tsx` adapted for embedding: **no** outer `min-h-screen`, **no**
`ChessBackground`/`BrandBar` (AppShell provides those), **no** dev preview bar,
and an `onAnalyse` hand-off into PawnPrint's Analysis Board (Step 6).

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCamera } from './hooks/useCamera'
import { useGameTracker } from './hooks/useGameTracker'
import { useOCR } from './hooks/useOCR'
import { Home } from './screens/Home'
import { Setup } from './screens/Setup'
import { Calibration } from './screens/Calibration'
import { LiveGame } from './screens/LiveGame'
import { GameFinished } from './screens/GameFinished'
import { ScoresheetUpload } from './screens/ScoresheetUpload'
import { MoveReview } from './screens/MoveReview'
import { gameToPositions } from './analysisHandoff'
import type { TrackerUpdate } from './game/types'

type Mode = 'choose' | 'live' | 'scoresheet'

export default function OTBScanPage() {
  const navigate = useNavigate()
  const camera = useCamera()
  const gt = useGameTracker(camera.videoRef)
  const ocr = useOCR()
  const [mode, setMode] = useState<Mode>('choose')
  const [pgn, setPgn] = useState('')
  const [sheet, setSheet] = useState<{ pgn: string; moves: string[] } | null>(null)

  const onStart = () => { camera.start(); gt.startCalibration() }
  const onFinish = () => setPgn(gt.finishGame())
  const goHome = () => {
    gt.reset(); camera.stop(); ocr.reset(); setPgn(''); setSheet(null); setMode('choose')
  }

  // Hand the recorded game to PawnPrint's Analysis Board (move-by-move nav).
  const analyse = (movesSan: string[]) => {
    const positions = gameToPositions(movesSan)
    navigate('/analysis', { state: { positions, index: positions.length - 1, title: 'OTB game' } })
  }

  return (
    <div className="px-4 py-6 sm:px-8">
      {mode === 'choose' && (
        <Home onPickLive={() => setMode('live')} onPickScoresheet={() => setMode('scoresheet')} />
      )}

      {mode === 'live' && <LiveFlow {...{ camera, gt, pgn, onStart, onFinish, goHome, onAnalyse: analyse }} />}

      {mode === 'scoresheet' && (
        sheet ? (
          <GameFinished pgn={sheet.pgn} moves={sheet.moves} onNewGame={goHome}
            onAnalyse={() => analyse(sheet.moves)} />
        ) : ocr.state === 'review' && ocr.result ? (
          <MoveReview result={ocr.result} onBack={ocr.reset}
            onConfirm={(p, moves) => setSheet({ pgn: p, moves })} />
        ) : (
          <ScoresheetUpload onAnalyse={ocr.analyseScoresheet} onBack={goHome}
            processing={ocr.state === 'processing'} error={ocr.error}
            onLoadSample={import.meta.env.DEV ? ocr.loadSample : undefined} />
        )
      )}
    </div>
  )
}

function LiveFlow({
  camera, gt, pgn, onStart, onFinish, goHome, onAnalyse,
}: {
  camera: ReturnType<typeof useCamera>
  gt: ReturnType<typeof useGameTracker>
  pgn: string
  onStart: () => void
  onFinish: () => void
  goHome: () => void
  onAnalyse: (moves: string[]) => void
}) {
  const view: TrackerUpdate['state'] = gt.update.state
  return (
    <>
      {view === 'idle' && (
        <Setup onStart={onStart} modelsReady={gt.modelsReady}
          modelError={gt.modelError} cameraError={camera.error} onBack={goHome} />
      )}
      {view === 'calibrating' && (
        <Calibration videoRef={camera.videoRef} stream={camera.stream} tracker={gt.tracker}
          update={gt.update} onConfirm={gt.confirmStartPosition} onBack={goHome} />
      )}
      {(view === 'playing' || view === 'correction_needed') && (
        <LiveGame videoRef={camera.videoRef} stream={camera.stream} tracker={gt.tracker}
          update={gt.update} onCorrect={gt.correctMove} onDismiss={gt.dismissCorrection}
          onResync={gt.resync} onFinish={onFinish} />
      )}
      {view === 'finished' && (
        <GameFinished pgn={pgn} moves={gt.update.moves} onNewGame={goHome}
          onAnalyse={() => onAnalyse(gt.update.moves)} />
      )}
    </>
  )
}
```

---

## 6. Hand-off into the Analysis Board (no AnalysisBoard changes needed)

`pages/AnalysisBoard.tsx` already renders move-by-move navigation from
`location.state.positions` (`NavPosition[] = { fen, label, ... }`). So convert the
recorded game's SAN list into positions and navigate there.

Create `frontend/src/features/otb-scan/analysisHandoff.ts`:

```ts
import { Chess } from 'chess.js'

export interface NavPosition { fen: string; label: string }

/** Walk the SAN move list, producing one position per ply for the Analysis Board. */
export function gameToPositions(movesSan: string[]): NavPosition[] {
  const game = new Chess()
  const positions: NavPosition[] = [{ fen: game.fen(), label: 'Start' }]
  movesSan.forEach((san, i) => {
    try {
      game.move(san)
    } catch {
      return // skip anything chess.js can't apply (shouldn't happen — moves are validated)
    }
    const moveNo = Math.floor(i / 2) + 1
    positions.push({ fen: game.fen(), label: i % 2 === 0 ? `${moveNo}. ${san}` : `${moveNo}... ${san}` })
  })
  return positions
}
```

### Edit `GameFinished.tsx` to accept an `onAnalyse` callback

The scanner's `GameFinished` currently calls the external `analyseWithForked`
(opens `forked.chess` in a new tab). Inside PawnPrint, prefer in-app navigation.
Add an optional prop and use it when present:

```tsx
// in features/otb-scan/screens/GameFinished.tsx
interface Props {
  pgn: string
  moves: string[]
  onNewGame: () => void
  onAnalyse?: () => void   // NEW
}

// ...in the analyse handler, replace the analyseWithForked call with:
const analyse = async () => {
  if (onAnalyse) { onAnalyse(); return }
  // fallback (standalone): existing analyseWithForked(pgn, token) path
}
```

`api/forked.ts` can stay as the standalone fallback, or be deleted once
`onAnalyse` is always supplied. Either is fine.

---

## 7. Wire the route + sidebar nav (lazy-loaded)

**Lazy-load the route** — the TFJS runtime is ~1.6 MB and must not bloat the main
bundle. Only users who open OTB Scan should download it.

In `frontend/src/App.tsx`:

```tsx
import { lazy, Suspense } from 'react'
const OTBScanPage = lazy(() => import('./features/otb-scan/OTBScanPage'))

// inside the AppShell-protected <Route element={<RequireUser><AppShell/></RequireUser>}> group:
<Route path="/otb-scan" element={
  <Suspense fallback={<div className="p-8 text-text-2 text-sm">Loading scanner…</div>}>
    <OTBScanPage />
  </Suspense>
} />
```

In `frontend/src/components/layout/AppShell.tsx`, add a nav entry to the `NAV`
array (import an icon, e.g. `ScanLine`, from `lucide-react`):

```tsx
{ to: '/otb-scan', label: 'OTB Scan', icon: ScanLine },
```

Place it near `Analysis Board` / `History` in the list.

---

## 8. Verify

```powershell
cd "C:\Users\Shahu Patil\Desktop\PawnPrint\frontend"
npx tsc -b --noEmit        # or: npm run build
npm run build
```

Then run the app and check the section end-to-end:

- [ ] `npm install` added the 6 deps; `tsc`/`build` pass.
- [ ] `frontend/public/models/` has both `*_float16/model.json` + `.bin`.
- [ ] Sidebar shows **OTB Scan**; clicking it lazy-loads the section (network tab
      shows the tfjs chunk only on first visit).
- [ ] **Scoresheet flow:** with the backend running (`uvicorn backend.main:app
      --reload --port 8000`) + Ollama up, upload a scoresheet → review screen
      shows detected moves → *Confirm and analyse* lands on `/analysis` with the
      game loaded and steppable.
- [ ] **Live flow (needs HTTPS or localhost + a camera):** Start game →
      Calibration shows the corner overlay + confidence meter → Confirm →
      LiveGame board tracks → Finish → Analyse opens `/analysis`.
- [ ] No regressions in existing PawnPrint sections.

---

## 9. Gotchas & notes

- **Camera requires a secure context.** `getUserMedia` only works on
  `https://` or `localhost`. Fine in dev on localhost; for LAN/phone testing the
  PawnPrint dev server needs HTTPS (e.g. `@vitejs/plugin-basic-ssl`) or a tunnel.
  The scoresheet flow has no such requirement.
- **No CORS issue.** OCR is same-origin via the existing `/api` proxy. (The
  standalone scanner's CORS notes don't apply here.)
- **Bundle size warning** from Vite about a >500 kB chunk is expected (tfjs);
  the lazy route keeps it out of the initial load. Optionally add
  `build.rollupOptions.output.manualChunks` to split tfjs, but it's not required.
- **PWA / offline model caching is NOT ported.** The standalone scanner precached
  the models via `vite-plugin-pwa`. PawnPrint can skip this — the browser caches
  the model files via normal HTTP caching after first load. (Optional future:
  add a service-worker runtime cache for `/models/*`.)
- **`useGameTracker` loads the models on mount** of the section. Because the route
  is lazy, that only happens when the user opens OTB Scan — good. The first
  inference also warms the WebGL backend.
- **Dev-only "Load sample review"** button (scoresheet upload) is gated on
  `import.meta.env.DEV` and disappears in production builds — leave it.
- **Reference docs:** the scanner's `README.md` documents the exact CV pipeline
  and OCR architecture if you need to understand internals while wiring this up.

---

## 10. Optional cleanups (after it works)

- Dedupe `features/otb-scan/ui/Brand.tsx` + `ui/SectionHeader.tsx` against
  PawnPrint's `components/layout/AppShell.tsx` (`ForkedWordmark`) and
  `components/layout/SectionHeader.tsx`; re-point the feature's imports and delete
  the duplicates.
- Delete `features/otb-scan/api/forked.ts` once `onAnalyse` fully replaces the
  external hand-off.
- Add a `manualChunks` split for `@tensorflow/*` if you want a cleaner build
  report.
