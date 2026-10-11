import { useCallback, useEffect, useRef, useState } from 'react'

// SpeechRecognition is still absent from TypeScript's standard DOM declarations.
const recognitionCtor = () => (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition

export function useLiveVoice(enabled: boolean, onQuestion: (text: string) => void) {
  const supported = !!recognitionCtor() && 'speechSynthesis' in window
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const speakingRef = useRef(false)
  const callback = useRef(onQuestion)
  callback.current = onQuestion
  const recRef = useRef<any>(null)
  const speechGeneration = useRef(0)
  const settleSpeech = useRef<(() => void) | null>(null)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)

  const stop = useCallback(() => {
    speechGeneration.current++
    window.speechSynthesis?.cancel()
    settleSpeech.current?.(); settleSpeech.current = null
    utteranceRef.current = null
    speakingRef.current = false; setSpeaking(false)
  }, [])

  const speak = useCallback(async (text: string) => {
    stop()
    if (!text.trim() || !('speechSynthesis' in window)) return
    // Set the ref before aborting recognition: late recognition events cannot feed back TTS.
    speakingRef.current = true; setSpeaking(true)
    try { recRef.current?.abort() } catch { /* already stopped */ }
    const generation = speechGeneration.current
    // Short utterances avoid Chromium's long-utterance stalls; never cut an answer mid-sentence.
    const chunks = text.split(/(?<=[.!?])\s+(?=[A-Z])/)
    for (const chunk of chunks) {
      if (generation !== speechGeneration.current) break
      await new Promise<void>(resolve => {
        const utterance = new SpeechSynthesisUtterance(chunk.trim())
        utteranceRef.current = utterance
        utterance.lang = 'en-US'; utterance.rate = 1; utterance.pitch = 1
        const english = window.speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang))
        utterance.voice = english.find(v => v.localService) ?? english[0] ?? null
        let done = false
        const finish = () => {
          if (done) return
          done = true; clearTimeout(timeout); settleSpeech.current = null; resolve()
        }
        const timeout = window.setTimeout(() => {
          if (generation === speechGeneration.current) {
            setError('Audio playback stalled. Check your output device, then use Repeat answer.')
            speechGeneration.current++; window.speechSynthesis.cancel()
            speakingRef.current = false; setSpeaking(false)
          }
          finish()
        }, Math.max(15000, chunk.length * 140))
        settleSpeech.current = finish
        utterance.onend = finish
        utterance.onerror = event => {
          if (!['interrupted', 'canceled'].includes(event.error)) {
            setError('English voice playback failed. Check your browser audio and try Repeat answer.')
          }
          finish()
        }
        window.speechSynthesis.speak(utterance)
      })
    }
    if (generation === speechGeneration.current) { speakingRef.current = false; setSpeaking(false) }
  }, [stop])

  useEffect(() => {
    if (!enabled || speaking || error || !supported) return
    const Ctor = recognitionCtor()
    let alive = true
    let timer: number | undefined
    let rec: any
    const start = () => {
      if (!alive || speakingRef.current) return
      rec = new Ctor(); recRef.current = rec
      rec.lang = 'en-US'; rec.continuous = false; rec.interimResults = true
      let final = ''
      let failed = false
      rec.onstart = () => { if (alive) setListening(true) }
      rec.onresult = (event: any) => {
        if (!alive || speakingRef.current) return
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) final += event.results[i][0].transcript + ' '
        }
      }
      rec.onerror = (event: any) => {
        if (!alive) return
        if (['no-speech', 'aborted'].includes(event.error)) return
        failed = true
        const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone or speech permission was denied. Allow microphone access in browser settings, then retry.'
          : event.error === 'audio-capture' ? 'No microphone is available. Connect one, then retry.'
          : 'Speech recognition is unavailable. Check your internet connection, or try desktop Chrome, then retry.'
        setError(message)
      }
      rec.onend = () => {
        if (!alive) return
        setListening(false)
        if (final.trim() && !speakingRef.current && !failed) callback.current(final.trim())
        if (!failed) timer = window.setTimeout(start, 500)
      }
      try { rec.start() }
      catch { setError('Could not start the microphone. Retry voice or try desktop Chrome.') }
    }
    timer = window.setTimeout(start, 350)
    return () => {
      alive = false; clearTimeout(timer); setListening(false)
      try { rec?.abort() } catch { /* already stopped */ }
      recRef.current = null
    }
  }, [enabled, speaking, error, supported, retry])

  useEffect(() => () => { speechGeneration.current++; window.speechSynthesis?.cancel(); settleSpeech.current?.() }, [])
  return { supported, listening, speaking, error, speak, stop,
    retry: () => { setError(''); setRetry(n => n + 1) } }
}
