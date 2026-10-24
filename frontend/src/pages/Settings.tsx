import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, Check, KeyRound, Loader2, LogOut, RefreshCw, Save, Settings as SettingsIcon, ShieldCheck, User, Crown, Gauge,
} from 'lucide-react'
import { SectionHeader, SectionHeaderStat } from '../components/layout/SectionHeader'
import { useUserStore } from '../store/userStore'
import { api } from '../api'
import { authApi } from '../api/auth'
import { platformName, bothScales } from '../lib/ratings'
import type { Platform } from '../types'
import { pauseDevSkip } from '../lib/devAuth'

interface RatingsResponse {
  platform: Platform
  ratings: Record<string, { rating: number | null; games: number; best: number | null; provisional: boolean }>
  primary: string | null
  primary_rating: number | null
  most_played: string | null
  fetched_at: number
  stale?: boolean
}

function Section({ icon: Icon, title, description, children, tone }: {
  icon: typeof User; title: string; description?: string; children: ReactNode; tone?: 'danger'
}) {
  return (
    <section className={`card p-5 ${tone === 'danger' ? 'border-danger/20' : ''}`}>
      <div className="flex items-start gap-3 mb-4">
        <span className={`w-8 h-8 rounded-lg grid place-items-center flex-shrink-0 ${tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent'}`}><Icon size={15} /></span>
        <div><h2 className="text-sm font-semibold text-text-0">{title}</h2>{description && <p className="text-xs text-text-2 mt-0.5">{description}</p>}</div>
      </div>
      {children}
    </section>
  )
}

function Status({ state }: { state: { ok?: string; err?: string } }) {
  if (state.err) return <p className="text-xs text-danger flex items-center gap-1.5 mt-3"><AlertCircle size={12} />{state.err}</p>
  if (state.ok) return <p className="text-xs text-success flex items-center gap-1.5 mt-3"><Check size={12} />{state.ok}</p>
  return null
}

