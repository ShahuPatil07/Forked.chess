export type MoveClass = 'book' | 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'miss' | 'blunder'
export interface ReviewScore { cp: number | null; mate: number | null; white_cp: number | null; white_mate: number | null; expected: number; win_percent: number }
export interface ReviewLine { san: string[]; uci: string[]; fens: string[] }
export interface ReviewMove {
  ply: number; move_number: number; color: 'white' | 'black'; san: string; uci: string
  fen: string; before_fen: string; classification: MoveClass; reason: string; explanation: string
  best_san: string; best_uci: string; best_score: ReviewScore; played_score: ReviewScore
  expected_loss: number; accuracy: number; depth: number; best_depth: number; forced: boolean; search_limited: boolean
  line: ReviewLine; best_line: ReviewLine; opening: { name: string; eco: string } | null
}
export interface SideSummary {
  accuracy: number | null; moves: number; counts: Partial<Record<MoveClass, number>>; rating_sample: number
  rating: { estimate: number; low: number; high: number; sample: number; calibrated: false } | null
}
export interface ReviewSummary { white: SideSummary; black: SideSummary }
export type ReviewEvent =
  | { type: 'start'; total: number; headers: Record<string, string>; initial_fen: string; quality: string; algorithm: string }
  | { type: 'move'; move: ReviewMove }
  | { type: 'done'; summary: ReviewSummary; engine: string; algorithm: string }
  | { type: 'error'; message: string }

export async function reviewGame(pgn: string, quality: string, onEvent: (event: ReviewEvent) => void, signal: AbortSignal) {
  const response = await fetch('/api/game-review/analyse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pgn, quality }), signal })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(typeof error.detail === 'string' ? error.detail : 'Could not start review. Check the PGN and try again.')
  }
  if (!response.body) throw new Error('The review stream is unavailable.')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', complete = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const event = JSON.parse(line.slice(6)) as ReviewEvent
        if (event.type === 'error') throw new Error(event.message)
        onEvent(event)
        if (event.type === 'done') complete = true
      }
      if (done) break
    }
    if (!complete) throw new Error('The review ended early. Partial moves are available; rerun to finish.')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
