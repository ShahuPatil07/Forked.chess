import { useCallback, useEffect, useRef, useState } from 'react'

export interface CameraState {
  videoRef: React.RefObject<HTMLVideoElement>
  stream: MediaStream | null
  error: string | null
  start: () => Promise<void>
  stop: () => void
}

// Rear-facing camera at a sensible resolution. Mirrors CameraChessWeb's
// MEDIA_CONSTRAINTS (environment camera, 16:9).
const CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
}

export function useCamera(): CameraState {
  // A single video element ref, shared by whichever CameraFeed is mounted.
  const videoRef = useRef<HTMLVideoElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)

  const stop = useCallback(() => {
    setStream((s) => {
      s?.getTracks().forEach((t) => t.stop())
      return null
    })
  }, [])

  const start = useCallback(async () => {
    setError(null)
    try {
      const s = await navigator.mediaDevices.getUserMedia(CONSTRAINTS)
      setStream(s)
    } catch (e) {
      setError(e instanceof Error ? `Camera unavailable: ${e.message}` : 'Camera unavailable')
    }
  }, [])

  // Stop tracks on unmount.
  useEffect(() => {
    return () => {
      setStream((s) => {
        s?.getTracks().forEach((t) => t.stop())
        return null
      })
    }
  }, [])

  return { videoRef, stream, error, start, stop }
}
