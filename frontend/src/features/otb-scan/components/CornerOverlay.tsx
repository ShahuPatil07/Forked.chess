import { useEffect, useRef } from 'react'
import type { GameTracker } from '../game/gameTracker'

interface Props {
  tracker: GameTracker
  videoRef: React.RefObject<HTMLVideoElement>
}

const CORNER_LABELS = ['h1', 'a1', 'a8', 'h8']

// SVG-free canvas overlay. Runs its own rAF so the dots stay smooth even when
// inference is slow. Reads corner positions straight off the tracker.
export function CornerOverlay({ tracker, videoRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    const draw = () => {
      const canvas = canvasRef.current
      const video = videoRef.current
      if (canvas && video) {
        const w = video.clientWidth
        const h = video.clientHeight
        if (canvas.width !== w) canvas.width = w
        if (canvas.height !== h) canvas.height = h
        const ctx = canvas.getContext('2d')!
        ctx.clearRect(0, 0, w, h)

        // Interior grid intersections (faint) during calibration.
        const xcorners = tracker.displayXCorners(w, h)
        ctx.fillStyle = 'rgba(123,97,255,0.5)'
        for (const [x, y] of xcorners) {
          ctx.beginPath()
          ctx.arc(x, y, 2.5, 0, Math.PI * 2)
          ctx.fill()
        }

        // Board corners (bright) + connecting quad.
        const corners = tracker.displayCorners(w, h)
        if (corners) {
          ctx.strokeStyle = '#7B61FF'
          ctx.lineWidth = 2
          ctx.beginPath()
          corners.forEach(([x, y], i) => {
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          })
          ctx.closePath()
          ctx.stroke()

          corners.forEach(([x, y], i) => {
            ctx.fillStyle = '#7B61FF'
            ctx.beginPath()
            ctx.arc(x, y, 7, 0, Math.PI * 2)
            ctx.fill()
            ctx.fillStyle = '#fff'
            ctx.beginPath()
            ctx.arc(x, y, 3, 0, Math.PI * 2)
            ctx.fill()
            ctx.fillStyle = '#EEEEF2'
            ctx.font = '11px Inter, sans-serif'
            ctx.fillText(CORNER_LABELS[i], x + 9, y - 6)
          })
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [tracker, videoRef])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  )
}
