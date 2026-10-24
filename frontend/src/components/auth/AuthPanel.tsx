import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowRight, Check, Code2, Eye, EyeOff, Loader2, Lock, Mail, Phone, User, AtSign, Crown } from 'lucide-react'
import { authApi } from '../../api/auth'
import { api } from '../../api'
import { useUserStore } from '../../store/userStore'
import type { Account, Platform } from '../../types'

type Mode = 'signin' | 'register'

const USER_ID_RE = /^[A-Za-z0-9_-]{3,30}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/
const CHESS_RE = /^[A-Za-z0-9_-]{2,40}$/
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/

function passwordScore(pw: string): { score: number; label: string } {
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 12) s++
  if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw) || /[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++
  return { score: s, label: ['Too short', 'Weak', 'Okay', 'Strong', 'Excellent'][s] }
}

/** After any successful sign-in: go to the app, importing games first for a brand-new chess account. */
export function useAfterAuth() {
  const navigate = useNavigate()
  const { signIn, setUser } = useUserStore()
  return async (token: string, account: Account, next?: string | null) => {
    signIn(token, account)
    // live rating in the background (also syncs the rating used across the app)
    fetch(`/api/ratings/${encodeURIComponent(account.chess_username)}?platform=${account.platform}`)
      .then(r => (r.ok ? r.json() : null))
      .then(r => { if (r?.primary_rating) setUser({ elo: r.primary_rating }) })
      .catch(() => undefined)
    try {
      const { has_profile } = await api.check(account.chess_username)
      if (!has_profile) {
        const { job_id } = await api.startIngest(account.chess_username, account.platform, 80)
        setUser({ activeJobId: job_id })
        navigate(`/loading/${job_id}`, { replace: true })
        return
      }
    } catch { /* the hub still works; the dashboard will offer the import */ }
    navigate(next && next.startsWith('/') ? next : '/home', { replace: true })
  }
}

function Field({ icon: Icon, label, hint, error, children }: {
  icon: typeof User; label: string; hint?: ReactNode; error?: string | null; children: ReactNode
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-[11px] font-medium text-text-1 mb-1.5">
        <span className="flex items-center gap-1.5"><Icon size={12} className="text-text-2" />{label}</span>
        {hint && <span className="text-text-2 font-normal">{hint}</span>}
      </span>
      {children}
      {error && <span className="block text-[11px] text-danger mt-1">{error}</span>}
    </label>
  )
}

