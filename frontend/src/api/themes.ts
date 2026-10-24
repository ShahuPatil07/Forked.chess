/** Typed client for /api/themes (Puzzle Themes). */

export interface ThemeExample { fen: string; color: 'w' | 'b' }

export interface ThemeItem {
  key: string
  name: string
  desc: string
  spot: string[]
  parent: string | null
  sub: string[]
  forked: boolean
  count: number      // puzzles with this theme in the full Lichess DB (or detected, for Forked themes)
  local: number      // puzzles indexed locally
  example: ThemeExample | null
}

export interface ThemeCategory {
  id: string
  title: string
  blurb: string
  forked: boolean
  themes: ThemeItem[]
}

export interface OpeningVariation { key: string; name: string; count: number; local: number }
export interface OpeningFamily extends OpeningVariation { variations: OpeningVariation[] }

export interface ThemeUserStat { rating: number; n: number; w: number; acc: number | null }
export interface FocusTheme { theme: string; name: string; reason: string }

export interface ThemesUser {
  rating: number
  rd: number
  provisional: boolean
  total: number
  solved: number
  today: { n: number; w: number }
  streak_days: number
  review_due: number
  review_total: number
  game_puzzles: number
  game_by_theme: Record<string, number>
  /** own-game puzzles split: your blunders vs the tactics you missed */
  game_split?: { blunders: number; missed: number }
  game_sample?: { fen: string; moves: string; color: 'w' | 'b'; played_san: string | null; move_number: number; kind: string } | null
  focus: FocusTheme[]
  themes: Record<string, ThemeUserStat>
  runs: { rush: Record<string, { best: number }>; streak: Record<string, { best: number }> }
  seeded_from: number | null
}

export interface CatalogResponse {
  categories: ThemeCategory[]
  openings: OpeningFamily[]
  source: { db: boolean; puzzles: number; lichess_total: number; built_at: string | null }
  user: ThemesUser
}

export type PuzzleSource = 'local' | 'lichess' | 'game' | 'review'

export interface ThemePuzzle {
  id: string
  fen: string           // BEFORE the opponent's trigger move
  moves: string         // UCI, trigger first, then the solution
  rating: number
  rd: number
  plays: number
  popularity: number
  themes: string[]
  game_url: string | null
  opening: string
  color: 'w' | 'b'      // the solver's colour
  source: PuzzleSource
  angle: string
  rated: boolean
  hint: { theme: string; name: string; text: string }
  focus?: { theme: string; name: string; reason: string }
  review?: { streak: number; fails: number }
  game?: {
    game_id: string | null; move_number: number; played_at: number | null; played_san: string | null
    judgement: string | null; es_loss: number | null; kind: 'blunder' | 'mistake' | 'opportunity'
    best_san?: string | null
  }
  post_fen?: string
}

export type AttemptResult = 'win' | 'hint' | 'loss'
export type TrainMode = 'practice' | 'rush' | 'streak'

export interface AttemptResponse {
  rated: boolean
  rating: { before: number; after: number; delta: number; rd: number }
  themes: { theme: string; before: number; after: number }[]
  review: { queued?: boolean; due_in_hours?: number; graduated?: boolean } | null
  today: { n: number; w: number }
  streak_days: number
}

export interface ExplainStep { san: string; uci: string; mine: boolean; notes: string[]; move_no: number; white: boolean }
export interface Explanation {
  trigger: { san: string; side: string } | null
  steps: ExplainStep[]
  summary: string
  material: number
  mate: boolean
  verified: string[]
  solver: string
}

export interface StatsRow {
  theme: string; name: string; rating: number; n: number; w: number; acc: number; avg_s: number
  vs_overall: number; forked: boolean
}

export interface StatsResponse extends ThemesUser {
  rows: StatsRow[]
  strengths: StatsRow[]
  weaknesses: StatsRow[]
  history: [number, number][]
  days: { day: string; n: number }[]
}

export interface NextParams {
  username: string
  angle: string
  difficulty?: string
  color?: string
  exclude?: string[]
  themes?: string[]
  match?: 'any' | 'all'
  elo?: number
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).detail ?? msg } catch { /* not json */ }
    throw new Error(msg)
  }
  return res.json()
}

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')

const post = <T>(path: string, body: unknown) =>
  req<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const themesApi = {
  catalog: (username: string, elo?: number) =>
    req<CatalogResponse>(`/api/themes/catalog?${qs({ username, elo })}`),

  next: (p: NextParams) =>
    req<ThemePuzzle>(`/api/themes/next?${qs({
      username: p.username, angle: p.angle, difficulty: p.difficulty, color: p.color,
      exclude: p.exclude?.slice(-200).join(','), themes: p.themes?.join(','), match: p.match, elo: p.elo,
    })}`),

  run: (p: NextParams & { mode: 'rush' | 'streak' }) =>
    req<{ puzzles: ThemePuzzle[]; start: number | null }>(`/api/themes/run?${qs({
      username: p.username, angle: p.angle, mode: p.mode, color: p.color, themes: p.themes?.join(','),
      match: p.match, elo: p.elo,
    })}`),

  attempt: (username: string, puzzle: ThemePuzzle, angle: string, result: AttemptResult, timeMs: number,
            mode: TrainMode, elo?: number) =>
    post<AttemptResponse>('/api/themes/attempt', { username, puzzle, angle, result, time_ms: Math.round(timeMs), mode, elo }),

  runResult: (username: string, angle: string, mode: 'rush' | 'streak', score: number, mistakes: number, durationMs: number) =>
    post<{ best: number; previous: number; record: boolean }>('/api/themes/run-result',
      { username, angle, mode, score, mistakes, duration_ms: Math.round(durationMs) }),

  stats: (username: string) => req<StatsResponse>(`/api/themes/stats?${qs({ username })}`),

  explain: (fen: string, moves: string) => post<Explanation>('/api/themes/explain', { fen, moves }),

  checkMove: (fen: string, uci: string, best: string) =>
    post<{ ok: boolean; loss?: number; reason?: string }>('/api/themes/check-move', { fen, uci, best }),

}

/** "12.4K", "1.2M" */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return String(n)
}

/** Opening tags come as Sicilian_Defense_Najdorf_Variation. */
export const tagName = (tag: string) => tag.replace(/_/g, ' ')

/** Readable label for any theme key: bishopFork -> bishop fork, mateIn2 -> mate in 2. */
export const themeLabel = (key: string) =>
  key.includes('_') ? tagName(key) : key.replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase()
