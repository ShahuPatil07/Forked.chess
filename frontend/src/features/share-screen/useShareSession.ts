import { useCallback, useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import { useLiveVoice } from './useLiveVoice'
import { capturedBoardId, channelName, SETTLE_MS, snapshotKey, STALE_MS } from './boardLink'
import type { BoardSnapshot, CaptureTrack } from './boardLink'

interface Turn { role: 'user' | 'assistant'; content: string }
export function useShareSession() {
  const [session] = useState(() => crypto.randomUUID())
  const [stream, setStream] = useState<MediaStream | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [starting, setStarting] = useState(false)
  const [muted, setMuted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [boardState, setBoardState] = useState('Waiting for the shared board')
  const [error, setError] = useState('')
  const [useLlm, setUseLlm] = useState(true)
  const [hasAnswer, setHasAnswer] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const board = useRef<BoardSnapshot | null>(null)
  const seenAt = useRef(0)
  const changedAt = useRef(0)
  const readyRef = useRef(false)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const busyRef = useRef(false)
  const lastAnswer = useRef('')
  const history = useRef<Turn[]>([])
  const previousTarget = useRef<'current' | 'last_move' | null>(null)
  const pending = useRef<{ question: string; key: string } | null>(null)
  const bcRef = useRef<BroadcastChannel | null>(null)
  const greeted = useRef(false)
  const handler = useRef<(text: string) => void>(() => {})
  const voice = useLiveVoice(!!stream && !muted && !busy, text => handler.current(text))
  const voiceRef = useRef(voice); voiceRef.current = voice
  const settings = useRef({ useLlm }); settings.current = { useLlm }

  const cancelTurn = useCallback(() => {
    generation.current++; request.current?.abort(); request.current = null
    pending.current = null; busyRef.current = false; setBusy(false)
    voiceRef.current.stop()
  }, [])
  const resetBoard = useCallback(() => {
    cancelTurn(); board.current = null; readyRef.current = false; setReady(false)
    history.current = []; previousTarget.current = null
    lastAnswer.current = ''; setHasAnswer(false)
  }, [cancelTurn])

  const end = useCallback(() => {
    resetBoard()
    const captured = streamRef.current; streamRef.current = null
    captured?.getTracks().forEach(track => track.stop())
    setStream(null); setStarting(false); setMuted(false); greeted.current = false
    bcRef.current?.postMessage({ type: 'status', label: 'Call ended. Return to Share Screen to start again.' })
  }, [resetBoard])

  const ask = useCallback(async (question: string) => {
    const snapshot = board.current
    if (!streamRef.current || busyRef.current) return
    if (!snapshot || Date.now() - seenAt.current > STALE_MS) {
      void voiceRef.current.speak('I need the linked Analysis Board first. Share its browser tab, then ask again.'); return
    }
    if (!readyRef.current) { pending.current = { question, key: snapshotKey(snapshot) }; return }
    if (capturedBoardId(streamRef.current.getVideoTracks()[0] as CaptureTrack, session) !== snapshot.boardId) return
    const key = snapshotKey(snapshot)
    const version = ++generation.current
    const controller = new AbortController(); request.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 35000)
    busyRef.current = true; setBusy(true); setError('')
    try {
      const response = await fetch('/api/coach/live-turn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ fen: snapshot.fen, before_fen: snapshot.beforeFen, last_move: snapshot.lastMove,
          question, history: history.current, previous_target: previousTarget.current,
          budget_seconds: 8, use_llm: settings.current.useLlm }),
      })
      if (!response.ok) throw new Error('The coach could not analyze this position. Please try again.')
      const result = await response.json()
      if (version !== generation.current || !board.current || snapshotKey(board.current) !== key ||
          !streamRef.current || Date.now() - seenAt.current > STALE_MS ||
          capturedBoardId(streamRef.current.getVideoTracks()[0] as CaptureTrack, session) !== snapshot.boardId) return
      previousTarget.current = result.target
      history.current = [...history.current, { role: 'user', content: question.slice(0, 2500) } as Turn,
        { role: 'assistant', content: result.speech.slice(0, 2500) } as Turn].slice(-6)
      lastAnswer.current = result.speech; setHasAnswer(true)
      await voiceRef.current.speak(result.speech)
    } catch (failure) {
      if (version !== generation.current) return
      const message = controller.signal.aborted ? 'Analysis took too long. Please ask again.'
        : failure instanceof Error ? failure.message : 'The coach is unavailable. Please try again.'
      setError(message); await voiceRef.current.speak(message)
    } finally {
      clearTimeout(timeout)
      if (version === generation.current) { busyRef.current = false; setBusy(false); request.current = null }
    }
  }, [session])
  handler.current = text => {
    if (/^(repeat|say that again|repeat (?:that|the answer))[.!?]?$/i.test(text.trim()) && lastAnswer.current) {
      void voiceRef.current.speak(lastAnswer.current)
    } else { void ask(text) }
  }

  useEffect(() => {
    if (!('BroadcastChannel' in window)) return
    const bc = new BroadcastChannel(channelName(session)); bcRef.current = bc
    bc.onmessage = ({ data }) => {
      const track = streamRef.current?.getVideoTracks()[0] as CaptureTrack | undefined
      const id = capturedBoardId(track, session)
      if (!id || data?.boardId !== id) return
      if (data.type === 'interrupt') { cancelTurn(); return }
      if (data.type === 'board-closed') { resetBoard(); setBoardState('Board disconnected'); return }
      if (data.type !== 'board' || typeof data.fen !== 'string') return
      try { new Chess(data.fen) } catch { return }
      const snapshot = data as BoardSnapshot
      seenAt.current = Date.now()
      if (!board.current || snapshotKey(snapshot) !== snapshotKey(board.current)) {
        resetBoard(); board.current = snapshot; changedAt.current = Date.now()
        setBoardState('Capturing the position…')
      }
    }
    const timer = window.setInterval(() => {
      if (!streamRef.current) return
      const track = streamRef.current.getVideoTracks()[0] as CaptureTrack
      const id = capturedBoardId(track, session)
      if (!id || (board.current && (board.current.boardId !== id || Date.now() - seenAt.current > STALE_MS))) {
        if (board.current) resetBoard()
        setBoardState(!id ? 'Select the linked Analysis Board tab to continue' : 'Board disconnected — reopen the linked tab')
      } else if (board.current && !readyRef.current && Date.now() - changedAt.current >= SETTLE_MS) {
        readyRef.current = true; setReady(true); setBoardState('Board connected')
        const queued = pending.current; pending.current = null
        if (queued?.key === snapshotKey(board.current)) { void ask(queued.question) }
        else if (!greeted.current) {
          greeted.current = true
          void voiceRef.current.speak('I have your board. Play a move and ask me about it, or ask what to play now.')
        }
      }
      const currentVoice = voiceRef.current
      bc.postMessage({ type: 'poll' })
      bc.postMessage({ type: 'status', label: currentVoice.speaking ? 'Coach speaking · use Interrupt coach to talk.'
        : busyRef.current ? 'Coach is analyzing your question…' : !readyRef.current ? 'Connecting the shared board…'
        : currentVoice.listening ? 'Coach listening · ask about your move.' : 'Board connected · check the microphone in Share Screen.' })
    }, 500)
    return () => {
      clearInterval(timer); resetBoard()
      streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null
      bc.postMessage({ type: 'status', label: 'Call ended.' }); bc.close(); bcRef.current = null
    }
  }, [session, ask, cancelTurn, resetBoard])

  const supported = voice.supported && !!navigator.mediaDevices?.getDisplayMedia &&
    'BroadcastChannel' in window && typeof MediaStreamTrack !== 'undefined' && 'getCaptureHandle' in MediaStreamTrack.prototype

  const start = async () => {
    if (starting || streamRef.current) return
    setStarting(true); setError(''); voice.retry()
    const version = ++generation.current
    let captured: MediaStream | null = null
    try {
      // Must be the first awaited browser call in this click handler (transient activation).
      captured = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 10, max: 15 }, displaySurface: 'browser' }, audio: false,
        selfBrowserSurface: 'include', preferCurrentTab: true, systemAudio: 'exclude', surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'exclude',
      } as DisplayMediaStreamOptions)
      if (version !== generation.current) { captured.getTracks().forEach(t => t.stop()); return }
      const track = captured.getVideoTracks()[0] as CaptureTrack
      if (!capturedBoardId(track, session, false)) {
        throw new Error('Choose the “Forked • Board for live coach” browser tab. A whole window, desktop, or unrelated tab cannot link its position.')
      }
      streamRef.current = captured; setStream(captured); setStartedAt(Date.now())
      track.addEventListener('ended', end, { once: true })
      // Invalidate immediately when the captured source changes, not just on the next heartbeat.
      track.addEventListener('capturehandlechange', resetBoard)
      track.addEventListener('mute', resetBoard)
      bcRef.current?.postMessage({ type: 'poll' })
    } catch (failure) {
      captured?.getTracks().forEach(t => t.stop())
      if (version !== generation.current) return
      setError(failure instanceof DOMException && failure.name === 'NotAllowedError'
        ? 'Sharing was cancelled or denied. You can try Start sharing again.'
        : failure instanceof Error ? failure.message : 'Could not share this tab. Try desktop Chrome.')
    } finally { setStarting(false) }
  }

  return { session, stream, starting, start, end, supported, ready, boardState, error: error || voice.error,
    muted, toggleMic: () => setMuted(v => !v), busy, listening: voice.listening, speaking: voice.speaking,
    interrupt: cancelTurn, hasAnswer, repeat: () => { if (lastAnswer.current) { cancelTurn(); void voice.speak(lastAnswer.current) } },
    useLlm, setUseLlm, startedAt, retryVoice: () => { setError(''); voice.retry() },
    testSpeaker: () => { void voice.speak('Hello. I am your Forked chess coach. This is the English voice you will hear.') } }
}
