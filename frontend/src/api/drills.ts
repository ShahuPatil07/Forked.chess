// Drill progress (backend/drills.py): solved count, streaks, day streak, and how
// many of your real-game mistakes per family you've now drilled.

export interface DrillDay { date: string; n: number; w: number }
export interface DrillFamily {
  cluster_id: string
  label: string
  drilled: number
  solved: number
  incidents: number
  coverage: number | null
}
export interface DrillStats {
  total: number
  solved: number
  accuracy: number | null
  streak: number
  best_streak: number
  day_streak: number
  best_day_streak: number
  today: { n: number; w: number }
  last14: DrillDay[]
  families: DrillFamily[]
  mistakes_total: number
  mistakes_drilled_share: number | null
}

/** The player's local calendar date (YYYY-MM-DD) — day streaks follow their day, not UTC. */
export const localDate = () => new Date().toLocaleDateString('en-CA')

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
  return res.json()
}

export const drillsApi = {
  stats: (username: string) =>
    fetch(`/api/drills/stats/${encodeURIComponent(username)}?today=${localDate()}`).then(r => json<DrillStats>(r)),

  attempt: (body: { username: string; cluster_id: string; correct: boolean; time_s: number; puzzle_id?: string }) =>
    fetch('/api/drills/attempt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, date: localDate() }),
    }).then(r => json<{ streak: number; best_streak: number; total: number; solved: number }>(r)),
}
