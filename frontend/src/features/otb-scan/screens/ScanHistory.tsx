import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, ChevronLeft, FileText, Loader2, Microscope, ScanSearch, Trash2 } from 'lucide-react'
import { libraryApi, type LibraryGame } from '../../../api/library'
import { KeyMomentDropdowns } from '../../../components/review/KeyMoments'
import { useUserStore } from '../../../store/userStore'
import { useOpenReview } from '../../../lib/review'
import { relativeTime } from '../../../lib/format'

/** Scoresheets the player confirmed in OTB Scan — reopen, review or analyse them. */
export function useScanHistory() {
  const { username } = useUserStore()
  return useQuery({
    queryKey: ['library', username, 'otb'],
    queryFn: () => libraryApi.games(username, { source: 'otb', limit: 200 }),
    enabled: !!username,
    refetchInterval: q => (q.state.data?.games.some(g => g.review.status === 'queued' || g.review.status === 'running') ? 3000 : false),
    staleTime: 10_000,
  })
}

export function ScanHistoryList({ games, compact = false }: { games: LibraryGame[]; compact?: boolean }) {
  const { username } = useUserStore()
  const navigate = useNavigate()
  const openReview = useOpenReview()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)

  async function withPgn(g: LibraryGame) { return g.pgn ? g : (await libraryApi.game(username, g.id)).game }
  async function review(g: LibraryGame) {
    setBusy(g.id)
    try { const full = await withPgn(g); await openReview({ pgn: full.pgn!, source: 'otb', user_color: g.user_color ?? undefined }) }
    finally { setBusy(null) }
  }
  async function analyse(g: LibraryGame) {
    const full = await withPgn(g)
    navigate('/analysis', { state: { pgn: full.pgn, title: g.title, reviewId: g.review.status === 'done' ? g.id : undefined } })
  }
  async function remove(g: LibraryGame) {
    if (!confirm(`Remove "${g.title}" from your scanned games?`)) return
    await libraryApi.deleteGame(username, g.id).catch(() => undefined)
    void qc.invalidateQueries({ queryKey: ['library', username] })
  }

  return (
    <div className="grid gap-3">
      {games.map(g => {
        const reviewed = g.review.status === 'done'
        const running = g.review.status === 'queued' || g.review.status === 'running'
        return (
          <div key={g.id} className={`card p-3 flex flex-col sm:flex-row gap-3 sm:items-center ${reviewed ? 'border-success/30' : ''}`}>
            <div className="flex items-center gap-3 min-w-0 flex-1">
              {g.has_scan
                ? <img src={libraryApi.scanUrl(username, g.id)} alt="" loading="lazy" className={`${compact ? 'w-12 h-14' : 'w-16 h-20'} object-cover rounded-lg border border-border bg-black flex-shrink-0`} />
                : <span className={`${compact ? 'w-12 h-14' : 'w-16 h-20'} rounded-lg border border-border bg-bg-2 grid place-items-center text-text-2 flex-shrink-0`}><FileText size={18} /></span>}
              <div className="min-w-0">
                <p className="text-sm text-text-0 font-medium truncate">{g.title}</p>
                <p className="text-[11px] text-text-2">{relativeTime(g.created_at)} · {Math.ceil(g.plies / 2)} moves{g.result && g.result !== '*' ? ` · ${g.result}` : ''}</p>
                {reviewed && <p className="text-[11px] text-success inline-flex items-center gap-1 mt-1"><CheckCircle2 size={11} />Reviewed{g.user_color && g.review.accuracy?.[g.user_color] != null ? ` · ${g.review.accuracy[g.user_color]}% accuracy` : ` · ${g.review.accuracy?.white ?? '—'}% / ${g.review.accuracy?.black ?? '—'}%`}</p>}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {reviewed ? (
                <>
                  <KeyMomentDropdowns compact moments={g.key_moments ?? { mistakes: [], blunders: [] }} onOpen={m => navigate(`/game-review/${g.id}?ply=${m.ply}`)} />
                  <button onClick={() => navigate(`/game-review/${g.id}`)} className="btn-primary text-xs py-1.5 inline-flex items-center gap-1.5"><ScanSearch size={13} />Open review</button>
                </>
              ) : running ? (
                <button onClick={() => navigate(`/game-review/${g.id}`)} className="text-xs text-accent inline-flex items-center gap-1.5 px-2"><Loader2 size={12} className="animate-spin" />Reviewing…</button>
              ) : (
                <button onClick={() => void review(g)} disabled={busy === g.id} className="btn-primary text-xs py-1.5 inline-flex items-center gap-1.5">
                  {busy === g.id ? <Loader2 size={13} className="animate-spin" /> : <ScanSearch size={13} />}Review game
                </button>
              )}
              <button onClick={() => void analyse(g)} className="btn-ghost border border-border text-xs py-1.5 inline-flex items-center gap-1.5"><Microscope size={13} />Analysis</button>
              <button onClick={() => void remove(g)} className="p-1.5 text-text-2 hover:text-danger" aria-label="Remove"><Trash2 size={13} /></button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function ScanHistory({ onBack }: { onBack: () => void }) {
  const { data, isLoading } = useScanHistory()
  const games = data?.games ?? []
  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <button onClick={onBack} className="btn-ghost flex items-center gap-1 mb-3"><ChevronLeft size={15} /> Back</button>
      <h1 className="font-display text-2xl font-semibold text-text-0">Your scanned games</h1>
      <p className="text-sm text-text-2 mt-1 mb-5">Every scoresheet you confirmed. Reviewed games open instantly — nothing is recomputed.</p>
      {isLoading ? <p className="text-sm text-text-2">Loading…</p>
        : games.length ? <ScanHistoryList games={games} />
        : <p className="card p-6 text-sm text-text-2">No scanned games yet. After a scan, press <span className="text-text-0">Done</span> and save the game — it will appear here.</p>}
    </div>
  )
}
