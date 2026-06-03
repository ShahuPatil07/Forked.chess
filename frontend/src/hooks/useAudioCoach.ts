/**
 * Audio mode for the Forked Coach — browser-native, zero API cost.
 *  • Speech-to-text via the Web Speech API (SpeechRecognition)
 *  • Text-to-speech via SpeechSynthesis
 * Reliable only in Chrome/Edge; `supported` is false elsewhere so the UI can
 * show a graceful message.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

// The Web Speech API isn't in TS's default DOM lib; access via any.
function getRecognitionCtor(): any {
  if (typeof window === 'undefined') return null
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null
}

/** Strip markdown so the TTS voice doesn't read "asterisk asterisk". */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/[*_`#>]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function useAudioCoach(onFinalTranscript?: (text: string) => void) {
  const recognitionSupported = !!getRecognitionCtor()
  const synthSupported = typeof window !== 'undefined' && 'speechSynthesis' in window
  const supported = recognitionSupported && synthSupported

  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [interim, setInterim] = useState('')
  const recRef = useRef<any>(null)
  const cbRef = useRef(onFinalTranscript)
  cbRef.current = onFinalTranscript

  // Build the recognition instance once.
  useEffect(() => {
    const Ctor = getRecognitionCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.continuous = false
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.onresult = (e: any) => {
      let finalText = ''
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += t
        else interimText += t
      }
      setInterim(interimText)
      if (finalText.trim()) {
        setInterim('')
        cbRef.current?.(finalText.trim())
      }
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    return () => { try { rec.abort() } catch { /* noop */ } }
  }, [])

  const startListening = useCallback(() => {
    if (!recRef.current || listening) return
    try { recRef.current.start(); setListening(true) } catch { /* already started */ }
  }, [listening])

  const stopListening = useCallback(() => {
    if (!recRef.current) return
    try { recRef.current.stop() } catch { /* noop */ }
    setListening(false)
  }, [])

  const speak = useCallback((text: string) => {
    if (!synthSupported || !text.trim()) return
    const clean = stripMarkdown(text)
    // Read at most ~200 words aloud; the rest stays on screen.
    const words = clean.split(' ')
    const spoken = words.length > 200 ? words.slice(0, 200).join(' ') + '…' : clean
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(spoken)
    u.rate = 1.0; u.pitch = 1.0
    u.onstart = () => setSpeaking(true)
    u.onend = () => setSpeaking(false)
    u.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(u)
  }, [synthSupported])

  const stopSpeaking = useCallback(() => {
    if (synthSupported) window.speechSynthesis.cancel()
    setSpeaking(false)
  }, [synthSupported])

  return { supported, listening, speaking, interim, startListening, stopListening, speak, stopSpeaking }
}
