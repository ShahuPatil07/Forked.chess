import { useQuery } from '@tanstack/react-query'
import { BarChart3, FlaskConical, Loader2, RefreshCw } from 'lucide-react'
import { SectionHeader, SectionHeaderStat } from '../../components/layout/SectionHeader'
import { warmupApi, type ActivityId, type ArmAgg, type Lab } from './api'
import { META, TC_LABEL, fmtMs, pct } from './meta'

const BAND_LABEL: Record<string, string> = { u800: 'Under 800', '800-1200': '800–1200', '1200-1600': '1200–1600', '1600-2000': '1600–2000', '2000+': '2000+' }

/** Internal dashboard (hidden route /warmup/lab): warm-up vs control, randomized games only, by band / time control. */
export default function WarmupLab() {
  const q = useQuery<Lab>({ queryKey: ['warmup-lab'], queryFn: warmupApi.lab, refetchInterval: 60_000 })
  const d = q.data
  return (
    <div className="max-w-6xl mx-auto px-4 lg:px-8 pt-6 pb-16">
      <SectionHeader icon={FlaskConical} title="Warm-Up Lab"
        description="Internal. Randomized comparison of games played after a warm-up vs. straight away (control). Blunders = Stockfish quick review, per 40 of the player's moves."
        right={d && <SectionHeaderStat label="Needed per arm" value={`${d.min_games_per_arm} games`} />} />
      {q.isLoading && <p className="text-text-2 inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" />Loading…</p>}
      {q.error && <p className="text-danger text-sm">{String(q.error)}</p>}
      {d && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {([['Moments', d.counts.moments], ['In experiment', d.counts.experiment_moments], ['Sessions', d.counts.sessions],
               ['Drill items', d.counts.events], ['Linked games', d.counts.games]] as [string, number][]).map(([k, v]) => (
              <div key={k} className="rounded-2xl border border-border bg-bg-1 px-4 py-3">
                <p className="text-[10px] uppercase tracking-wider text-text-2">{k}</p>
                <p className="font-display text-2xl font-semibold text-text-0 tabular-nums mt-0.5">{v ?? 0}</p>
              </div>
            ))}
          </div>

          <Card title="Overall (randomized only)">
            <ArmTable rows={[['All players', d.groups.overall]]} min={d.min_games_per_arm} />
          </Card>
          <div className="grid lg:grid-cols-2 gap-5">
            <Card title="By rating band">
              <ArmTable rows={Object.entries(d.groups.by_band).map(([b, g]) => [BAND_LABEL[b] ?? b, g])} min={d.min_games_per_arm} />
            </Card>
            <Card title="By time control (of the game played)">
              <ArmTable rows={Object.entries(d.groups.by_time_control).map(([t, g]) => [TC_LABEL[t] ?? t, g])} min={d.min_games_per_arm} />
            </Card>
          </div>
          <div className="grid lg:grid-cols-2 gap-5">
            <Card title="Warm-up games by drill included" note="Observational: drills were not randomized individually.">
              <SimpleTable rows={Object.entries(d.groups.warmup_games_by_drill).map(([k, a]) => [META[k as ActivityId]?.title ?? k, a])} />
            </Card>
            <Card title="Not in the experiment" note="Warm-ups by players who did not opt in. Not comparable to control.">
              <SimpleTable rows={Object.entries(d.groups.observational).map(([k, a]) => [k.replace(/_/g, ' '), a])} />
            </Card>
          </div>

          <Card title="Drill performance" note="Accuracy should sit around 80–90%. Much lower means the drill is too hard for that band.">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-[11px] uppercase tracking-wider text-text-2 text-left">
                  <th className="py-2 pr-3 font-medium">Drill</th><th className="py-2 pr-3 font-medium text-right">Items</th>
                  <th className="py-2 pr-3 font-medium text-right">Accuracy</th><th className="py-2 pr-3 font-medium text-right">Median time</th>
                  <th className="py-2 font-medium">By band</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {Object.entries(d.drills).map(([k, x]) => (
                    <tr key={k}>
                      <td className="py-2 pr-3 text-text-0">{META[k as ActivityId]?.title ?? k}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-text-1">{x.items}</td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${x.accuracy < .7 ? 'text-warn' : 'text-text-0'}`}>{pct(x.accuracy)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-text-1">{fmtMs(x.median_ms)}</td>
                      <td className="py-2 text-[11px] text-text-2">{Object.entries(x.by_band).map(([b, a]) => `${BAND_LABEL[b] ?? b} ${pct(a)}`).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!Object.keys(d.drills).length && <p className="text-sm text-text-2 py-3">No drill items logged yet.</p>}
            </div>
          </Card>
          <button onClick={() => q.refetch()} className="btn-ghost border border-border mt-6 inline-flex items-center gap-1.5"><RefreshCw size={13} />Refresh</button>
        </>
      )}
    </div>
  )
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 rounded-2xl border border-border bg-bg-1 p-5">
      <h2 className="font-display font-semibold text-text-0 flex items-center gap-2"><BarChart3 size={15} className="text-accent" />{title}</h2>
      {note && <p className="text-[11px] text-text-2 mt-0.5">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

const f2 = (x: number | null) => (x == null ? '–' : x.toFixed(2))
const f1 = (x: number | null) => (x == null ? '–' : `${x.toFixed(1)}%`)

function ArmTable({ rows, min }: { rows: [string, Record<'warmup' | 'control', ArmAgg>][]; min: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-[11px] uppercase tracking-wider text-text-2 text-left">
          <th className="py-2 pr-3 font-medium">Group</th>
          <th className="py-2 pr-3 font-medium text-right">Warm-up games</th><th className="py-2 pr-3 font-medium text-right">Blunders/40</th>
          <th className="py-2 pr-3 font-medium text-right">Control games</th><th className="py-2 pr-3 font-medium text-right">Blunders/40</th>
          <th className="py-2 font-medium text-right">Difference</th>
        </tr></thead>
        <tbody className="divide-y divide-border">
          {rows.map(([name, g]) => {
            const enough = g.warmup.games >= min && g.control.games >= min
            const diff = g.warmup.blunders_per40 != null && g.control.blunders_per40 != null ? g.warmup.blunders_per40 - g.control.blunders_per40 : null
            return (
              <tr key={name}>
                <td className="py-2 pr-3 text-text-0">{name}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-text-1">{g.warmup.games}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-text-0">{f2(g.warmup.blunders_per40)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-text-1">{g.control.games}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-text-0">{f2(g.control.blunders_per40)}</td>
                <td className="py-2 text-right tabular-nums">
                  {enough && diff != null
                    ? <span className={diff < 0 ? 'text-accent' : 'text-warn'}>{diff > 0 ? '+' : ''}{diff.toFixed(2)}</span>
                    : <span className="text-[11px] text-text-2">not enough data</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SimpleTable({ rows }: { rows: [string, ArmAgg][] }) {
  if (!rows.length) return <p className="text-sm text-text-2">No linked games yet.</p>
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-[11px] uppercase tracking-wider text-text-2 text-left">
        <th className="py-2 pr-3 font-medium">Group</th><th className="py-2 pr-3 font-medium text-right">Games</th>
        <th className="py-2 pr-3 font-medium text-right">Blunders/40</th><th className="py-2 font-medium text-right">Accuracy</th>
      </tr></thead>
      <tbody className="divide-y divide-border">
        {rows.map(([k, a]) => (
          <tr key={k}>
            <td className="py-2 pr-3 text-text-0 capitalize">{k}</td>
            <td className="py-2 pr-3 text-right tabular-nums text-text-1">{a.games}</td>
            <td className="py-2 pr-3 text-right tabular-nums text-text-0">{f2(a.blunders_per40)}</td>
            <td className="py-2 text-right tabular-nums text-text-1">{f1(a.accuracy)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
