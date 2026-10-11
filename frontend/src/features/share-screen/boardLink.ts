import { useEffect, useRef, useState } from 'react'
import type { Chess } from 'chess.js'

export const SETTLE_MS = 2500
export const STALE_MS = 5500
export const channelName = (session: string) => `forked-live:${session}`
export const validSession = (value: string | null): value is string => !!value && /^[a-f0-9-]{36}$/i.test(value)

export interface BoardSnapshot {
  type: 'board'
  boardId: string
  fen: string
  beforeFen: string | null
  lastMove: string | null
}
export interface CaptureTrack extends MediaStreamTrack {
  getCaptureHandle?: () => { handle: string; origin?: string } | null
}
type CaptureDevices = MediaDevices & {
  setCaptureHandleConfig?: (config: { handle?: string; exposeOrigin?: boolean; permittedOrigins?: string[] }) => void
}
export function capturedBoardId(track: CaptureTrack | undefined, session: string, requireFrames = true): string | null {
  if (!track || track.readyState !== 'live' || (requireFrames && track.muted)) return null
  const handle = track.getCaptureHandle?.()
  const prefix = `forked:${session}:`
  return handle?.origin === window.location.origin && handle.handle.startsWith(prefix)
    ? handle.handle.slice(prefix.length) : null
}
export const snapshotKey = (board: BoardSnapshot) => `${board.boardId}|${board.fen}|${board.beforeFen}|${board.lastMove}`

/** Only explicitly linked board tabs publish. No localStorage or global board channel. */
export function useBoardPublisher(session: string | null, chess: Chess, fen: string) {
  const boardId = useRef(crypto.randomUUID())
  const current = useRef<BoardSnapshot | null>(null)
  const history = chess.history({ verbose: true })
  const last = history[history.length - 1]
  current.current = { type: 'board', boardId: boardId.current, fen,
    beforeFen: last?.before ?? null, lastMove: last ? last.from + last.to + (last.promotion ?? '') : null }
  const channel = useRef<BroadcastChannel | null>(null)
  const [status, setStatus] = useState('Return to Share Screen and select this tab in the sharing picker.')
  useEffect(() => {
    if (!validSession(session) || !('BroadcastChannel' in window)) return
    const devices = navigator.mediaDevices as CaptureDevices | undefined
    try {
      devices?.setCaptureHandleConfig?.({ handle: `forked:${session}:${boardId.current}`,
        exposeOrigin: true, permittedOrigins: [window.location.origin] })
    } catch { setStatus('This browser cannot link a shared tab. Try desktop Chrome.') }
    const bc = new BroadcastChannel(channelName(session))
    channel.current = bc
    let lastStatus = 0
    bc.onmessage = ({ data }) => {
      if (data?.type === 'poll') bc.postMessage(current.current)
      if (data?.type === 'status') { lastStatus = Date.now(); setStatus(data.label) }
    }
    bc.postMessage(current.current)
    const timer = window.setInterval(() => {
      bc.postMessage(current.current)
      if (lastStatus && Date.now() - lastStatus > STALE_MS) {
        setStatus('Coach disconnected. Return to Share Screen to reconnect.')
      }
    }, 750)
    const oldTitle = document.title
    document.title = 'Forked • Board for live coach'
    return () => {
      bc.postMessage({ type: 'board-closed', boardId: boardId.current })
      clearInterval(timer); bc.close(); channel.current = null
      devices?.setCaptureHandleConfig?.({ permittedOrigins: [] })
      document.title = oldTitle
    }
  }, [session])
  useEffect(() => { channel.current?.postMessage(current.current) }, [fen])
  const interrupt = () => channel.current?.postMessage({ type: 'interrupt', boardId: boardId.current })
  return { linked: validSession(session), status, interrupt }
}
