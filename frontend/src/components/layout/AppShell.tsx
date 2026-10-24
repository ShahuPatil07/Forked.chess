import { Suspense, useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Bell, ChevronRight, LogOut, Settings, User } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useUserStore } from '../../store/userStore'
import { liveApi } from '../../api/live'
import { authApi } from '../../api/auth'
import { pauseDevSkip } from '../../lib/devAuth'
import { locate, sectionHref } from '../../nav'
import { platformName } from '../../lib/ratings'

// ── Forked wordmark — white, with a neon full stop ───────────────────────────
export function ForkedWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-bold tracking-tight select-none text-text-0 ${className}`} style={{ letterSpacing: '-0.03em' }}>
      Forked<span className="text-accent">.</span>
    </span>
  )
}

/** The knight-and-fork mark in neon, with a soft glow. */
export function ForkedLogo({ className = 'h-7 w-7', glow = true }: { className?: string; glow?: boolean }) {
  return <img src="/logo.png" alt="" className={`object-contain ${glow ? 'logo-glow' : ''} ${className}`} />
}

/** Tree navigation: the hub is home, every page shows where it sits. */
function Breadcrumbs() {
  const { pathname } = useLocation()
  if (pathname === '/home') return null
  const { section, leaf } = locate(pathname)
  if (!section && pathname !== '/settings') return null
  const crumbs: { label: string; to?: string }[] = []
  if (pathname === '/settings') crumbs.push({ label: 'Settings' })
  if (section) crumbs.push({ label: section.title, to: leaf || section.children ? sectionHref(section) : undefined })
  if (leaf) crumbs.push({ label: leaf.title })
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm min-w-0">
      {crumbs.map((c, i) => (
        <span key={i} className={`flex items-center gap-1.5 min-w-0 ${i < crumbs.length - 1 ? 'hidden sm:flex' : ''}`}>
          <ChevronRight size={14} className="text-text-2 flex-shrink-0" />
          {c.to && i < crumbs.length - 1
            ? <Link to={c.to} className="text-text-1 hover:text-accent transition-colors truncate">{c.label}</Link>
            : <span className="text-text-0 font-medium truncate">{c.label}</span>}
        </span>
      ))}
    </nav>
  )
}

function AccountMenu() {
  const { account, username, platform, elo, clearUser } = useUserStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const qc = useQueryClient()
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const initials = (account?.name || username || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
  async function signOut() {
    await authApi.logout()
    pauseDevSkip()
    clearUser(); qc.clear()
    navigate('/', { replace: true })
  }
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full border border-border hover:border-accent/40 transition-colors">
        <span className="w-7 h-7 rounded-full bg-accent/15 text-accent text-[11px] font-bold grid place-items-center">{initials}</span>
        <span className="hidden md:flex flex-col items-start leading-tight max-w-[140px]">
          <span className="text-xs text-text-0 font-medium truncate max-w-full">{account?.name ?? username}</span>
          <span className="text-[10px] text-text-2 tabular-nums">{elo ? `${elo} · ` : ''}{platformName(platform)}</span>
        </span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-60 card p-1.5 shadow-2xl z-50">
          <div className="px-3 py-2.5 border-b border-border mb-1">
            <p className="text-sm text-text-0 font-medium truncate">{account?.name ?? username}</p>
            <p className="text-[11px] text-text-2 truncate">@{account?.user_id ?? username}{account?.is_dev ? ' · developer' : ''}</p>
            <p className="text-[11px] text-text-2 truncate mt-0.5">{platformName(platform)}: <span className="text-text-1">{username}</span>{elo ? ` · ${elo} rapid` : ''}</p>
          </div>
          <Link to="/settings" onClick={() => setOpen(false)} role="menuitem" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-text-1 hover:bg-bg-2 hover:text-text-0">
            <User size={14} /> Account & settings
          </Link>
          <button onClick={() => void signOut()} role="menuitem" className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-text-1 hover:bg-bg-2 hover:text-danger">
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}
    </div>
  )
}

export default function AppShell() {
  const { username, platform, setUser } = useUserStore()

  // Unseen blindspot alerts → neon dot on the bell (links to the dashboard)
  const { data: alertsData } = useQuery({
    queryKey: ['alerts', username],
    queryFn:  () => liveApi.getAlerts(username),
    enabled:  !!username,
    refetchInterval: 60_000,
  })
  const unseenAlerts = alertsData?.alerts?.length ?? 0

  // The player's live rating (rapid) — refreshed hourly server-side; keeps the
  // rating used everywhere in the app (puzzles, Maia, rating impact) current.
  const { data: ratings } = useQuery({
    queryKey: ['ratings', username, platform],
    queryFn: () => fetch(`/api/ratings/${encodeURIComponent(username)}?platform=${platform}`).then(r => (r.ok ? r.json() : null)),
    enabled: !!username,
    staleTime: 30 * 60_000,
    retry: false,
  })
  useEffect(() => {
    if (ratings?.primary_rating) setUser({ elo: ratings.primary_rating })
  }, [ratings?.primary_rating, setUser])

  return (
    <div className="min-h-full relative flex flex-col" style={{ zIndex: 1 }}>
      <header className="sticky top-0 z-40 h-14 flex-shrink-0 border-b border-border bg-bg-0/80 backdrop-blur-xl">
        <div className="h-full max-w-[1600px] mx-auto px-3 sm:px-4 lg:px-6 flex items-center gap-2 sm:gap-3">
          <Link to="/home" className="flex items-center gap-2 flex-shrink-0 group" aria-label="Forked home">
            <ForkedLogo className="h-7 w-7 opacity-95 group-hover:opacity-100" />
            <ForkedWordmark className="text-lg hidden sm:inline" />
          </Link>
          <div className="min-w-0 flex-1"><Breadcrumbs /></div>
          {unseenAlerts > 0 && (
            <Link to="/dashboard" className="relative p-2 rounded-lg text-text-1 hover:text-text-0 hover:bg-bg-2"
              title={`${unseenAlerts} new blindspot alert${unseenAlerts > 1 ? 's' : ''}`} aria-label="Blindspot alerts">
              <Bell size={17} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-accent shadow-neon-sm" />
            </Link>
          )}
          <Link to="/settings" className="p-2 rounded-lg text-text-2 hover:text-accent hover:bg-bg-2 transition-colors hidden sm:block" aria-label="Settings" title="Settings">
            <Settings size={17} />
          </Link>
          <AccountMenu />
        </div>
      </header>
      <main className="flex-1 min-w-0">
        <Suspense fallback={<PageFallback />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  )
}

/** Shown while a section's code chunk loads (pages are lazy-loaded in App.tsx). */
export function PageFallback() {
  return (
    <div className="flex items-center justify-center h-64" role="status" aria-label="Loading">
      <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
