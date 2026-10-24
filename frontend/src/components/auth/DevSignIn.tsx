import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Code2 } from 'lucide-react'
import { authApi } from '../../api/auth'
import { useAfterAuth } from './AuthPanel'

/**
 * Signs into the developer account and continues to `next` (the developer auth
 * skip, and the /dev link). If the backend refuses (FORKED_DEV_LOGIN=0), it falls
 * back to the normal sign-in page.
 */
export function DevSignIn({ next }: { next: string }) {
  const afterAuth = useAfterAuth()
  const [failed, setFailed] = useState(false)
  const started = useRef(false)          // StrictMode mounts twice in dev: sign in once

  useEffect(() => {
    if (started.current) return
    started.current = true
    authApi.devLogin()
      .then(res => afterAuth(res.token, res.user, next))
      .catch(() => setFailed(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (failed) return <Navigate to={`/auth?next=${encodeURIComponent(next)}`} replace />
  return (
    <div className="min-h-screen flex items-center justify-center" role="status">
      <div className="flex items-center gap-3 text-sm text-text-1">
        <Code2 size={16} className="text-accent" />
        Signing in as the developer…
        <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    </div>
  )
}
