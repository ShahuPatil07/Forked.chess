import { useCallback, useEffect, useRef, useState } from 'react'
import { GameTracker } from '../game/gameTracker'
import type { TrackerUpdate } from '../game/types'

// Target inference cadence. The stability gate naturally limits piece
// detection further, but this caps how often we touch the GPU.
const PROCESS_INTERVAL_MS = 120
// Small frame used purely for the motion / stability check.
const MOTION_W = 192
const MOTION_H = 108

export interface UseGameTracker {
  tracker: GameTracker
  update: TrackerUpdate
  modelsReady: boolean
  modelError: string | null
  startCalibration: () => void
  confirmStartPosition: () => boolean
  correctMove: (move: string) => boolean
  dismissCorrection: () => void
  resync: () => Promise<boolean>
  finishGame: () => string
  reset: () => void
}

export function useGameTracker(
  videoRef: React.RefObject<HTMLVideoElement>,
): UseGameTracker {
  const trackerRef = useRef<GameTracker>()
  if (!trackerRef.current) trackerRef.current = new GameTracker()
  const tracker = trackerRef.current

  const [update, setUpdate] = useState<TrackerUpdate>(() => tracker.snapshot())
  const [modelsReady, setModelsReady] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)

  const motionCanvasRef = useRef<HTMLCanvasElement>()
  if (!motionCanvasRef.current) {
    const c = document.createElement('canvas')
    c.width = MOTION_W
    c.height = MOTION_H
    motionCanvasRef.current = c
  }

  // Load models once.
  useEffect(() => {
    let cancelled = false
    tracker
      .init()
      .then(() => !cancelled && setModelsReady(true))
      .catch((e) => !cancelled && setModelError(e?.message ?? 'Failed to load models'))
    return () => {
      cancelled = true
    }
  }, [tracker])

  // Inference loop. Paced and non-overlapping (each frame awaits the previous).
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let raf = 0

    const tick = async () => {
      if (cancelled) return
      const video = videoRef.current
      const motionCanvas = motionCanvasRef.current!
      if (video && video.readyState >= 2 && tracker.ready) {
        try {
          const mctx = motionCanvas.getContext('2d', { willReadFrequently: true })!
          mctx.drawImage(video, 0, 0, MOTION_W, MOTION_H)
          const motion = mctx.getImageData(0, 0, MOTION_W, MOTION_H)
          const next = await tracker.processFrame(video, motion)
          if (!cancelled) setUpdate(next)
        } catch (e) {
          console.error('processFrame failed', e)
        }
      }
      if (!cancelled) {
        timer = setTimeout(() => {
          raf = requestAnimationFrame(tick)
        }, PROCESS_INTERVAL_MS)
      }
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      clearTimeout(timer)
      cancelAnimationFrame(raf)
    }
  }, [tracker, videoRef])

  const startCalibration = useCallback(() => {
    tracker.startCalibration()
    setUpdate(tracker.snapshot())
  }, [tracker])

  const confirmStartPosition = useCallback(() => {
    const ok = tracker.confirmStartPosition()
    setUpdate(tracker.snapshot())
    return ok
  }, [tracker])

  const correctMove = useCallback(
    (move: string) => {
      const ok = tracker.correctMove(move)
      setUpdate(tracker.snapshot())
      return ok
    },
    [tracker],
  )

  const dismissCorrection = useCallback(() => {
    tracker.dismissCorrection()
    setUpdate(tracker.snapshot())
  }, [tracker])

  const resync = useCallback(async () => {
    const video = videoRef.current
    if (!video) return false
    const changed = await tracker.resync(video)
    setUpdate(tracker.snapshot())
    return changed
  }, [tracker, videoRef])

  const finishGame = useCallback(() => {
    const pgn = tracker.finishGame()
    setUpdate(tracker.snapshot())
    return pgn
  }, [tracker])

  const reset = useCallback(() => {
    tracker.reset()
    setUpdate(tracker.snapshot())
  }, [tracker])

  return {
    tracker,
    update,
    modelsReady,
    modelError,
    startCalibration,
    confirmStartPosition,
    correctMove,
    dismissCorrection,
    resync,
    finishGame,
    reset,
  }
}