export function AuthPanel({ initialMode = 'signin', next, compact = false }: {
  initialMode?: Mode; next?: string | null; compact?: boolean
}) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [devEnabled, setDevEnabled] = useState(false)
  const [devUser, setDevUser] = useState<string | null>(null)
  const [busy, setBusy] = useState<'form' | 'dev' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const afterAuth = useAfterAuth()

  // sign in
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  // register
  const [name, setName] = useState('')
  const [userId, setUserId] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [platform, setPlatform] = useState<Platform>('chesscom')
  const [chessUser, setChessUser] = useState('')

  useEffect(() => {
    authApi.config().then(c => { setDevEnabled(c.dev_login); setDevUser(c.dev_user) }).catch(() => undefined)
  }, [])
  useEffect(() => { setError(null); setTouched(false) }, [mode])

  const problems = useMemo(() => mode === 'signin' ? {} : {
    name: name.trim() ? null : 'Enter your name',
    userId: USER_ID_RE.test(userId) ? null : '3–30 letters, numbers, _ or -',
    email: EMAIL_RE.test(email.trim()) ? null : 'Enter a valid email',
    phone: !phone.trim() || PHONE_RE.test(phone.trim()) ? null : 'Digits only (a leading + is fine)',
    password: password.length < 8 ? 'At least 8 characters'
      : !(/[A-Za-z]/.test(password) && /\d/.test(password)) ? 'Use a letter and a number' : null,
    chessUser: CHESS_RE.test(chessUser.trim()) ? null : 'Your Chess.com or Lichess username',
  } as Record<string, string | null>, [mode, name, userId, email, phone, password, chessUser])
  const show = (k: string) => (touched ? (problems as Record<string, string | null>)[k] ?? null : null)
  const pw = passwordScore(password)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true); setError(null)
    if (mode === 'register' && Object.values(problems).some(Boolean)) return
    if (mode === 'signin' && (!identifier.trim() || !password)) { setError('Enter your user ID or email and your password.'); return }
    setBusy('form')
    try {
      const res = mode === 'signin'
        ? await authApi.login(identifier.trim(), password)
        : await authApi.register({ name: name.trim(), user_id: userId.trim(), email: email.trim(),
                                   phone: phone.trim() || undefined, password, platform, chess_username: chessUser.trim() })
      await afterAuth(res.token, res.user, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
    } finally { setBusy(null) }
  }

  async function developer() {
    setBusy('dev'); setError(null)
    try {
      const res = await authApi.devLogin()
      await afterAuth(res.token, res.user, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Developer sign-in is unavailable.')
    } finally { setBusy(null) }
  }

  return (
    <div className={`w-full ${compact ? '' : 'max-w-md'} mx-auto`}>
      <div className="card p-5 sm:p-6 bg-bg-1/90 backdrop-blur-xl border-border relative overflow-hidden">
        <div aria-hidden className="absolute -top-24 -right-24 w-56 h-56 rounded-full bg-accent/10 blur-3xl" />
        {/* tabs */}
        <div className="relative grid grid-cols-2 p-1 rounded-xl bg-bg-2 border border-border mb-5" role="tablist">
          {(['signin', 'register'] as Mode[]).map(m => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
              className={`relative z-10 py-2 text-sm font-semibold rounded-lg transition-colors ${mode === m ? 'text-accent-ink' : 'text-text-1 hover:text-text-0'}`}>
              {mode === m && <motion.span layoutId="auth-tab" className="absolute inset-0 -z-10 rounded-lg bg-accent shadow-neon-sm" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
              {m === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="relative space-y-3.5" noValidate>
          <AnimatePresence mode="wait" initial={false}>
            {mode === 'signin' ? (
              <motion.div key="signin" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} className="space-y-3.5">
                <Field icon={AtSign} label="User ID or email">
                  <input className="input" autoComplete="username" value={identifier} onChange={e => setIdentifier(e.target.value)} placeholder="your_user_id" autoFocus={!compact} />
                </Field>
                <Field icon={Lock} label="Password">
                  <PasswordInput value={password} onChange={setPassword} show={showPw} setShow={setShowPw} autoComplete="current-password" />
                </Field>
              </motion.div>
            ) : (
              <motion.div key="register" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} className="space-y-3.5">
                <div className="grid sm:grid-cols-2 gap-3.5">
                  <Field icon={User} label="Full name" error={show('name')}>
                    <input className="input" autoComplete="name" value={name} onChange={e => setName(e.target.value)} placeholder="Magnus Carlsen" />
                  </Field>
                  <Field icon={AtSign} label="User ID" error={show('userId')}>
                    <input className="input" autoComplete="username" value={userId} onChange={e => setUserId(e.target.value)} placeholder="magnus_c" />
                  </Field>
                </div>
                <Field icon={Mail} label="Email" error={show('email')}>
                  <input className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" />
                </Field>
                <Field icon={Phone} label="Phone" hint="optional" error={show('phone')}>
                  <input className="input" type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 98765 43210" />
                </Field>
                <Field icon={Lock} label="Password" error={show('password')}
                  hint={password ? <span className={pw.score >= 3 ? 'text-success' : pw.score >= 2 ? 'text-text-1' : 'text-warn'}>{pw.label}</span> : '8+ chars, a letter & a number'}>
                  <PasswordInput value={password} onChange={setPassword} show={showPw} setShow={setShowPw} autoComplete="new-password" />
                  <div className="flex gap-1 mt-1.5" aria-hidden>
                    {[0, 1, 2, 3].map(i => <span key={i} className={`h-1 flex-1 rounded-full transition-colors ${i < pw.score ? (pw.score >= 3 ? 'bg-accent' : 'bg-warn') : 'bg-bg-3'}`} />)}
                  </div>
                </Field>
                <Field icon={Crown} label="Your chess account" error={show('chessUser')} hint="we analyse its public games">
                  <div className="flex gap-2">
                    <div className="grid grid-cols-2 p-0.5 rounded-lg bg-bg-2 border border-border flex-shrink-0">
                      {(['chesscom', 'lichess'] as Platform[]).map(p => (
                        <button type="button" key={p} onClick={() => setPlatform(p)}
                          className={`px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors ${platform === p ? 'bg-bg-3 text-accent' : 'text-text-2 hover:text-text-0'}`}>
                          {p === 'chesscom' ? 'Chess.com' : 'Lichess'}
                        </button>
                      ))}
                    </div>
                    <input className="input" value={chessUser} onChange={e => setChessUser(e.target.value)} placeholder={platform === 'chesscom' ? 'chess.com username' : 'lichess username'} />
                  </div>
                </Field>
              </motion.div>
            )}
          </AnimatePresence>

          {error && <p role="alert" className="text-xs text-danger bg-danger/10 border border-danger/25 rounded-lg px-3 py-2">{error}</p>}

          <button className="btn-primary w-full py-2.5 inline-flex items-center justify-center gap-2" disabled={busy !== null}>
            {busy === 'form' ? <Loader2 size={15} className="animate-spin" /> : mode === 'signin' ? <ArrowRight size={15} /> : <Check size={15} />}
            {mode === 'signin' ? 'Sign in' : 'Create account & analyse my games'}
          </button>
          <p className="text-[11px] text-text-2 text-center">
            {mode === 'signin'
              ? <>New to Forked? <button type="button" className="text-accent hover:underline" onClick={() => setMode('register')}>Create an account</button></>
              : <>Already have one? <button type="button" className="text-accent hover:underline" onClick={() => setMode('signin')}>Sign in</button></>}
          </p>
        </form>
      </div>

      {devEnabled && (
        <div className="mt-3 rounded-xl border border-dashed border-border bg-bg-1/70 p-3.5 flex items-center gap-3">
          <span className="w-8 h-8 rounded-lg grid place-items-center bg-bg-2 border border-border text-text-1 flex-shrink-0"><Code2 size={15} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-text-0">Developer option</p>
            <p className="text-[11px] text-text-2 truncate">Skip sign-up and open the existing {devUser ?? 'developer'} account.</p>
          </div>
          <button type="button" onClick={() => void developer()} disabled={busy !== null}
            className="btn-ghost border border-border text-xs inline-flex items-center gap-1.5 flex-shrink-0">
            {busy === 'dev' ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}{devUser ?? 'Continue'}
          </button>
        </div>
      )}
    </div>
  )
}

function PasswordInput({ value, onChange, show, setShow, autoComplete }: {
  value: string; onChange: (v: string) => void; show: boolean; setShow: (v: boolean) => void; autoComplete: string
}) {
  return (
    <div className="relative">
      <input className="input pr-10" type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value}
        onChange={e => onChange(e.target.value)} placeholder="••••••••" />
      <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-text-2 hover:text-text-0">
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  )
}
