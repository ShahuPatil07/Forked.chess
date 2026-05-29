import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Sword, Clock, Settings, ChevronRight, Microscope, Bot, BookOpen } from 'lucide-react'
import { motion } from 'framer-motion'
import { useUserStore } from '../../store/userStore'

const NAV = [
  { to: '/dashboard', label: 'Dashboard',      icon: LayoutDashboard },
  { to: '/session',   label: 'Drill Session',  icon: Sword },
  { to: '/openings',  label: 'Openings',       icon: BookOpen },
  { to: '/analysis',  label: 'Analysis Board', icon: Microscope },
  { to: '/history',   label: 'History',        icon: Clock },
  { to: '/settings',  label: 'Settings',       icon: Settings },
]

// ── Forked wordmark — unique brand treatment used everywhere ──────────────────
export function ForkedWordmark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`font-black tracking-tight select-none ${className}`}
      style={{
        background: 'linear-gradient(135deg, #c4b5fd 0%, #7B61FF 45%, #a78bfa 100%)',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        backgroundClip: 'text',
        letterSpacing: '-0.03em',
      }}
    >
      Forked
    </span>
  )
}

export default function AppShell() {
  const { username } = useUserStore()
  const navigate     = useNavigate()

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-[220px] flex-shrink-0 flex flex-col border-r border-border bg-bg-0 h-screen sticky top-0">
        {/* Logo */}
        <div className="px-5 py-4 border-b border-border">
          <img src="/logo.png" alt="Forked" className="h-9 w-auto mb-1" />
          <ForkedWordmark className="text-sm" />
          <p className="text-xs text-text-2 mt-0.5 leading-tight">{username}</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-all duration-100 group
                 ${isActive ? 'bg-accent/15 text-accent' : 'text-text-1 hover:text-text-0 hover:bg-bg-2'}`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={16} className={isActive ? 'text-accent' : 'text-text-2 group-hover:text-text-1'} />
                  {label}
                  {isActive && <ChevronRight size={12} className="ml-auto text-accent/60" />}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Play vs Maia — glowing CTA */}
        <div className="px-3 pb-3">
          <motion.div
            animate={{ boxShadow: ['0 0 8px rgba(123,97,255,0.3)', '0 0 18px rgba(123,97,255,0.55)', '0 0 8px rgba(123,97,255,0.3)'] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            className="rounded-lg"
          >
            <button
              onClick={() => navigate('/bot-game')}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold
                         bg-accent/10 border border-accent/30 text-accent
                         hover:bg-accent/20 hover:border-accent/50 transition-all duration-150"
            >
              <Bot size={16} className="text-accent flex-shrink-0" />
              Play vs Maia
            </button>
          </motion.div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border">
          <p className="text-xs text-text-2"><ForkedWordmark className="text-xs" /> v0.1</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-bg-0 min-h-screen">
        <Outlet />
      </main>
    </div>
  )
}
