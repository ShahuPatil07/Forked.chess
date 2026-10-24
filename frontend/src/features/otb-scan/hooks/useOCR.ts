import { useCallback, useState } from 'react'
import { redecode, scanScoresheet, type ScanResult } from '../api/ocr'
import { useUserStore } from '../../../store/userStore'

export type OCRState = 'idle' | 'processing' | 'review' | 'error'

export interface UseOCR {
  state: OCRState
  result: ScanResult | null
  error: string | null
  /** object URLs of the uploaded pages, for the side-by-side review */
  pages: string[]
  analyseScoresheet: (images: File[]) => Promise<void>
  /** re-decode with the user's pinned moves; resolves when the new game is in */
  pin: (pins: Record<number, string>) => Promise<void>
  reset: () => void
}

// Drives the scoresheet flow: idle -> processing -> review (or error).
export function useOCR(): UseOCR {
  // the decoder's human-move prior is rating-aware: a 1200 and a 2000 make different natural moves
  const elo = useUserStore(s => s.elo) || undefined
  const [state, setState] = useState<OCRState>('idle')
  const [result, setResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pages, setPages] = useState<string[]>([])

  const analyseScoresheet = useCallback(async (images: File[]) => {
    setState('processing')
    setError(null)
    setPages(prev => { prev.forEach(u => URL.revokeObjectURL(u)); return images.map(f => URL.createObjectURL(f)) })
    try {
      setResult(await scanScoresheet(images, elo))
      setState('review')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the scoresheet. Try a sharper, well-lit photo.')
      setState('error')
    }
  }, [elo])

  const pin = useCallback(async (pins: Record<number, string>) => {
    if (!result) return
    setResult(await redecode(result.reads, pins, result.meta, elo))
  }, [result, elo])

  const reset = useCallback(() => {
    setState('idle')
    setResult(null)
    setError(null)
    setPages(prev => { prev.forEach(u => URL.revokeObjectURL(u)); return [] })
  }, [])

  return { state, result, error, pages, analyseScoresheet, pin, reset }
}
