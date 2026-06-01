import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { TrendingUp, Loader2, Download, Link2, Check, Twitter, MessageSquare, type LucideIcon } from 'lucide-react'
import { useUserStore } from '../../store/userStore'
import { api } from '../../api'
import { insightsApi } from '../../api/insights'
import { ChessDNACard } from '../ChessDNACard'

function CopyButton({ text, label, icon: Icon }: {
  text: string; label: string; icon: LucideIcon
}) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => {
        setCopied(true); setTimeout(() => setCopied(false), 1500)
      })}
      className="btn-ghost flex items-center gap-1.5 text-xs"
    >
      {copied ? <Check size={12} className="text-success" /> : <Icon size={12} />}
      {copied ? 'Copied!' : label}
    </button>
  )
}

/**
 * Dashboard "Share your Chess DNA" block:
 *   • Chess-style section (archetype + axis bars)
 *   • Counterfactual rating ladder
 *   • Live DNA card preview + download / share-link / pre-written share texts
 */
export function RatingImpact() {
  const { username } = useUserStore()
  const [copiedLink, setCopiedLink] = useState(false)

  const { data: style } = useQuery({
    queryKey: ['style', username],
    queryFn:  () => insightsApi.style(username),
    enabled:  !!username,
    staleTime: 5 * 60_000,
    retry:    false,
  })
  const { data: cf, isLoading: cfLoading } = useQuery({
    queryKey: ['counterfactual', username],
    queryFn:  () => insightsApi.counterfactual(username),
    enabled:  !!username,
    staleTime: 5 * 60_000,
    retry:    false,
  })
  const { data: profile } = useQuery({
    queryKey: ['profile', username],
    queryFn:  () => api.getProfile(username),
    enabled:  !!username,
  })

  function labelFor(cid: number | string): string {
    const c = profile?.clusters?.find((c: any) => String(c.cluster_id) === String(cid))
    return c?.label ?? `Cluster #${cid}`
  }

  const cardUrl   = insightsApi.dnaCardUrl(username)
  const shareLink = `${window.location.origin}/dna/${username}`
  const archetype = style?.archetype ?? 'mystery player'
  const topPts    = cf?.has_result_data ? cf.total_gain : 0
  const nGames    = cf?.n_games ?? profile?.stats?.total_games ?? 0

  const tweetText = `My chess DNA via Forked — I'm ${archetype} 🧬` +
    (topPts > 0 ? ` My top weakness is costing me ~${topPts} rating points.` : '') +
    ` ${shareLink}`
  const redditText = `Analysed ${nGames} of my games — here's my chess style profile ` +
    `and my biggest recurring mistake patterns: ${shareLink}`

  return (
    <div className="mb-8 space-y-4">
      {/* Style section */}
      {style && <ChessDNACard style={style} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Rating impact ladder */}
        <div className="card p-5">
          <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wider flex items-center gap-1.5 mb-3">
            <TrendingUp size={12} /> Rating impact
          </h2>
          {cfLoading ? (
            <div className="flex items-center gap-2 text-xs text-text-2 py-4">
              <Loader2 size={12} className="animate-spin text-accent" /> Estimating…
            </div>
          ) : !cf || !cf.has_result_data ? (
            <p className="text-xs text-text-2 py-2">
              Rating-impact estimate needs your game results, which we couldn't
              retrieve right now. Drilling still works — check back after a sync.
            </p>
          ) : cf.total_gain <= 0 ? (
            <p className="text-xs text-text-2 py-2">
              No clearly recoverable games detected — your losses mostly came from
              already-difficult positions rather than these patterns.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-text-2">Actual rating</span>
                  <span className="font-bold text-text-0 tabular-nums">{cf.actual_rating}</span>
                </div>
                {cf.ladder.map((step, i) => (
                  <div key={String(step.cluster_id)} className="flex items-center justify-between text-sm">
                    <span className="text-text-1 truncate max-w-[55%]">
                      {i === 0 ? 'Fix ' : '+ '}<span className="text-text-0">{labelFor(step.cluster_id)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 tabular-nums text-xs">
                      <span className="text-success font-medium">+{step.step_gain}</span>
                      <span className="text-text-2">→</span>
                      <span className="font-bold text-text-0">{step.rating_after}</span>
                    </span>
                  </div>
                ))}
                <div className="border-t border-border pt-1.5 flex items-center justify-between text-sm">
                  <span className="text-accent font-medium">Fix all</span>
                  <span className="flex items-center gap-1.5 tabular-nums">
                    <span className="text-success font-bold">+{cf.total_gain}</span>
                    <span className="text-text-2">→</span>
                    <span className="font-bold text-accent">{cf.potential_rating}</span>
                  </span>
                </div>
              </div>
              <p className="text-[10px] text-text-2 mt-2.5 leading-relaxed">
                Estimate from your last {cf.n_games} games · {cf.games_recovered} recoverable.
              </p>
            </>
          )}
        </div>

        {/* Share your Chess DNA */}
        <div className="card p-5">
          <h2 className="text-xs font-semibold text-text-2 uppercase tracking-wider mb-3">
            Share your Chess DNA
          </h2>
          <a href={shareLink} target="_blank" rel="noopener noreferrer" className="block group">
            <img src={cardUrl} alt="Your Chess DNA card"
              className="w-full rounded-lg border border-border group-hover:border-accent/40 transition-colors" />
          </a>
          <div className="flex flex-wrap gap-2 mt-3">
            <a href={cardUrl} download={`${username}_chess_dna.png`}
              className="btn-ghost flex items-center gap-1.5 text-xs">
              <Download size={12} /> Download card
            </a>
            <button
              onClick={() => navigator.clipboard.writeText(shareLink).then(() => {
                setCopiedLink(true); setTimeout(() => setCopiedLink(false), 1500)
              })}
              className="btn-ghost flex items-center gap-1.5 text-xs">
              {copiedLink ? <Check size={12} className="text-success" /> : <Link2 size={12} />}
              {copiedLink ? 'Copied!' : 'Copy share link'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2 mt-2 pt-2 border-t border-border">
            <CopyButton text={tweetText}  label="Twitter text" icon={Twitter} />
            <CopyButton text={redditText} label="Reddit text"  icon={MessageSquare} />
          </div>
        </div>
      </div>
    </div>
  )
}
