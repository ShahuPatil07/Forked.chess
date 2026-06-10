import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Film, UploadCloud } from 'lucide-react'
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
import type { TrackerUpdate } from './game/types'

type Mode = 'choose' | 'live' | 'video' | 'scoresheet'

/**
 * OTB Scan — embedded in PawnPrint's AppShell. Three ways to digitise an
 * over-the-board game (record live, upload a video, or scan a scoresheet), then
 * hand the moves to the Analysis Board as one continuous, playable game.
 *
 * (No camera/dev preview bar — that was a standalone-only affordance.)
 */
export default function OTBScanPage() {
  const navigate = useNavigate()
  const camera = useCamera()
  const gt = useGameTracker(camera.videoRef)   // tracker reads camera.videoRef (camera OR uploaded video)
  const ocr = useOCR()
  const [mode, setMode] = useState<Mode>('choose')
  const [pgn, setPgn] = useState('')
  const [sheet, setSheet] = useState<{ pgn: string; moves: string[] } | null>(null)

  // Hand the recorded/scanned game to the Analysis Board as a full playable game.
  const analyse = (movesSan: string[]) => {
    navigate('/analysis', { state: { moves: movesSan, title: 'OTB game' } })
  }

  const goHome = () => {
    gt.reset(); camera.stop(); ocr.reset(); setPgn(''); setSheet(null); setMode('choose')
  }

  return (
    <div className="px-4 py-6 sm:px-8">
      {mode === 'choose' && (
        <Home
          onPickLive={() => setMode('live')}
          onPickVideo={() => setMode('video')}
          onPickScoresheet={() => setMode('scoresheet')}
        />
      )}

      {mode === 'live' && (
        <LiveFlow
          camera={camera} gt={gt} pgn={pgn}
          onStart={() => { camera.start(); gt.startCalibration() }}
          onFinish={() => setPgn(gt.finishGame())}
          goHome={goHome} onAnalyse={analyse}
        />
      )}

      {mode === 'video' && (
        <VideoFlow
          camera={camera} gt={gt} pgn={pgn}
          onFinish={() => setPgn(gt.finishGame())}
          goHome={goHome} onAnalyse={analyse}
        />
      )}

      {mode === 'scoresheet' && (
        sheet ? (
          <GameFinished pgn={sheet.pgn} moves={sheet.moves} onNewGame={goHome}
            onAnalyse={() => analyse(sheet.moves)} />
        ) : ocr.state === 'review' && ocr.result ? (
          <MoveReview result={ocr.result} onBack={ocr.reset}
            onConfirm={(p, moves) => setSheet({ pgn: p, moves })} />
        ) : (
          <ScoresheetUpload onAnalyse={ocr.analyseScoresheet} onBack={goHome}
            processing={ocr.state === 'processing'} error={ocr.error} />
        )
      )}
    </div>
  )
}

// ── Live camera flow ────────────────────────────────────────────────────────────

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

// ── Uploaded-video flow ─────────────────────────────────────────────────────────
// Same CV pipeline as live, sourced from a file: calibrate on the first frame,
// then the video auto-plays through while the tracker records moves.

function VideoFlow({
  camera, gt, pgn, onFinish, goHome, onAnalyse,
}: {
  camera: ReturnType<typeof useCamera>
  gt: ReturnType<typeof useGameTracker>
  pgn: string
  onFinish: () => void
  goHome: () => void
  onAnalyse: (moves: string[]) => void
}) {
  const videoRef = camera.videoRef
  const [url, setUrl] = useState<string | null>(null)
  const view: TrackerUpdate['state'] = gt.update.state

  const pick = (file: File) => {
    setUrl(URL.createObjectURL(file))
    gt.startCalibration()
  }

  // Drive playback off the tracker state: loop the clip during calibration so
  // corner detection always has frames; play straight through while tracking.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !url) return
    if (view === 'calibrating') {
      v.loop = true; v.muted = true
      v.play().catch(() => {})
    } else if (view === 'playing' || view === 'correction_needed') {
      v.loop = false
      v.play().catch(() => {})
    }
  }, [view, url, videoRef])

  // When the clip finishes, the game is done.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !url) return
    if (view !== 'playing' && view !== 'correction_needed') return
    const onEnded = () => onFinish()
    v.addEventListener('ended', onEnded)
    return () => v.removeEventListener('ended', onEnded)
  }, [view, url, videoRef, onFinish])

  // Revoke the object URL on unmount.
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  if (!url) return <VideoUpload onPick={pick} onBack={goHome} ready={gt.modelsReady} modelError={gt.modelError} />

  if (view === 'idle' || view === 'calibrating') {
    return (
      <Calibration videoRef={videoRef} stream={null} srcUrl={url} tracker={gt.tracker}
        update={gt.update} onConfirm={gt.confirmStartPosition} onBack={goHome} />
    )
  }
  if (view === 'playing' || view === 'correction_needed') {
    return (
      <LiveGame videoRef={videoRef} stream={null} srcUrl={url} tracker={gt.tracker}
        update={gt.update} onCorrect={gt.correctMove} onDismiss={gt.dismissCorrection}
        onResync={gt.resync} onFinish={onFinish} />
    )
  }
  return (
    <GameFinished pgn={pgn} moves={gt.update.moves} onNewGame={goHome}
      onAnalyse={() => onAnalyse(gt.update.moves)} />
  )
}

function VideoUpload({
  onPick, onBack, ready, modelError,
}: {
  onPick: (file: File) => void
  onBack: () => void
  ready: boolean
  modelError: string | null
}) {
  return (
    <div className="max-w-xl mx-auto px-4 py-6">
      <button onClick={onBack} className="btn-ghost flex items-center gap-1 mb-3">
        <ChevronLeft size={15} /> Back
      </button>
      <h1 className="text-lg font-bold text-text-0 mb-1">Upload a video</h1>
      <p className="text-xs text-text-2 mb-4">
        A steady recording from a fixed angle, starting from the initial position. We'll
        calibrate on the first frame, then track the moves as it plays.
      </p>

      <label className="card w-full p-6 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-border-hover hover:bg-bg-2 transition-colors text-center">
        <input
          type="file" hidden accept="video/*"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.currentTarget.value = '' }}
        />
        <span className="w-12 h-12 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center">
          <UploadCloud size={22} className="text-accent" />
        </span>
        <span className="text-sm font-semibold text-text-0">Choose a video file</span>
        <span className="text-xs text-text-2">MP4 / MOV / WebM · filmed from a fixed angle</span>
      </label>

      <div className="card p-3 flex items-start gap-2.5 mt-3">
        <Film size={15} className="text-warn flex-shrink-0 mt-0.5" />
        <p className="text-xs text-text-2 leading-relaxed">
          Best results: the camera doesn't move, all four corners stay visible, and the clip
          begins at the standard starting position.
        </p>
      </div>

      {!ready && !modelError && (
        <p className="text-center text-[11px] text-text-2 mt-3">Loading vision models…</p>
      )}
      {modelError && <p className="text-center text-[11px] text-danger mt-3">{modelError}</p>}
    </div>
  )
}
