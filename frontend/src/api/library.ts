/**
 * Game library + background reviews (backend/library.py) and the platform
 * Game History (backend/history.py).
 *
 * A review is started with `startReview` and followed with `followReview`,
 * which re-reads the job's full event log from the start — so a page can
 * re-mount, a second tab can watch, or the Analysis Board can keep the user
 * exploring while the review finishes in the background.
 */
import type { MoveClass, OfficialAccuracy, ReviewEvent, ReviewMove, ReviewSummary } from './gameReview'
import { errorMessage } from './auth'

export type GameSource = 'maia' | 'opening' | 'endgame' | 'otb' | 'review' | 'analysis' | 'platform' | 'coach'
export type ReviewStatus = 'none' | 'queued' | 'running' | 'done' | 'error'

export interface KeyMoment {
  ply: number | null
  move_number: number | null
  color: 'white' | 'black' | null
  san: string
  uci?: string
  best_san: string | null
  best_uci: string | null
  classification: MoveClass | 'mistake' | 'blunder'
  loss: number | null
  before_fen: string
  eval_before?: { cp: number | null; mate: number | null; pov?: 'mover' }
  eval_after?: { cp: number | null; mate: number | null; pov?: 'mover' }
  family?: string | null
  direction?: string | null
}

export interface KeyMoments { mistakes: KeyMoment[]; blunders: KeyMoment[] }

export interface ReviewInfo {
  status: ReviewStatus
  id?: string
  quality?: string
  completed_at?: number
  accuracy?: { white: number | null; black: number | null }
  rating?: { white: number | null; black: number | null }
  counts?: Record<'white' | 'black', Partial<Record<MoveClass, number>>>
  mistakes?: number
  blunders?: number
  progress?: [number, number]
}

export interface LibraryGame {
  id: string
  title: string
  source: GameSource
  source_label: string
  sources: GameSource[]
  white: string
  black: string
  white_elo?: string | null
  black_elo?: string | null
  result: string
  user_color: 'white' | 'black' | null
  initial_fen: string
  plies: number
  played_at: number
  created_at: number
  time_class?: string | null
  url?: string | null
  opening?: { name: string; eco: string } | null
  meta?: Record<string, unknown>
  review: ReviewInfo
  key_moments?: KeyMoments
  has_scan?: boolean
  pgn?: string
}

export interface StoredReview {
  id: string
  headers: Record<string, string>
  initial_fen: string
  quality: string
  engine: string
  moves: ReviewMove[]
  summary: ReviewSummary
  official_accuracy: OfficialAccuracy | null
  user_color: 'white' | 'black' | null
}

export type ReviewGetResponse =
  | { status: 'done'; review: StoredReview; game: LibraryGame | null }
  | { status: 'queued' | 'running'; progress: [number, number]; headers?: Record<string, string>; initial_fen?: string; moves: ReviewMove[] }

export type LibraryEvent = ReviewEvent | { type: 'queued'; review_id: string } | { type: 'stored'; review_id: string }

const enc = encodeURIComponent

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export interface StartReviewInput {
  pgn: string
  quality?: 'quick' | 'standard' | 'deep'
  source?: GameSource
  meta?: Record<string, unknown>
  user_color?: 'white' | 'black'
  title?: string
  url?: string
  time_class?: string
  force?: boolean
}

export const libraryApi = {
  games: (username: string, params: { source?: string; reviewed?: boolean; q?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
    return fetch(`/api/library/${enc(username)}/games?${qs}`).then(r => json<{ games: LibraryGame[]; total: number }>(r))
  },
  game: (username: string, id: string) =>
    fetch(`/api/library/${enc(username)}/games/${enc(id)}`).then(r => json<{ game: LibraryGame }>(r)),
  addGame: (username: string, body: {
    pgn?: string; moves?: string[]; initial_fen?: string; headers?: Record<string, string>; source: GameSource
    meta?: Record<string, unknown>; user_color?: 'white' | 'black'; title?: string; url?: string; time_class?: string
    scan_image?: string
  }) => fetch(`/api/library/${enc(username)}/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => json<{ game: LibraryGame }>(r)),
  deleteGame: (username: string, id: string) =>
    fetch(`/api/library/${enc(username)}/games/${enc(id)}`, { method: 'DELETE' }).then(r => json<{ ok: boolean }>(r)),
  scanUrl: (username: string, id: string) => `/api/library/${enc(username)}/games/${enc(id)}/scan`,
  startReview: (username: string, input: StartReviewInput) =>
    fetch(`/api/library/${enc(username)}/reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quality: 'standard', ...input }),
    }).then(r => json<{ review_id: string; status: ReviewStatus; game: LibraryGame }>(r)),
  review: (username: string, id: string) =>
    fetch(`/api/library/${enc(username)}/reviews/${enc(id)}`).then(r => json<ReviewGetResponse>(r)),
}

/**
 * Follow a review job's event stream (replayed from the first event). Resolves
 * when the review is done; `onEvent` sees queued / start / move / done. A
 * `stored` event means the review already exists — fetch it with libraryApi.review.
 */
export async function followReview(username: string, reviewId: string, onEvent: (e: LibraryEvent) => void,
                                   signal?: AbortSignal): Promise<'done' | 'stored'> {
  const res = await fetch(`/api/library/${enc(username)}/reviews/${enc(reviewId)}/stream`, { signal })
  if (!res.ok || !res.body) throw new Error(await errorMessage(res))
  const reader = res.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const event = JSON.parse(line.slice(6)) as LibraryEvent
        if (event.type === 'error') throw new Error(event.message)
        onEvent(event)
        if (event.type === 'done') return 'done'
        if (event.type === 'stored') return 'stored'
      }
      if (done) break
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  throw new Error('The review connection closed early. It may still be running — reopen it from your history.')
}

// ── platform history ────────────────────────────────────────────────────────

export interface PlatformGame {
  id: string
  platform_id: string
  platform: 'chesscom' | 'lichess'
  url: string
  white: string
  black: string
  white_elo: number | null
  black_elo: number | null
  user_color: 'white' | 'black'
  outcome: 'win' | 'loss' | 'draw' | null
  time_class: string
  time_control: string
  played_at: number | null
  plies: number
  opening: string | null
  result: string
  pgn: string
  analysed: boolean
  review: ReviewInfo
  moments: KeyMoments
  moments_source: 'review' | 'blindspots' | null
}

export interface HistoryResponse {
  platform: 'chesscom' | 'lichess'
  fetched_at: number
  stale: boolean
  counts: Record<string, number>
  games: PlatformGame[]
}

export const historyApi = {
  get: (username: string, params: { platform?: string; time_class?: string; refresh?: boolean } = {}) => {
    const qs = new URLSearchParams()
    if (params.platform) qs.set('platform', params.platform)
    if (params.time_class) qs.set('time_class', params.time_class)
    if (params.refresh) qs.set('refresh', '1')
    return fetch(`/api/history/${enc(username)}?${qs}`).then(r => json<HistoryResponse>(r))
  },
}

export type { ReviewMove, ReviewSummary, OfficialAccuracy }
