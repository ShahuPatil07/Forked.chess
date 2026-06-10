// Client for the scoresheet OCR endpoint, served by the PawnPrint FastAPI
// backend (backend/scoresheet.py). In dev, Vite proxies /api -> :8000.
const OCR_BASE = import.meta.env.VITE_FORKED_API_URL ?? '/api'

export interface MoveEntry {
  number: number
  white: string | null
  black: string | null
  white_valid?: boolean
  black_valid?: boolean
  white_raw?: string
  black_raw?: string
  white_error?: string
  black_error?: string
  error?: string
}

export interface OCRResult {
  moves: MoveEntry[]
  total_moves: number
  valid_moves: number
  pgn: string
  raw_ocr: string
  confidence?: number
  low_confidence?: boolean
  warning?: string
}

export async function ocrScoresheet(image: File): Promise<OCRResult> {
  const form = new FormData()
  form.append('image', image)
  const res = await fetch(`${OCR_BASE}/ocr/scoresheet`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    let detail = `OCR failed (${res.status})`
    try {
      const body = await res.json()
      if (body?.detail) detail = body.detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json()
}
