import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Info, Loader2, TrendingUp } from 'lucide-react'
import { useUserStore } from '../../store/userStore'
import { insightsApi } from '../../api/insights'
import { CHART } from '../../theme'

/**
 * Rating impact: what fixing each blindspot family is worth, as a cumulative
 * ladder from the player's live rating. Model in backend/counterfactual.py —
 * each lost/drawn game is re-scored at the expected score held before its
 * turning-point mistake (not flipped to a win), then turned into a
 * performance-rating difference.
 */
export function RatingImpact() {
  const { username } = useUserStore()
  const { data: cf, isLoading } = useQuery({
    queryKey: ['counterfactual', username],
    queryFn: () => insightsApi.counterfactual(username),
    enabled: !!username, staleTime: 5 * 60_000, retry: false,
  })

  return (
    <section className="card p-4 sm:p-5 h-full flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-0 flex items-center gap-2"><TrendingUp size={14} className="text-accent" /> Rating impact</h3>
          <p className="text-xs text-text-2 mt-1">What fixing each blindspot is worth, from your live rating.</p>
        </div>
        {cf?.has_result_data && (
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wider text-text-2">Potential</p>
            <p className="text-2xl font-semibold text-accent leading-none mt-1">{cf.potential_rating}</p>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-text-2 py-6"><Loader2 size={13} className="animate-spin text-accent" /> Estimating…</div>
      ) : !cf || !cf.has_result_data ? (
        <p className="text-xs text-text-2 py-4">The estimate needs at least 10 analysed games with results. It appears after your next import.</p>
      ) : cf.total_gain <= 0 ? (
        <p className="text-xs text-text-2 py-4">No clearly recoverable games — your losses mostly came from positions that were already difficult.</p>
      ) : (
        <>
          <div className="mt-4 space-y-2.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-text-2">Now <span className="text-text-2/70 text-xs">({cf.rating_source})</span></span>
              <span className="font-semibold text-text-0">{cf.actual_rating}</span>
            </div>
            {cf.ladder.filter(s => s.step_gain > 0).map((s, i) => {
              const width = Math.max(4, (s.step_gain / Math.max(1, cf.total_gain)) * 100)
              return (
                <motion.div key={s.cluster_id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}>
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-text-1 truncate">{i === 0 ? 'Fix ' : '+ '}<span className="text-text-0">{s.label ?? s.cluster_id}</span></span>
                    <span className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-success font-semibold">+{s.step_gain}</span>
                      <span className="text-text-2">→</span>
                      <span className="text-text-0 font-semibold w-11 text-right">{s.rating_after}</span>
                    </span>
                  </div>
                  <div className="h-1.5 mt-1.5 rounded-full bg-bg-3 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${width}%`, background: CHART.you }} />
                  </div>
                </motion.div>
              )
            })}
          </div>
          <div className="mt-auto pt-4">
            <div className="border-t border-border pt-3 flex items-center justify-between text-sm">
              <span className="text-accent font-medium">Fix every turning point</span>
              <span><span className="text-success font-semibold">+{cf.total_gain}</span> <span className="text-text-2">→</span> <span className="font-semibold text-accent">{cf.potential_rating}</span></span>
            </div>
            <p className="text-[11px] text-text-2 mt-2.5 leading-relaxed flex gap-1.5">
              <Info size={12} className="flex-shrink-0 mt-0.5" />
              <span>{cf.n_games} analysed rapid games · score {Math.round((cf.score_rate ?? 0) * 100)}% vs avg {cf.avg_opp_rating} ·
                {' '}{cf.games_recovered} games had a turning-point mistake worth {cf.points_recovered} points. Games are re-scored at the position you had before the mistake — not counted as wins.</span>
            </p>
          </div>
        </>
      )}
    </section>
  )
}
