import { useCallback, useState } from 'react'
import { ocrScoresheet, type OCRResult } from '../api/ocr'

export type OCRState = 'idle' | 'processing' | 'review' | 'error'

export interface UseOCR {
  state: OCRState
  result: OCRResult | null
  error: string | null
  analyseScoresheet: (image: File) => Promise<void>
  reset: () => void
  /** Dev-only: jump straight to the review screen with sample data. */
  loadSample: () => void
}

// A sample OCR response (with two deliberately bad reads) so the review screen
// can be previewed without a running backend.
const SAMPLE: OCRResult = {
  moves: [
    { number: 1, white: 'e4', black: 'e5', white_valid: true, black_valid: true },
    { number: 2, white: 'Nf3', black: 'Nc6', white_valid: true, black_valid: true },
    { number: 3, white: 'Bb5', black: 'a6', white_valid: true, black_valid: true },
    { number: 4, white: 'Ba4', black: 'Nf6', white_valid: true, black_valid: true },
    { number: 5, white: 'O-O', black: '', white_valid: true, black_valid: false, black_raw: 'B-c3' },
    { number: 6, white: 'Re1', black: 'b5', white_valid: false, black_valid: false },
  ],
  total_moves: 12,
  valid_moves: 4,
  pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6',
  raw_ocr: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O B-c3 6. Re1 b5',
  warning: undefined,
}

// Drives the scoresheet OCR flow: idle → processing → review (or error).
export function useOCR(): UseOCR {
  const [state, setState] = useState<OCRState>('idle')
  const [result, setResult] = useState<OCRResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const analyseScoresheet = useCallback(async (image: File) => {
    setState('processing')
    setError(null)
    try {
      const data = await ocrScoresheet(image)
      setResult(data)
      setState('review')
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'OCR failed — try a clearer, well-lit photo',
      )
      setState('error')
    }
  }, [])

  const reset = useCallback(() => {
    setState('idle')
    setResult(null)
    setError(null)
  }, [])

  const loadSample = useCallback(() => {
    setResult(SAMPLE)
    setError(null)
    setState('review')
  }, [])

  return { state, result, error, analyseScoresheet, reset, loadSample }
}
