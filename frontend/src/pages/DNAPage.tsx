import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ArrowRight, Download, Link2, Check, AlertCircle, Twitter } from 'lucide-react'
import { ForkedWordmark } from '../components/layout/AppShell'
import { insightsApi } from '../api/insights'

const ARCHETYPE_DESC: Record<string, string> = {
  'The Attacker':   'You play sharp, risky chess and look for the kill',
  'The Tactician':  'You spot combinations but choose your battles',
  'The Gambiteer':  'You sacrifice material for initiative and complexity',
  'The Calculator': 'You calculate precisely and exploit tactical chaos',
  'The Strategist': 'You outmanoeuvre opponents with long-term plans',
  'The Grinder':    'You convert advantages slowly and surely',
  'The Pragmatist': 'You adapt your style to what the position demands',
  'The Fortress':   'You defend tenaciously and wait for opponent errors',
}

/**
 * Public landing page for a shared Chess DNA card. No auth.
 * Renders the card image, archetype headline, and a CTA to analyse own games.
 * Sets OG meta tags so shared links preview the card image + archetype.
 */
export default function DNAPage() {
  const { username } = useParams<{ username: string }>()
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const [imgError, setImgError] = useState(false)

  const cardUrl   = username ? insightsApi.dnaCardUrl(username) : ''
  const shareLink = `${window.location.origin}/dna/${username}`

  const { data: style } = useQuery({
    queryKey: ['style', username],
    queryFn:  () => insightsApi.style(username!),
    enabled:  !!username,
    retry:    false,
  })

  const archetype = style?.archetype ?? null
  const desc = archetype ? (style?.description || ARCHETYPE_DESC[archetype] || '') : ''

  // OG / social meta tags (best-effort: also helps when this is the entry page)
  useEffect(() => {
    if (!username) return
    const prevTitle = document.title
    const absCard = `${window.location.origin}${cardUrl}`
    const title = archetype
      ? `${username}'s Chess DNA — ${archetype}`
      : `${username}'s Chess DNA`
    const descr = `Analysed ${style?.n_games ?? 'their'} games on Forked. Discover your chess style and blindspots.`

    document.title = title
    const tags: { attr: 'property' | 'name'; key: string; val: string }[] = [
      { attr: 'property', key: 'og:title',       val: title },
      { attr: 'property', key: 'og:description', val: descr },
      { attr: 'property', key: 'og:image',       val: absCard },
      { attr: 'property', key: 'og:type',        val: 'website' },
      { attr: 'name',     key: 'twitter:card',   val: 'summary_large_image' },
      { attr: 'name',     key: 'twitter:image',  val: absCard },
      { attr: 'name',     key: 'twitter:title',  val: title },
    ]
    const created: HTMLMetaElement[] = []
    for (const t of tags) {
      const el = document.createElement('meta')
      el.setAttribute(t.attr, t.key)
      el.setAttribute('content', t.val)
      document.head.appendChild(el)
      created.push(el)
    }
    return () => {
      document.title = prevTitle
      created.forEach(el => el.remove())
    }
  }, [username, archetype, cardUrl, style?.n_games])

  function copyLink() {
    navigator.clipboard.writeText(shareLink).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    })
  }
  const tweet = encodeURIComponent(
    `My chess DNA via Forked${archetype ? ` — I'm ${archetype} 🧬` : ''} ${shareLink}`
  )

  return (
    <div className="min-h-screen bg-bg-0 flex flex-col items-center justify-center px-4 py-10">
      <div className="mb-6"><ForkedWordmark className="text-2xl" /></div>

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-2xl space-y-5">

        {archetype && (
          <div className="text-center">
            <p className="text-xs text-text-2 uppercase tracking-wider">{username}'s chess DNA</p>
            <h1 className="text-3xl font-black tracking-tight mt-1"
              style={{ background: 'linear-gradient(135deg, #c4b5fd, #7c6af7)',
                       WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                       backgroundClip: 'text' }}>
              {archetype}
            </h1>
            {desc && <p className="text-sm text-text-2 mt-1">{desc}</p>}
          </div>
        )}

        {imgError ? (
          <div className="card p-8 flex flex-col items-center gap-3 text-center">
            <AlertCircle size={22} className="text-text-2" />
            <p className="text-sm text-text-1">This Chess DNA card isn't available.</p>
            <p className="text-xs text-text-2">The player may not have analysed their games yet.</p>
          </div>
        ) : (
          <img src={cardUrl} alt={`${username}'s Chess DNA`}
            onError={() => setImgError(true)}
            className="w-full rounded-xl border border-border shadow-2xl" />
        )}

        {!imgError && (
          <div className="flex gap-2 justify-center">
            <a href={cardUrl} download={`${username}_chess_dna.png`}
              className="btn-ghost flex items-center gap-1.5 text-sm">
              <Download size={13} /> Download
            </a>
            <button onClick={copyLink} className="btn-ghost flex items-center gap-1.5 text-sm">
              {copied ? <Check size={13} className="text-success" /> : <Link2 size={13} />}
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <a href={`https://twitter.com/intent/tweet?text=${tweet}`} target="_blank" rel="noopener noreferrer"
              className="btn-ghost flex items-center gap-1.5 text-sm">
              <Twitter size={13} /> Share on X
            </a>
          </div>
        )}

        <div className="card p-6 text-center space-y-3">
          <h2 className="text-lg font-bold text-text-0">
            Find out exactly how <span className="text-accent">you</span> play and lose.
          </h2>
          <p className="text-sm text-text-2">
            Forked analyses your last 200 games, profiles your style, finds your
            recurring blindspots, and drills them with spaced repetition.
          </p>
          <motion.button
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            onClick={() => navigate('/')}
            className="btn-primary inline-flex items-center gap-2 text-sm mx-auto">
            Analyse your games on Forked <ArrowRight size={14} />
          </motion.button>
        </div>
      </motion.div>
    </div>
  )
}
