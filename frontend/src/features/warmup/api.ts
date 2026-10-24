/** Typed client for /api/warmup (backend/warmup/router.py). */

export type TimeControl = 'bullet' | 'blitz' | 'rapid' | 'classical'
export type Platform = 'chesscom' | 'lichess'
export type ActivityId =
  | 'setup_check' | 'breathing_reset' | 'worry_dump' | 'move_nudge'
  | 'check_flash' | 'double_check_hunt' | 'loose_pieces' | 'threat_count' | 'what_changed'
  | 'opponent_threat' | 'two_candidates' | 'easy_sprint'

export interface CheckFlashItem { id: string; level: number; fen: string; window: [number, number, number]; answer: boolean; flash_ms: number }
export interface DoubleCheckItem { id: string; level: number; boards: { fen: string; window: [number, number, number]; checkers: number }[]; answer: number }
export interface LooseItem { id: string; level: number; fen: string; orientation: 'white' | 'black'; include_pawns: boolean; answer: string[]; own: boolean }
export interface ThreatCountItem { id: string; level: number; fen: string; orientation: 'white' | 'black'; variant: 'threatened' | 'hanging' | 'attacked' | 'undefended'; answer: number; squares: string[]; own: boolean }
export interface WhatChangedItem { id: string; level: number; fen_a: string; fen_b: string; move: string; answer: string[]; piece: string; show_ms: number; orientation: 'white' | 'black'; own: boolean }
export interface OpponentThreatItem {
  id: string; level: number; before: string; last: string; fen: string; orientation: 'white' | 'black'; own: boolean
  answer: { kind: 'capture' | 'mate' | 'none'; squares: string[]; moves: string[] }
}
export interface TwoCandidatesItem {
  id: string; level: number; fen: string; before: string; last: string; orientation: 'white' | 'black'
  best: string[]; best_san: string; tempting_san: string; evals: Record<string, number>; rating: number
}
export interface SprintItem { id: string; level: number; fen: string; moves: string; rating: number; color: 'w' | 'b'; themes: string[] }
export type DrillItem = CheckFlashItem | DoubleCheckItem | LooseItem | ThreatCountItem | WhatChangedItem
  | OpponentThreatItem | TwoCandidatesItem | SprintItem

export interface Step {
  activity: ActivityId
  kind: 'perception' | 'thinking' | 'state'
  title: string
  est_s: number
  level?: number
  count?: number
  cap_ms?: number | null
  reason?: string
  pools?: Record<string, DrillItem[]>
}

export interface Tilt { streak: number; threshold: number; triggered: boolean; last_game_at?: number | null; break_until?: number | null; break_minutes?: number; last_result?: number | null }
export interface RatingInfo { rating: number; source: string | null; platform: Platform; chesscom_calibrated: boolean; note: string | null }
export interface Fact { fact: string; label: string; count: number; drills: ActivityId[] }

export interface Session {
  id: string
  band: { id: string; label: string; multiplier: number; tilt_losses: number }
  rating: RatingInfo
  time_control: TimeControl
  minutes: number
  tilt: Tilt
  facts: { focus: Fact[]; counts: Record<string, number>; games: number }
  steps: Step[]
  cue: string
  play_url: string
  adaptive: { ease_below: number; harden_above: number; window: number }
  honesty: string
  est_s: number
  /** relaxed first question, then a little faster each time (data/warmup_config.json "timer") */
  timer?: { start_factor: number; per_item: number; min_factor: number }
}

export interface Outcome { game_id: string; url: string | null; result: number | null; accuracy: number | null; blunders: number; moves: number; blunders_per40: number | null; time_class: string }
export interface Summary { items: number; accuracy: number | null; drills: Record<string, { items: number; accuracy: number; median_ms: number | null; baseline: { items: number; accuracy: number; median_ms: number | null } | null }> }
export interface Moment {
  id: string; created_at: number; time_control: string; arm: 'warmup' | 'control'; in_experiment: number
  session_id: string | null; outcomes: Outcome[]; summary: Summary | null
}

export interface Profile {
  username: string
  band: { id: string; label: string; multiplier: number; tilt_losses: number; emphasis: ActivityId[]; thinking: ActivityId[] }
  rating: RatingInfo
  ratings: Record<TimeControl, number | null>
  tilt: Tilt
  facts: { games: number; blunders: number; counts: Record<string, number>; focus: Fact[] }
  routine: ActivityId[] | null
  consent: boolean
  history: Moment[]
  baselines: Record<string, { items: number; accuracy: number; median_ms: number | null }>
  bank_ready: boolean
  activities: Record<ActivityId, { title: string; kind: Step['kind']; est_s: number }>
  honesty: string
  tilt_copy: string
}

export interface EventRow { drill_id: ActivityId; item_id: string; correct: boolean; score?: number; response_ms?: number; difficulty?: number; extra?: Record<string, unknown> }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/warmup${path}`, init)
  if (!res.ok) {
    let msg = res.statusText
    try { msg = (await res.json()).detail ?? msg } catch { /* not json */ }
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return res.json()
}
const post = <T>(path: string, body: unknown) =>
  req<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const qs = (o: Record<string, string | number | undefined | null>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')

export type Minutes = 3 | 5 | 10
export interface Who { username: string; platform: Platform; time_control: TimeControl; elo?: number; rating?: number }

export const warmupApi = {
  profile: (w: Who) => req<Profile>(`/profile?${qs({ username: w.username, platform: w.platform, time_control: w.time_control, elo: w.elo, rating: w.rating })}`),
  moment: (w: Who) => post<{ moment_id: string; arm: 'warmup' | 'control'; in_experiment: boolean; play_url: string }>('/moment', w),
  momentPlay: (id: string) => post<{ ok: boolean }>(`/moment/${id}/play`, {}),
  session: (w: Who & { minutes: Minutes; use_routine?: boolean; moment_id?: string; seen?: string[]; activities?: ActivityId[] }) =>
    post<Session>('/session', w),
  events: (body: { session_id: string; username: string; band: string; time_control: string; events: EventRow[] }) => post<{ logged: number }>('/events', body),
  finish: (sessionId: string, username: string) => post<Summary>(`/session/${sessionId}/finish?${qs({ username })}`, {}),
  saveRoutine: (username: string, steps: ActivityId[]) => req<{ steps: ActivityId[] }>('/routine', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, steps }),
  }),
  consent: (username: string, granted: boolean) => post<{ granted: boolean }>('/consent', { username, granted }),
  lab: () => req<Lab>('/lab'),
}

export interface ArmAgg { games: number; blunders_per40: number | null; accuracy: number | null }
export interface Lab {
  counts: { moments: number; experiment_moments: number; sessions: number; events: number; games: number }
  groups: {
    overall: Record<'warmup' | 'control', ArmAgg>
    by_band: Record<string, Record<'warmup' | 'control', ArmAgg>>
    by_time_control: Record<string, Record<'warmup' | 'control', ArmAgg>>
    warmup_games_by_drill: Record<string, ArmAgg>
    observational: Record<string, ArmAgg>
  }
  drills: Record<string, { items: number; accuracy: number; median_ms: number | null; by_band: Record<string, number> }>
  min_games_per_arm: number
}
