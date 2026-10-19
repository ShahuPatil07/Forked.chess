import { Link, Outlet, useLocation } from 'react-router-dom'
import { Bell, ChevronRight, Settings } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useUserStore } from '../../store/userStore'
import { liveApi } from '../../api/live'
import { locate, sectionHref } from '../../nav'

// ── Forked wordmark — white, with a neon full stop ───────────────────────────
export function ForkedWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-bold tracking-tight select-none text-text-0 ${className}`} style={{ letterSpacing: '-0.03em' }}>
      Forked<span className="text-accent">.</span>
    </span>
  )
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
        <span key={i} className="flex items-center gap-1.5 min-w-0">
          <ChevronRight size={14} className="text-text-2 flex-shrink-0" />
          {c.to && i < crumbs.length - 1
            ? <Link to={c.to} className="text-text-1 hover:text-accent transition-colors truncate">{c.label}</Link>
            : <span className="text-text-0 font-medium truncate">{c.label}</span>}
        </span>
      ))}
    </nav>
  )
}

export default function AppShell() {
  const { username } = useUserStore()

  // Unseen blindspot alerts → neon dot on the bell (links to the dashboard)
  const { data: alertsData } = useQuery({
    queryKey: ['alerts', username],
    queryFn:  () => liveApi.getAlerts(username),
    enabled:  !!username && username !== 'Guest',
    refetchInterval: 60_000,
  })
  const unseenAlerts = alertsData?.alerts?.length ?? 0

  return (
    <div className="min-h-full relative flex flex-col" style={{ zIndex: 1 }}>
      <header className="sticky top-0 z-40 h-14 flex-shrink-0 border-b border-border bg-bg-0/80 backdrop-blur-xl">
        <div className="h-full max-w-[1600px] mx-auto px-4 lg:px-6 flex items-center gap-3">
          <Link to="/home" className="flex items-center gap-2 flex-shrink-0 group" aria-label="Forked home">
            <img src="/logo.png" alt="" className="h-7 w-7 object-contain opacity-90 group-hover:opacity-100" />
            <ForkedWordmark className="text-lg" />
          </Link>
          <div className="min-w-0 flex-1"><Breadcrumbs /></div>
          {unseenAlerts > 0 && (
            <Link to="/dashboard" className="relative p-2 rounded-lg text-text-1 hover:text-text-0 hover:bg-bg-2"
              title={`${unseenAlerts} new blindspot alert${unseenAlerts > 1 ? 's' : ''}`} aria-label="Blindspot alerts">
              <Bell size={17} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-accent shadow-neon-sm" />
            </Link>
          )}
          {username && <span className="hidden sm:inline text-xs text-text-2 font-mono truncate max-w-[160px]">{username}</span>}
          <Link to="/settings" className="p-2 rounded-lg text-text-2 hover:text-accent hover:bg-bg-2 transition-colors" aria-label="Settings" title="Settings">
            <Settings size={17} />
          </Link>
        </div>
      </header>
      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  )
}
