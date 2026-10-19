import { useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { fetchRecentGames, type RecentGame } from '../../api/gameReview'

function resultText(g: RecentGame): { text: string; cls: string } {
  if (g.result === null) return { text: '·', cls: 'text-text-2' }
  if (g.result === 1) return { text: 'Won', cls: 'text-emerald-300' }
  if (g.result === 0) return { text: 'Lost', cls: 'text-rose-300' }
  return { text: 'Draw', cls: 'text-text-1' }
}

function when(ts: number | null): string {
  if (!ts) return ''
  const ms = ts > 1e11 ? ts : ts * 1000
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Pick one of a player's latest games and review it — no PGN copy-paste. */
export function RecentGames({ defaultUser, defaultPlatform, disabled, onPick }: {
  defaultUser: string; defaultPlatform: string; disabled: boolean; onPick: (pgn: string) => void
}) {
  const [user, setUser] = useState(defaultUser), [platform, setPlatform] = useState(defaultPlatform || 'chesscom')
  const [games, setGames] = useState<RecentGame[] | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('')

  async function load() {
    if (!user.trim()) return
    setLoading(true); setError('')
    try { setGames(await fetchRecentGames(user.trim(), platform)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load games.'); setGames(null) }
    finally { setLoading(false) }
  }

  return (
    <div className="space-y-3" data-testid="recent-games">
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void load() }}>
        <input aria-label="Username" className="input flex-1 min-w-[160px]" value={user} placeholder="Chess.com or Lichess username"
          onChange={e => setUser(e.target.value)} disabled={disabled} />
        <select aria-label="Platform" className="input !w-auto" value={platform} onChange={e => setPlatform(e.target.value)} disabled={disabled}>
          <option value="chesscom">Chess.com</option><option value="lichess">Lichess</option>
        </select>
        <button className="btn-ghost border border-border flex items-center gap-2" disabled={disabled || loading || !user.trim()}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}Recent games
        </button>
      </form>
      {error && <p role="alert" className="text-xs text-amber-200">{error}</p>}
      {games && (games.length === 0
        ? <p className="text-xs text-text-2">No recent games found.</p>
        : <div className="grid gap-1.5 max-h-64 overflow-y-auto">
          {games.map(g => {
            const r = resultText(g)
            const me = g.user_color === 'white' ? g.white_username : g.black_username
            const opp = g.user_color === 'white' ? g.black_username : g.white_username
            const oppElo = g.user_color === 'white' ? g.black_elo : g.white_elo
            return (
              <button key={g.game_id} disabled={disabled} onClick={() => onPick(g.pgn)}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-bg-2 hover:bg-bg-3 text-left text-sm disabled:opacity-50">
                <span className="min-w-0 truncate"><span className="text-text-2 text-xs mr-2">{g.user_color === 'white' ? '○' : '●'}</span>
                  {me} vs {opp}{oppElo ? <span className="text-text-2 text-xs"> ({oppElo})</span> : null}</span>
                <span className="flex items-center gap-3 flex-shrink-0 text-xs">
                  <span className="text-text-2">{g.time_class} · {when(g.played_at)}</span>
                  <span className={r.cls}>{r.text}</span>
                  <span className="text-accent">Review →</span>
                </span>
              </button>
            )
          })}
        </div>)}
    </div>
  )
}
