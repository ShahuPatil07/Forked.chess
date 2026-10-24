// Client for the scoresheet endpoints (backend/scoresheet.py). In dev, Vite proxies /api -> :8000.
const OCR_BASE = import.meta.env.VITE_FORKED_API_URL ?? '/api'

/** How sure we are of a decoded move. */
export type PlyStatus = 'exact' | 'corrected' | 'uncertain' | 'inferred' | 'confirmed'

export interface Ply {
  ply: number
  san: string
  uci: string
  status: PlyStatus
  /** which written cell it came from (null = inferred, not on the sheet) */
  cell: number | null
  row: number | null
  color: 'w' | 'b' | null
  /** what the sheet says in that cell */
  read: string
  cost: number
  alternatives: string[]
  /** every legal SAN in the position before this ply */
  legal: string[]
}

export interface ReadRow {
  number: number
  white: string
  black: string
  white_alt: string[]
  black_alt: string[]
}

export interface ScanResult {
  plies: Ply[]
  sans: string[]
  pgn: string
  reads: ReadRow[]
  dropped: { row: number; color: string; read: string }[]
  meta: Partial<Record<'white' | 'black' | 'result' | 'event' | 'date', string>>
  stats: Record<'exact' | 'corrected' | 'uncertain' | 'inferred', number>
  warning: 'few_moves' | 'low_confidence' | null
  total_moves: number
  provider?: string
  pages?: number
  elapsed_s?: number
  cost_usd?: number
}

async function errorOf(res: Response): Promise<Error> {
  let detail = `Request failed (${res.status})`
  try {
    const body = await res.json()
    if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
  } catch { /* not json */ }
  return new Error(detail)
}

/** Read one game from one or more scoresheet photos (pages in order). */
export async function scanScoresheet(images: File[], elo?: number): Promise<ScanResult> {
  const form = new FormData()
  images.forEach(img => form.append('images', img))
  if (elo) form.append('elo', String(elo))
  const res = await fetch(`${OCR_BASE}/ocr/scoresheet`, { method: 'POST', body: form })
  if (!res.ok) throw await errorOf(res)
  return res.json()
}

/** Re-decode the same readings with the user's confirmed moves pinned (no model call, ~1 s). */
export async function redecode(reads: ReadRow[], pins: Record<number, string>, meta: ScanResult['meta'], elo?: number): Promise<ScanResult> {
  const res = await fetch(`${OCR_BASE}/ocr/scoresheet/redecode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reads, pins, meta, elo }),
  })
  if (!res.ok) throw await errorOf(res)
  return res.json()
}
