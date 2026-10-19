import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpRight, Settings } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from '../api'
import { useUserStore } from '../store/userStore'
import { SECTIONS, sectionHref, type NavSection } from '../nav'

const STATUS: Record<string, { label: string; cls: string }> = {
  confirmed: { label: 'Confirmed', cls: 'text-danger border-danger/30' },
  emerging: { label: 'Emerging', cls: 'text-warn border-warn/30' },
  typical: { label: 'Typical', cls: 'text-text-1 border-border' },
  strength: { label: 'Strength', cls: 'text-success border-success/30' },
  insufficient_data: { label: 'Early data', cls: 'text-text-2 border-border' },
}

function trackGlow(e: MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect()
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
}

function Tile({ to, icon: Icon, title, blurb, chips, children, className = '', big = false, index = 0 }: {
  to: string; icon: LucideIcon; title: string; blurb: string; chips?: string[]
  children?: ReactNode; className?: string; big?: boolean; index?: number
}) {
  return (
    <motion.div className={`min-w-0 ${className}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.04 * index, duration: 0.35, ease: 'easeOut' }}>
      <Link to={to} onMouseMove={trackGlow} className="hub-tile group h-full" style={{ '--mx': '50%', '--my': '0%' } as CSSProperties}>
        <div className={`relative z-10 h-full flex flex-col ${big ? 'p-7 lg:p-8' : 'p-6'}`}>
          <div className="flex items-start justify-between">
            <span className="w-11 h-11 rounded-xl border border-accent/30 bg-accent/[0.06] text-accent grid place-items-center
                             group-hover:shadow-neon-sm transition-shadow">
              <Icon size={20} strokeWidth={1.8} />
            </span>
            <ArrowUpRight size={18} className="text-text-2 group-hover:text-accent group-hover:-translate-y-0.5 group-hover:translate-x-0.5 transition-all" />
          </div>
          <h2 className={`font-display font-semibold text-text-0 mt-6 ${big ? 'text-3xl' : 'text-2xl'}`}>{title}</h2>
          <p className="text-sm text-text-1 mt-2 leading-relaxed max-w-[46ch]">{blurb}</p>
          {children}
          {!!chips?.length && (
            <div className="mt-auto pt-6 flex flex-wrap gap-2">
              {chips.map(c => (
                <span key={c} className="text-xs px-2.5 py-1 rounded-full border border-border text-text-1 group-hover:border-accent/25 transition-colors">{c}</span>
              ))}
            </div>
          )}
        </div>
      </Link>
    </motion.div>
  )
}

/** Live preview on the Dashboard tile: the user's top blindspots and their status. */
function BlindspotPreview() {
  const { username } = useUserStore()
  const enabled = !!username && username !== 'Guest'
  const { data, isError } = useQuery({
    queryKey: ['profile', username], queryFn: () => api.getProfile(username), enabled, retry: false, staleTime: 60_000,
  })
  if (!enabled || isError) {
    return <p className="mt-6 text-sm text-text-2">Import your games from the home page to build your profile.</p>
  }
  const clusters = (data?.clusters ?? []).slice(0, 3)
  if (!clusters.length) return <div className="mt-6 h-[92px] rounded-xl bg-bg-2/60 animate-pulse" />
  return (
    <ol className="mt-6 grid gap-2">
      {clusters.map((c, i) => {
        const st = STATUS[c.profile?.status ?? ''] ?? null
        return (
          <li key={String(c.cluster_id)} className="min-w-0 flex items-center gap-3 rounded-xl border border-border bg-bg-0/60 px-3.5 py-2.5">
            <span className="font-mono text-xs text-accent w-4">{i + 1}</span>
            <span className="text-sm text-text-0 truncate flex-1">{c.label}</span>
            {c.profile?.relative_rate != null && <span className="hidden sm:inline font-mono text-xs text-text-2">{c.profile.relative_rate.toFixed(1)}× peers</span>}
            {st && <span className={`text-[11px] px-2 py-0.5 rounded-full border ${st.cls}`}>{st.label}</span>}
          </li>
        )
      })}
    </ol>
  )
}

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[520px] -z-0">
      <div className="absolute inset-0 grid-backdrop" />
      <div className="absolute left-1/2 -translate-x-1/2 -top-40 w-[760px] max-w-full h-[320px] rounded-full bg-accent/10 blur-[110px]" />
    </div>
  )
}

function SettingsLink() {
  return (
    <div className="mt-10 flex justify-end">
      <Link to="/settings" className="inline-flex items-center gap-2 text-xs text-text-2 hover:text-accent px-3 py-2 rounded-lg border border-border hover:border-accent/30 transition-colors">
        <Settings size={14} />Settings
      </Link>
    </div>
  )
}

function HomeHub() {
  const { username } = useUserStore()
  const guest = !username || username === 'Guest'
  const by = (id: string) => SECTIONS.find(s => s.id === id)!
  const tile = (s: NavSection, i: number, extra: { className?: string; big?: boolean; children?: ReactNode } = {}) => (
    <Tile key={s.id} index={i} to={sectionHref(s)} icon={s.icon} title={s.title} blurb={s.blurb}
      chips={s.children?.map(c => c.title)} {...extra} />
  )
  return (
    <>
      <header className="relative">
        <p className="text-[11px] tracking-[0.28em] uppercase text-text-2">{guest ? 'Welcome' : 'Welcome back'}</p>
        <h1 className="font-display text-4xl md:text-5xl font-semibold mt-3 text-text-0">
          {guest ? 'Where to?' : username}<span className="neon-text">.</span>
        </h1>
        <p className="text-text-1 mt-3 max-w-xl">A coach who knows exactly how you lose. Pick a place to start.</p>
      </header>
      <div className="relative mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {tile(by('dashboard'), 0, { className: 'md:col-span-2', big: true, children: <BlindspotPreview /> })}
        {tile(by('theory'), 1)}
        {tile(by('practice'), 2)}
        {tile(by('coach'), 3)}
        {tile(by('analyze'), 4)}
        <motion.div className="md:col-span-2 lg:col-span-3" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.24, duration: 0.35 }}>
          <Link to={sectionHref(by('scan'))} onMouseMove={trackGlow} className="hub-tile group" style={{ '--mx': '50%', '--my': '50%' } as CSSProperties}>
            <div className="relative z-10 p-6 flex items-center gap-5">
              <span className="w-11 h-11 rounded-xl border border-accent/30 bg-accent/[0.06] text-accent grid place-items-center flex-shrink-0">
                {(() => { const I = by('scan').icon; return <I size={20} strokeWidth={1.8} /> })()}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-xl font-semibold text-text-0">{by('scan').title}</h2>
                <p className="text-sm text-text-1 mt-1">{by('scan').blurb}</p>
              </div>
              <ArrowUpRight size={18} className="text-text-2 group-hover:text-accent transition-colors flex-shrink-0" />
            </div>
          </Link>
        </motion.div>
      </div>
      <SettingsLink />
    </>
  )
}

function SectionHub({ section }: { section: NavSection }) {
  const Icon = section.icon
  const kids = section.children ?? []
  return (
    <>
      <Link to="/home" className="inline-flex items-center gap-1.5 text-xs text-text-2 hover:text-accent transition-colors">
        <ArrowLeft size={14} />All sections
      </Link>
      <header className="relative mt-6 flex items-start gap-4">
        <span className="w-12 h-12 rounded-2xl border border-accent/30 bg-accent/[0.06] text-accent grid place-items-center flex-shrink-0 shadow-neon-sm">
          <Icon size={22} strokeWidth={1.8} />
        </span>
        <div>
          <h1 className="font-display text-4xl font-semibold text-text-0">{section.title}<span className="neon-text">.</span></h1>
          <p className="text-text-1 mt-2 max-w-xl">{section.blurb}</p>
        </div>
      </header>
      <div className={`relative mt-10 grid gap-4 md:grid-cols-2 ${kids.length > 2 ? 'lg:grid-cols-3' : ''}`}>
        {kids.map((c, i) => (
          <Tile key={c.id} index={i} to={c.to} icon={c.icon} title={c.title} blurb={c.blurb} big className="min-h-[220px]">
            <span className="mt-auto pt-8 inline-flex items-center gap-1.5 text-sm font-medium text-accent">Open {c.title}</span>
          </Tile>
        ))}
      </div>
      <SettingsLink />
    </>
  )
}

export default function Hub() {
  const { section: id } = useParams()
  const section = id ? SECTIONS.find(s => s.id === id) : undefined
  if (id && !section) return <Navigate to="/home" replace />
  if (section?.to) return <Navigate to={section.to} replace />
  return (
    <div className="relative isolate">
      <Backdrop />
      <div className="relative max-w-6xl mx-auto px-5 lg:px-8 pt-10 lg:pt-14 pb-16">
        {section ? <SectionHub section={section} /> : <HomeHub />}
      </div>
    </div>
  )
}
