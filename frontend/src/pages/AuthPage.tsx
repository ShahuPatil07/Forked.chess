import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { AuthPanel } from '../components/auth/AuthPanel'
import { ForkedLogo, ForkedWordmark } from '../components/layout/AppShell'
import { useUserStore } from '../store/userStore'

/** Standalone sign-in / sign-up page (also the redirect target for signed-out deep links). */
export default function AuthPage() {
  const [params] = useSearchParams()
  const { token, username } = useUserStore()
  const next = params.get('next')
  if (token && username) return <Navigate to={next && next.startsWith('/') ? next : '/home'} replace />
  return (
    <div className="min-h-full relative z-[1] flex flex-col">
      <header className="h-14 px-4 sm:px-6 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2" aria-label="Forked home">
          <ForkedLogo className="h-7 w-7" /><ForkedWordmark className="text-lg" />
        </Link>
        <Link to="/" className="text-xs text-text-2 hover:text-text-0 inline-flex items-center gap-1"><ArrowLeft size={13} /> Back</Link>
      </header>
      <main className="flex-1 grid place-items-center px-4 py-8">
        <div className="w-full max-w-md">
          <h1 className="font-display text-3xl font-semibold text-center">
            {params.get('mode') === 'register' ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="text-sm text-text-2 text-center mt-2 mb-6">Every move has a reason. Let's find yours.</p>
          <AuthPanel initialMode={params.get('mode') === 'register' ? 'register' : 'signin'} next={next} />
        </div>
      </main>
    </div>
  )
}