export default function Settings() {
  const { account, token, username, platform, elo, signIn, setUser, clearUser } = useUserStore()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  // ── account ──────────────────────────────────────────────────────────────
  const [name, setName] = useState(account?.name ?? '')
  const [email, setEmail] = useState(account?.email ?? '')
  const [phone, setPhone] = useState(account?.phone ?? '')
  const [acctBusy, setAcctBusy] = useState(false)
  const [acctState, setAcctState] = useState<{ ok?: string; err?: string }>({})
  useEffect(() => { setName(account?.name ?? ''); setEmail(account?.email ?? ''); setPhone(account?.phone ?? '') }, [account])

  async function saveAccount() {
    if (!token) return
    setAcctBusy(true); setAcctState({})
    try {
      const { user } = await authApi.update({ name, email, phone })
      signIn(token, user)
      setAcctState({ ok: 'Saved.' })
    } catch (e) { setAcctState({ err: e instanceof Error ? e.message : 'Could not save.' }) }
    finally { setAcctBusy(false) }
  }

  // ── chess account ────────────────────────────────────────────────────────
  const [chessPlatform, setChessPlatform] = useState<Platform>(account?.platform ?? platform)
  const [chessUser, setChessUser] = useState(account?.chess_username ?? username)
  const [chessBusy, setChessBusy] = useState(false)
  const [chessState, setChessState] = useState<{ ok?: string; err?: string }>({})
  const chessChanged = chessPlatform !== (account?.platform ?? platform) || chessUser.trim() !== (account?.chess_username ?? username)

  async function saveChess() {
    if (!token) return
    setChessBusy(true); setChessState({})
    try {
      const { user } = await authApi.update({ platform: chessPlatform, chess_username: chessUser.trim() })
      signIn(token, user)
      queryClient.clear()
      const { has_profile } = await api.check(user.chess_username)
      if (!has_profile) {
        const { job_id } = await api.startIngest(user.chess_username, user.platform, 80)
        setUser({ activeJobId: job_id })
        navigate(`/loading/${job_id}`)
        return
      }
      setChessState({ ok: `Linked to ${platformName(user.platform)} · ${user.chess_username}.` })
    } catch (e) { setChessState({ err: e instanceof Error ? e.message : 'Could not link that account.' }) }
    finally { setChessBusy(false) }
  }

  const { data: ratings, isFetching: ratingsLoading, refetch: refetchRatings } = useQuery<RatingsResponse | null>({
    queryKey: ['ratings-settings', username, platform],
    queryFn: async () => {
      const r = await fetch(`/api/ratings/${encodeURIComponent(username)}?platform=${platform}`)
      return r.ok ? r.json() : null
    },
    enabled: !!username, staleTime: 5 * 60_000, retry: false,
  })

  // ── rating used in-app ───────────────────────────────────────────────────
  const { data: settings, refetch: refetchSettings } = useQuery({
    queryKey: ['settings', username], queryFn: () => api.getSettings(username), enabled: !!username,
  })
  const [manual, setManual] = useState(false)
  const [manualElo, setManualElo] = useState(elo)
  const [eloState, setEloState] = useState<{ ok?: string; err?: string }>({})
  useEffect(() => { if (settings) { setManual(!!settings.elo_manual); setManualElo(settings.elo) } }, [settings])

  async function saveElo() {
    setEloState({})
    try {
      if (manual) {
        const s = await api.updateSettings(username, { elo: manualElo, elo_manual: true })
        setUser({ elo: s.elo })
      } else {
        await api.updateSettings(username, { elo_manual: false })
        const r = await fetch(`/api/ratings/${encodeURIComponent(username)}?platform=${platform}&refresh=1`).then(x => x.json())
        if (r?.primary_rating) setUser({ elo: r.primary_rating })
      }
      await refetchSettings(); await refetchRatings()
      setEloState({ ok: 'Saved.' })
    } catch (e) { setEloState({ err: e instanceof Error ? e.message : 'Could not save.' }) }
  }

  // ── password ─────────────────────────────────────────────────────────────
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwState, setPwState] = useState<{ ok?: string; err?: string }>({})
  async function changePw() {
    setPwState({})
    try { await authApi.changePassword(curPw, newPw); setCurPw(''); setNewPw(''); setPwState({ ok: 'Password changed.' }) }
    catch (e) { setPwState({ err: e instanceof Error ? e.message : 'Could not change the password.' }) }
  }

  async function reanalyse() {
    try {
      const { job_id } = await api.startIngest(username, platform, 80)
      setUser({ activeJobId: job_id })
      queryClient.clear()
      navigate(`/loading/${job_id}`)
    } catch (err) { alert(err instanceof Error ? err.message : 'Failed to start re-analysis') }
  }

  async function signOut() {
    await authApi.logout()
    pauseDevSkip()
    clearUser(); queryClient.clear()
    navigate('/', { replace: true })
  }

  const fmts = ['rapid', 'blitz', 'bullet', 'classical', 'daily'].filter(f => ratings?.ratings?.[f])

  return (
    <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-3xl mx-auto">
      <SectionHeader icon={SettingsIcon} title="Settings"
        description="Your account, your linked chess account, and the rating Forked uses for you."
        right={<SectionHeaderStat label="Signed in as" value={`@${account?.user_id ?? username}`} />} />

      <div className="space-y-5">
        <Section icon={User} title="Account" description={account?.is_dev ? 'Developer account (signed in through the developer option).' : 'How you sign in and how we reach you.'}>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block"><span className="text-[11px] text-text-2">Full name</span>
              <input className="input mt-1" value={name} onChange={e => setName(e.target.value)} /></label>
            <label className="block"><span className="text-[11px] text-text-2">User ID</span>
              <input className="input mt-1 opacity-70" value={account?.user_id ?? ''} disabled /></label>
            <label className="block"><span className="text-[11px] text-text-2">Email</span>
              <input className="input mt-1" type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
            <label className="block"><span className="text-[11px] text-text-2">Phone <span className="text-text-2/70">(optional)</span></span>
              <input className="input mt-1" type="tel" value={phone ?? ''} onChange={e => setPhone(e.target.value)} /></label>
          </div>
          <div className="flex justify-end mt-4">
            <button className="btn-primary text-sm inline-flex items-center gap-2" onClick={() => void saveAccount()} disabled={acctBusy || !token}>
              {acctBusy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save account
            </button>
          </div>
          <Status state={acctState} />
        </Section>

        <Section icon={Crown} title="Linked chess account" description="Forked analyses this account's public games. Changing it switches your dashboard to the new account.">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="grid grid-cols-2 p-0.5 rounded-lg bg-bg-2 border border-border flex-shrink-0">
              {(['chesscom', 'lichess'] as Platform[]).map(p => (
                <button key={p} type="button" onClick={() => setChessPlatform(p)}
                  className={`px-3 py-1.5 rounded-md text-xs font-semibold ${chessPlatform === p ? 'bg-bg-3 text-accent' : 'text-text-2 hover:text-text-0'}`}>{platformName(p)}</button>
              ))}
            </div>
            <input className="input" value={chessUser} onChange={e => setChessUser(e.target.value)} />
            <button className="btn-ghost border border-border text-sm whitespace-nowrap inline-flex items-center gap-1.5" disabled={!chessChanged || chessBusy || !token}
              onClick={() => void saveChess()}>{chessBusy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Link</button>
          </div>
          <Status state={chessState} />

          <div className="mt-5 flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-wider text-text-2">Live ratings · {platformName(platform)}</p>
            <button className="text-[11px] text-text-2 hover:text-accent inline-flex items-center gap-1" onClick={() => void fetch(`/api/ratings/${encodeURIComponent(username)}?platform=${platform}&refresh=1`).then(() => refetchRatings())}>
              <RefreshCw size={11} className={ratingsLoading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
            {fmts.length ? fmts.map(f => {
              const r = ratings!.ratings[f]
              return (
                <div key={f} className={`rounded-xl border px-3 py-2.5 ${ratings!.primary === f ? 'border-accent/40 bg-accent/[0.06]' : 'border-border bg-bg-2/60'}`}>
                  <p className="text-[10px] uppercase tracking-wider text-text-2 flex items-center justify-between">{f}{ratings!.primary === f && <span className="text-accent normal-case tracking-normal">used</span>}</p>
                  <p className="font-display text-xl font-semibold text-text-0 tabular-nums mt-0.5">{r.rating ?? '—'}{r.provisional ? '?' : ''}</p>
                  <p className="text-[10px] text-text-2">{r.games.toLocaleString()} games{r.best ? ` · best ${r.best}` : ''}</p>
                </div>
              )
            }) : <p className="text-xs text-text-2 col-span-4">{ratingsLoading ? 'Fetching ratings…' : 'No ratings found for this account yet.'}</p>}
          </div>
        </Section>

        <Section icon={Gauge} title="Rating Forked uses for you" description="Puzzle difficulty, Maia's default level and the rating-impact estimate all use this number.">
          <div className="space-y-2">
            <label className="flex items-start gap-3 p-3 rounded-xl border border-border hover:border-accent/30 cursor-pointer">
              <input type="radio" className="mt-0.5 accent-[#C8FF2A]" checked={!manual} onChange={() => setManual(false)} />
              <span><span className="text-sm text-text-0">Automatic — my live rapid rating</span>
                <span className="block text-xs text-text-2 mt-0.5">{ratings?.primary_rating ? bothScales(ratings.primary_rating, platform) : 'Updated hourly from ' + platformName(platform)}</span></span>
            </label>
            <label className="flex items-start gap-3 p-3 rounded-xl border border-border hover:border-accent/30 cursor-pointer">
              <input type="radio" className="mt-0.5 accent-[#C8FF2A]" checked={manual} onChange={() => setManual(true)} />
              <span className="flex-1"><span className="text-sm text-text-0">Set it myself</span>
                {manual && <input type="number" min={400} max={3200} step={25} className="input mt-2 max-w-[160px]" value={manualElo} onChange={e => setManualElo(Number(e.target.value))} />}</span>
            </label>
          </div>
          <div className="flex justify-end mt-4"><button className="btn-primary text-sm inline-flex items-center gap-2" onClick={() => void saveElo()}><Save size={14} /> Save</button></div>
          <Status state={eloState} />
        </Section>

        {!account?.is_dev && (
          <Section icon={KeyRound} title="Password">
            <div className="grid sm:grid-cols-2 gap-3">
              <input className="input" type="password" placeholder="Current password" autoComplete="current-password" value={curPw} onChange={e => setCurPw(e.target.value)} />
              <input className="input" type="password" placeholder="New password (8+, letter & number)" autoComplete="new-password" value={newPw} onChange={e => setNewPw(e.target.value)} />
            </div>
            <div className="flex justify-end mt-4"><button className="btn-ghost border border-border text-sm inline-flex items-center gap-2" disabled={!curPw || !newPw} onClick={() => void changePw()}><ShieldCheck size={14} /> Change password</button></div>
            <Status state={pwState} />
          </Section>
        )}

        <Section icon={RefreshCw} title="Re-analyse games" description="Pull your latest rapid games and rebuild your blindspot profile from scratch." tone="danger">
          <button onClick={() => void reanalyse()} className="btn-ghost flex items-center gap-2 text-sm w-full justify-center border border-danger/30 text-danger hover:bg-danger/10">
            <RefreshCw size={13} /> Re-analyse my games
          </button>
        </Section>

        <button onClick={() => void signOut()} className="w-full card p-4 flex items-center justify-center gap-2 text-sm text-text-1 hover:text-danger hover:border-danger/30 transition-colors">
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </div>
  )
}
