import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Loader2, AlertTriangle, Target, CheckCircle2, Zap, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api'
import { liveApi, type DebriefMatch } from '../api/live'
import { MiniBoardThumbnail } from './openings/MiniBoardThumbnail'

interface Props {
  gameId:   string
  username: string
}

export function BotGameDebrief({ gameId, username }: Props) {
  const navigate = useNavigate()
  const [showUnmatched, setShowUnmatched] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey:  ['bot-debrief', gameId],
    queryFn:   () => liveApi.debriefBotGame(gameId, username),
    enabled:   !!gameId && !!username,
    staleTime: Infinity,
    retry:     false,
  })
  const { data: profile } = useQuery({
    queryKey: ['profile', username],
    queryFn:  () => api.getProfile(username),
    enabled:  !!username,
  })

  function labelFor(m: DebriefMatch): string {
    const c = profile?.clusters?.find((c: any) => String(c.cluster_id) === String(m.cluster_id))
    return c?.label ?? `Cluster #${m.cluster_rank}`
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1].map(i => (
          <div key={i} className="card p-4 animate-pulse flex gap-3">
            <div className="w-11 h-11 bg-bg-3 rounded" />
            <div className="flex-1 space-y-2">
              <div className="h-3 bg-bg-3 rounded w-2/3" />
              <div className="h-2 bg-bg-3 rounded w-1/2" />
            </div>
          </div>
        ))}
        <p className="text-xs text-text-2 text-center flex items-center justify-center gap-1.5">
          <Loader2 size={12} className="animate-spin text-accent" /> Cross-referencing your blindspots…
        </p>
      </div>
    )
  }

  if (isError || !data) {
    return <p className="text-xs text-text-2 italic p-4">Debrief unavailable.</p>
  }

  if (!data.has_profile) {
    return (
      <div className="card p-4 text-center text-xs text-text-2">
        Analyse your games first to build a blindspot profile — then Maia games get debriefed against it.
      </div>
    )
  }

  // State 3 — clean game
  if (data.total_mistakes === 0) {
    return (
      <div className="card p-5 border border-success/30 bg-success/10 text-center space-y-2">
        <CheckCircle2 size={22} className="text-success mx-auto" />
        <p className="text-sm font-semibold text-success">Clean game — no known weakness patterns 🎯</p>
        <p className="text-xs text-text-1">Your drilling is showing results.</p>
      </div>
    )
  }

  // State 2 — mistakes, none matched
  if (data.matched.length === 0) {
    return (
      <div className="card p-5 border border-border bg-bg-2 text-center space-y-2">
        <Target size={20} className="text-text-2 mx-auto" />
        <p className="text-sm font-medium text-text-0">
          You made {data.total_mistakes} mistake{data.total_mistakes > 1 ? 's' : ''}, but none matched your known patterns.
        </p>
        <p className="text-xs text-text-2">
          These may be emerging new weaknesses — we'll watch for them.
        </p>
      </div>
    )
  }

  // State 1 — blindspot(s) repeated
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-danger" />
        <p className="text-sm font-semibold text-text-0">
          You triggered {data.matched.length} known weakness{data.matched.length > 1 ? 'es' : ''} in this game.
        </p>
      </div>

      {data.matched.map((m, i) => (
        <motion.div key={i}
          initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
          className="card p-3 flex gap-3 items-start">
          <MiniBoardThumbnail fen={m.fen} size={56} />
          <div className="flex-1 min-w-0 space-y-1">
            <p className="text-xs text-text-0">
              Move {m.move_number}: you played <span className="font-mono text-danger">{m.played}</span>,
              best was <span className="font-mono text-success">{m.best.slice(0, 2)}→{m.best.slice(2, 4)}</span>
              <span className="text-text-2"> (−{m.eval_drop}cp)</span>
            </p>
            <p className="text-[11px] text-accent flex items-center gap-1">
              <AlertTriangle size={10} />
              Cluster #{m.cluster_rank} · {labelFor(m)} — {Math.round(m.similarity * 100)}% confidence
            </p>
            {m.mastery_before !== null && m.mastery_after !== null && (
              <div className="flex items-center gap-2 text-[10px] text-text-2">
                <span>Mastery {Math.round(m.mastery_before * 100)}% → {Math.round(m.mastery_after * 100)}%</span>
                <div className="flex-1 h-1 bg-bg-3 rounded-full overflow-hidden max-w-[120px]">
                  <div className="h-full bg-danger rounded-full" style={{ width: `${Math.round(m.mastery_after * 100)}%` }} />
                </div>
              </div>
            )}
          </div>
        </motion.div>
      ))}

      {/* Unmatched mistakes (collapsed) */}
      {data.unmatched_count > 0 && (
        <div>
          <button onClick={() => setShowUnmatched(s => !s)}
            className="text-[11px] text-text-2 hover:text-text-1 flex items-center gap-1">
            <ChevronDown size={11} className={showUnmatched ? 'rotate-180 transition-transform' : 'transition-transform'} />
            {data.unmatched_count} other mistake{data.unmatched_count > 1 ? 's' : ''} — not matched to known patterns
          </button>
          {showUnmatched && (
            <p className="text-[11px] text-text-2 mt-1 pl-4">
              These didn't confidently match any blindspot — possibly new or one-off errors.
            </p>
          )}
        </div>
      )}

      <button
        onClick={() => navigate('/session', { state: { clusterId: String(data.matched[0].cluster_id) } })}
        className="btn-primary w-full flex items-center justify-center gap-1.5 text-sm">
        <Zap size={13} /> Drill these patterns now →
      </button>
    </div>
  )
}
