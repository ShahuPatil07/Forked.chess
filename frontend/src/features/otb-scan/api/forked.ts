// Hand-off to the main Forked / PawnPrint app once a game is recorded.
//
// Configure via Vite env vars (optional):
//   VITE_FORKED_APP_URL   default https://forked.chess
//   VITE_FORKED_API_URL   default `${APP_URL}/api`

const APP_URL = import.meta.env.VITE_FORKED_APP_URL ?? 'https://forked.chess'
const API_URL = import.meta.env.VITE_FORKED_API_URL ?? `${APP_URL}/api`

// Open the analysis board in the main app with the recorded PGN.
export const analyseUrl = (pgn: string): string =>
  `${APP_URL}/analysis?pgn=${encodeURIComponent(pgn)}`

export interface AnalyseResult {
  ok: boolean
  redirected: boolean
  error?: string
}

// If a Forked auth token is available, POST the PGN straight into the user's
// import pipeline; otherwise open the public analysis page with the PGN inline.
export async function analyseWithForked(
  pgn: string,
  userToken: string | null,
): Promise<AnalyseResult> {
  if (userToken) {
    try {
      const res = await fetch(`${API_URL}/analysis/import-pgn`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ pgn, source: 'otb_scanner', platform: 'otb' }),
      })
      if (!res.ok) {
        return { ok: false, redirected: false, error: `Import failed (${res.status})` }
      }
      window.location.href = `${APP_URL}/dashboard`
      return { ok: true, redirected: true }
    } catch (e) {
      return {
        ok: false,
        redirected: false,
        error: e instanceof Error ? e.message : 'Network error',
      }
    }
  }

  // Unauthenticated: open the analysis page with the PGN in the URL.
  window.open(analyseUrl(pgn), '_blank')
  return { ok: true, redirected: true }
}
