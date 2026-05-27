import { Outlet, NavLink } from 'react-router-dom'
import { LayoutDashboard, Sword, Clock, Settings, ChevronRight, Microscope } from 'lucide-react'
import { useUserStore } from '../../store/userStore'

const NAV = [
  { to: '/dashboard', label: 'Dashboard',      icon: LayoutDashboard },
  { to: '/session',   label: 'Drill Session',  icon: Sword },
  { to: '/analysis',  label: 'Analysis Board', icon: Microscope },
  { to: '/history',   label: 'History',        icon: Clock },
  { to: '/settings',  label: 'Settings',       icon: Settings },
]

export default function AppShell() {
  const { username } = useUserStore()
  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-[220px] flex-shrink-0 flex flex-col border-r border-border bg-bg-0 h-screen sticky top-0">
        {/* Logo */}
        <div className="px-5 py-4 border-b border-border">
          <img
            src="/logo.png"
            alt="Forked"
            className="h-10 w-auto mb-2"
          />
          <p className="text-xs text-text-2 leading-tight">{username}</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-all duration-100 group
                 ${isActive
                   ? 'bg-accent/15 text-accent'
                   : 'text-text-1 hover:text-text-0 hover:bg-bg-2'}`
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

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border">
          <p className="text-xs text-text-2">Forked v0.1</p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-bg-0 min-h-screen">
        <Outlet />
      </main>
    </div>
  )
}
