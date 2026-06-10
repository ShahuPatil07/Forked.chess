import { useEffect } from 'react'
import type { GameTracker } from '../game/gameTracker'
import { CornerOverlay } from './CornerOverlay'

interface Props {
  videoRef: React.RefObject<HTMLVideoElement>
  stream: MediaStream | null
  tracker: GameTracker
  /** Alternative source: an uploaded video file (object URL). Used by the
   *  "upload a video" flow — the tracker reads frames from the same element. */
  srcUrl?: string | null
  showOverlay?: boolean
  className?: string
}

// The video preview with the corner overlay on top. Binds either a live camera
// MediaStream (record flow) or an object-URL video file (upload flow); the
// tracker's inference loop reads frames from the element either way.
export function CameraFeed({
  videoRef,
  stream,
  tracker,
  srcUrl = null,
  showOverlay = true,
  className = '',
}: Props) {
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (stream) {
      if (video.srcObject !== stream) {
        video.srcObject = stream
        video.play().catch(() => {})
      }
    } else if (srcUrl) {
      // Bind the file once per URL; playback is controlled by the parent flow.
      if (video.getAttribute('data-srcurl') !== srcUrl) {
        video.srcObject = null
        video.src = srcUrl
        video.setAttribute('data-srcurl', srcUrl)
        video.load()
      }
    }
  }, [stream, srcUrl, videoRef])

  return (
    <div className={`relative overflow-hidden rounded-lg bg-black ${className}`}>
      <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
      {showOverlay && <CornerOverlay tracker={tracker} videoRef={videoRef} />}
    </div>
  )
}
