/**
 * Dashboard charts. Rules (see the dataviz notes in theme.ts / CHART):
 *  - one y-axis per chart, never dual axes;
 *  - "You" vs "Players you faced" use the validated CHART.you / CHART.peer pair,
 *    with a legend and a dashed peer line as the secondary encoding;
 *  - thin marks (≤24px bars, 4px rounded ends, 2px lines), solid hairline grid;
 *  - every chart has a hover tooltip AND a table view (the Table toggle).
 */
import { useState, type ReactNode } from 'react'
import {
  Area, Bar, CartesianGrid, ComposedChart, Line, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis, BarChart, Cell, ReferenceLine, Scatter,
} from 'recharts'
import { Table2, BarChart3 } from 'lucide-react'
import { CHART } from '../../theme'
import type { Insights } from '../../api/insights'

const AXIS = { fill: CHART.axis, fontSize: 11 }
const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`)

// ── frame ─────────────────────────────────────────────────────────────────────

export interface TableSpec { columns: string[]; rows: (string | number | null)[][] }

export function ChartCard({ title, subtitle, legend, table, right, children, className = '' }: {
  title: string; subtitle?: ReactNode; legend?: { label: string; color: string; dashed?: boolean }[]
  table?: TableSpec; right?: ReactNode; children: ReactNode; className?: string
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <section className={`card p-4 sm:p-5 min-w-0 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-0">{title}</h3>
          {subtitle && <p className="text-xs text-text-2 mt-1 leading-relaxed">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {right}
          {table && (
            <button onClick={() => setAsTable(t => !t)} title={asTable ? 'Show chart' : 'Show as table'} aria-pressed={asTable}
              className="p-1.5 rounded-md text-text-2 hover:text-text-0 hover:bg-bg-2">
              {asTable ? <BarChart3 size={14} /> : <Table2 size={14} />}
            </button>
          )}
        </div>
      </div>
      {legend && legend.length > 1 && !asTable && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
          {legend.map(l => (
            <span key={l.label} className="inline-flex items-center gap-1.5 text-[11px] text-text-1">
              <svg width="18" height="8" aria-hidden><line x1="1" x2="17" y1="4" y2="4" stroke={l.color} strokeWidth="2.5" strokeDasharray={l.dashed ? '4 3' : undefined} strokeLinecap="round" /></svg>
              {l.label}
            </span>
          ))}
        </div>
      )}
      <div className="mt-3">
        {asTable && table ? <DataTable spec={table} /> : children}
      </div>
    </section>
  )
}

function DataTable({ spec }: { spec: TableSpec }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-bg-2">
          <tr>{spec.columns.map(c => <th key={c} className="text-left font-medium text-text-2 px-3 py-2">{c}</th>)}</tr>
        </thead>
        <tbody>
          {spec.rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              {r.map((v, j) => <td key={j} className={`px-3 py-1.5 ${j ? 'tabular-nums text-text-0' : 'text-text-1'}`}>{v ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Tip({ title, rows }: { title: ReactNode; rows: { label: string; value: ReactNode; color?: string }[] }) {
  return (
    <div className="rounded-lg border border-border bg-bg-2/95 backdrop-blur px-3 py-2 text-xs shadow-xl min-w-[150px]">
      <p className="text-text-2 mb-1">{title}</p>
      {rows.map(r => (
        <p key={r.label} className="flex items-center justify-between gap-4 text-text-1">
          <span className="inline-flex items-center gap-1.5">{r.color && <span className="w-2 h-2 rounded-full" style={{ background: r.color }} />}{r.label}</span>
          <span className="text-text-0 font-semibold tabular-nums">{r.value}</span>
        </p>
      ))}
    </div>
  )
}

function Toggle<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex p-0.5 rounded-lg bg-bg-2 border border-border">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)}
          className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${value === v ? 'bg-bg-3 text-text-0' : 'text-text-2 hover:text-text-1'}`}>{l}</button>
      ))}
    </div>
  )
}

// ── 1. mistake probability across the game ──────────────────────────────────

export function ProgressHistogram({ data }: { data: Insights['progress'] }) {
  const [mode, setMode] = useState<'errors' | 'blunders'>('errors')
  const rows = data.map(d => ({
    label: d.label, x: d.x,
    you: +(100 * (mode === 'errors' ? d.you_p : d.you_p_blunder)).toFixed(2),
    peer: +(100 * (mode === 'errors' ? d.peer_p : d.peer_p_blunder)).toFixed(2),
    moves: d.you_moves, m: d.you_mistakes, b: d.you_blunders, inn: d.you_inaccuracies,
  }))
  const worst = rows.reduce((a, b) => (b.you > a.you ? b : a), rows[0])
  return (
    <ChartCard
      title="When your games go wrong"
      subtitle={<>Chance that a move is a {mode === 'errors' ? 'mistake or blunder' : 'blunder'}, by how far through the game it is (every game stretched to 0–100%). Peak: <span className="text-text-0">{worst?.label}</span> at <span className="text-text-0">{worst?.you}%</span>.</>}
      legend={[{ label: 'You', color: CHART.you }, { label: 'Players you faced (same games)', color: CHART.peer, dashed: true }]}
      right={<Toggle value={mode} onChange={setMode} options={[['errors', 'Mistakes + blunders'], ['blunders', 'Blunders']]} />}
      table={{ columns: ['% of game', 'Your moves', 'You', 'Peers', 'Mistakes', 'Blunders'],
               rows: rows.map(r => [r.label, r.moves, `${r.you}%`, `${r.peer}%`, r.m, r.b]) }}>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 4 }} barCategoryGap={3}>
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: CHART.grid }} tickFormatter={v => `${Math.round(v - 2.5)}%`} interval={3} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} width={44} />
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload
              return <Tip title={`${p.label} of the game`} rows={[
                { label: 'You', value: `${p.you}%`, color: CHART.you }, { label: 'Peers', value: `${p.peer}%`, color: CHART.peer },
                { label: 'Your moves here', value: p.moves }, { label: 'Mistakes / blunders', value: `${p.m} / ${p.b}` },
              ]} />
            }} />
            <Bar dataKey="you" fill={CHART.you} radius={[4, 4, 0, 0]} maxBarSize={22} />
            <Line dataKey="peer" stroke={CHART.peer} strokeWidth={2} strokeDasharray="5 4" dot={false} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

// ── 2. the shape of your games ──────────────────────────────────────────────

export function EvalArc({ data }: { data: Insights['eval_arc'] }) {
  const [mode, setMode] = useState<'eval' | 'result'>('eval')
  const rows = data.map(d => ({ ...d, band: d.p25 != null && d.p75 != null ? [d.p25, d.p75] : null }))
  return (
    <ChartCard
      title="The shape of your games"
      subtitle={mode === 'eval'
        ? 'Average evaluation from your side (in points) vs % of the game completed. The band is the middle half of your games.'
        : 'Your winning chances across the game, split by how the game ended. Where the two lines separate is where games are decided.'}
      legend={mode === 'eval' ? undefined : [{ label: 'Games you won', color: CHART.win }, { label: 'Games you lost', color: CHART.loss }]}
      right={<Toggle value={mode} onChange={setMode} options={[['eval', 'Evaluation'], ['result', 'Wins vs losses']]} />}
      table={{ columns: ['% of game', 'Avg eval (pts)', 'Middle half', 'Win chance', 'In wins', 'In losses'],
               rows: data.map(d => [`${Math.round(d.x - 2.5)}%`, d.avg?.toFixed(2) ?? null, d.p25 != null ? `${d.p25} … ${d.p75}` : null,
                                     d.wp != null ? `${d.wp}%` : null, d.wp_win != null ? `${d.wp_win}%` : null, d.wp_loss != null ? `${d.wp_loss}%` : null]) }}>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          {mode === 'eval' ? (
            <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 4 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: CHART.grid }} tickFormatter={v => `${Math.round(v - 2.5)}%`} interval={3} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} tickFormatter={v => (v > 0 ? `+${v}` : `${v}`)} />
              <ReferenceLine y={0} stroke={CHART.axis} strokeOpacity={0.6} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const p = payload[0].payload
                return <Tip title={`${Math.round(p.x)}% through the game`} rows={[
                  { label: 'Average eval', value: `${p.avg > 0 ? '+' : ''}${p.avg?.toFixed(2)} pts`, color: CHART.you },
                  { label: 'Middle half', value: p.p25 != null ? `${p.p25} … ${p.p75}` : '—' },
                  { label: 'Win chance', value: `${p.wp}%` },
                ]} />
              }} />
              <Area dataKey="band" stroke="none" fill={CHART.you} fillOpacity={0.12} isAnimationActive={false} />
              <Line dataKey="avg" stroke={CHART.you} strokeWidth={2} dot={false} type="monotone" />
            </ComposedChart>
          ) : (
            <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 4 }}>
              <CartesianGrid stroke={CHART.grid} vertical={false} />
              <XAxis dataKey="x" tick={AXIS} tickLine={false} axisLine={{ stroke: CHART.grid }} tickFormatter={v => `${Math.round(v - 2.5)}%`} interval={3} />
              <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} domain={[0, 100]} tickFormatter={v => `${v}%`} />
              <ReferenceLine y={50} stroke={CHART.axis} strokeOpacity={0.6} />
              <Tooltip content={({ active, payload }) => {
                if (!active || !payload?.length) return null
                const p = payload[0].payload
                return <Tip title={`${Math.round(p.x)}% through the game`} rows={[
                  { label: 'In games you won', value: p.wp_win != null ? `${p.wp_win}%` : '—', color: CHART.win },
                  { label: 'In games you lost', value: p.wp_loss != null ? `${p.wp_loss}%` : '—', color: CHART.loss },
                ]} />
              }} />
              <Line dataKey="wp_win" stroke={CHART.win} strokeWidth={2} dot={false} type="monotone" />
              <Line dataKey="wp_loss" stroke={CHART.loss} strokeWidth={2} dot={false} type="monotone" />
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

// ── 3. skill radar ──────────────────────────────────────────────────────────

export function SkillRadar({ data }: { data: Insights['radar'] }) {
  const rows = data.filter(d => d.you != null).map(d => ({ axis: d.axis, you: d.you, peer: 50 }))
  if (rows.length < 3) return null
  const best = [...rows].sort((a, b) => (b.you ?? 0) - (a.you ?? 0))[0]
  const worst = [...rows].sort((a, b) => (a.you ?? 0) - (b.you ?? 0))[0]
  return (
    <ChartCard
      title="Your skill profile"
      subtitle={<>Each axis compares you with the players you faced in the same games (their level = 50). Strongest: <span className="text-text-0">{best.axis}</span> · weakest: <span className="text-text-0">{worst.axis}</span>.</>}
      legend={[{ label: 'You', color: CHART.you }, { label: 'Players you faced', color: CHART.peer, dashed: true }]}
      table={{ columns: ['Skill', 'You (peers = 50)'], rows: rows.map(r => [r.axis, r.you]) }}>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={rows} outerRadius="72%" margin={{ top: 8, right: 24, left: 24, bottom: 8 }}>
            <PolarGrid stroke={CHART.grid} />
            <PolarAngleAxis dataKey="axis" tick={{ fill: '#A3A3A3', fontSize: 11 }} />
            <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
            <Radar dataKey="peer" stroke={CHART.peer} strokeDasharray="5 4" strokeWidth={1.5} fill="none" />
            <Radar dataKey="you" stroke={CHART.you} strokeWidth={2} fill={CHART.you} fillOpacity={0.14}
              dot={{ r: 3.5, fill: CHART.you, stroke: CHART.surface, strokeWidth: 2 }} />
            <Tooltip content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload
              return <Tip title={p.axis} rows={[{ label: 'You', value: p.you, color: CHART.you }, { label: 'Peers', value: 50, color: CHART.peer }]} />
            }} />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

// ── 4. paired bars (situations, stages) ────────────────────────────────────

export function PairedBars({ title, subtitle, rows, unit = '%', tableHead }: {
  title: string; subtitle: ReactNode; rows: { label: string; you: number | null; peer: number | null }[]
  unit?: string; tableHead: string
}) {
  return (
    <ChartCard title={title} subtitle={subtitle}
      legend={[{ label: 'You', color: CHART.you }, { label: 'Players you faced', color: CHART.peer }]}
      table={{ columns: [tableHead, 'You', 'Peers'], rows: rows.map(r => [r.label, r.you != null ? `${r.you}${unit}` : null, r.peer != null ? `${r.peer}${unit}` : null]) }}>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 16, right: 8, left: -12, bottom: 4 }} barGap={2} barCategoryGap="28%">
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: CHART.grid }} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={50} tickFormatter={v => `${v}${unit}`} />
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload
              return <Tip title={p.label} rows={[{ label: 'You', value: p.you != null ? `${p.you}${unit}` : '—', color: CHART.you },
                                                 { label: 'Peers', value: p.peer != null ? `${p.peer}${unit}` : '—', color: CHART.peer }]} />
            }} />
            <Bar dataKey="you" fill={CHART.you} radius={[4, 4, 0, 0]} maxBarSize={24} />
            <Bar dataKey="peer" fill={CHART.peer} radius={[4, 4, 0, 0]} maxBarSize={24} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

// ── 5. single-series bars (clock, pieces, severity) ────────────────────────

export function SimpleBars({ title, subtitle, rows, horizontal = false, valueLabel = 'Count', color = CHART.you, height = 'h-56' }: {
  title: string; subtitle: ReactNode; rows: { label: string; value: number; note?: string }[]
  horizontal?: boolean; valueLabel?: string; color?: string; height?: string
}) {
  const max = Math.max(...rows.map(r => r.value))
  return (
    <ChartCard title={title} subtitle={subtitle} table={{ columns: ['', valueLabel], rows: rows.map(r => [r.label, r.note ?? r.value]) }}>
      <div className={height}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout={horizontal ? 'vertical' : 'horizontal'}
            margin={horizontal ? { top: 4, right: 28, left: 4, bottom: 4 } : { top: 16, right: 8, left: -12, bottom: 4 }} barCategoryGap="22%">
            <CartesianGrid stroke={CHART.grid} horizontal={!horizontal} vertical={horizontal} />
            {horizontal ? (
              <>
                <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="label" tick={{ ...AXIS, fill: '#A3A3A3' }} tickLine={false} axisLine={false} width={64} />
              </>
            ) : (
              <>
                <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: CHART.grid }} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={40} />
              </>
            )}
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload
              return <Tip title={p.label} rows={[{ label: valueLabel, value: p.note ?? p.value }]} />
            }} />
            <Bar dataKey="value" radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={24}>
              {rows.map(r => <Cell key={r.label} fill={color} fillOpacity={r.value === max ? 1 : 0.55} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

// ── 6. trend ────────────────────────────────────────────────────────────────

export function TrendChart({ data }: { data: Insights['trend'] }) {
  const rows = data.map(d => ({ ...d, dot: d.accuracy }))
  const first = rows.find(r => r.acc_avg != null)?.acc_avg, last = [...rows].reverse().find(r => r.acc_avg != null)?.acc_avg
  return (
    <ChartCard title="Accuracy, game by game"
      subtitle={<>Each dot is one game (oldest left); the line is your 10-game average{first != null && last != null ? <> — from <span className="text-text-0">{first}%</span> to <span className="text-text-0">{last}%</span></> : null}.</>}
      table={{ columns: ['Game', 'Accuracy', '10-game avg', 'Blunders', 'Result'],
               rows: rows.map(r => [r.i, r.accuracy != null ? `${r.accuracy}%` : null, r.acc_avg != null ? `${r.acc_avg}%` : null, r.blunders, r.outcome]) }}>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 4 }}>
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis dataKey="i" tick={AXIS} tickLine={false} axisLine={{ stroke: CHART.grid }} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} domain={[30, 100]} tickFormatter={v => `${v}%`} />
            <Tooltip content={({ active, payload }) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload
              return <Tip title={`Game ${p.i}${p.played_at ? ' · ' + new Date(p.played_at * 1000).toLocaleDateString() : ''}`} rows={[
                { label: 'Accuracy', value: p.accuracy != null ? `${p.accuracy}%` : '—', color: CHART.you },
                { label: '10-game average', value: p.acc_avg != null ? `${p.acc_avg}%` : '—' },
                { label: 'Blunders', value: p.blunders }, { label: 'Result', value: p.outcome ?? '—' },
              ]} />
            }} />
            <Scatter dataKey="dot" fill={CHART.you} fillOpacity={0.35} shape="circle" />
            <Line dataKey="acc_avg" stroke={CHART.you} strokeWidth={2} dot={false} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartCard>
  )
}

// ── 7. conversion ───────────────────────────────────────────────────────────

export function ConversionCard({ data }: { data: Insights['conversion'] }) {
  const y = data.you
  const total = Math.max(1, y.winning_games)
  const seg = [
    { label: 'Converted', value: y.converted, color: CHART.win },
    { label: 'Drawn', value: y.drawn, color: CHART.neutral },
    { label: 'Lost', value: y.lost, color: CHART.loss },
  ]
  return (
    <ChartCard title="Winning positions — did you bring them home?"
      subtitle={`Games where you reached a winning position (≥85% expected score after the opening), and how they ended.`}
      legend={seg.map(s => ({ label: s.label, color: s.color }))}
      table={{ columns: ['', 'You', 'Players you faced'], rows: [
        ['Winning positions reached', y.winning_games, data.peer.winning_games],
        ['Converted', pct(y.conversion_rate, 0), pct(data.peer.conversion_rate, 0)],
        ['Losing positions', y.losing_games, data.peer.losing_games],
        ['Saved (draw or win)', pct(y.save_rate, 0), pct(data.peer.save_rate, 0)],
      ] }}>
      <div className="flex h-3 rounded-full overflow-hidden gap-[2px] bg-bg-0" role="img" aria-label="Winning positions outcome">
        {seg.map(s => s.value > 0 && <div key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${s.value}`} />)}
      </div>
      <div className="grid grid-cols-2 gap-3 mt-4">
        <div className="rounded-xl bg-bg-2/60 border border-border p-3">
          <p className="text-[11px] text-text-2">You convert</p>
          <p className="text-2xl font-semibold text-text-0 mt-0.5">{pct(y.conversion_rate, 0)}</p>
          <p className="text-[11px] text-text-2">peers {pct(data.peer.conversion_rate, 0)} · {y.lost + y.drawn} slipped</p>
        </div>
        <div className="rounded-xl bg-bg-2/60 border border-border p-3">
          <p className="text-[11px] text-text-2">You save lost positions</p>
          <p className="text-2xl font-semibold text-text-0 mt-0.5">{pct(y.save_rate, 0)}</p>
          <p className="text-[11px] text-text-2">peers {pct(data.peer.save_rate, 0)} · {y.comebacks} comebacks</p>
        </div>
      </div>
      {data.thrown.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wider text-text-2 mb-2">Wins that got away</p>
          <ul className="space-y-1">
            {data.thrown.slice(0, 4).map(t => (
              <li key={t.game_id} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-text-1 truncate">vs {t.opponent ?? 'opponent'} · peak {Math.round(t.peak * 100)}% at move {t.peak_move}</span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  <span className={t.outcome === 'loss' ? 'text-danger' : 'text-text-2'}>{t.outcome === 'loss' ? 'lost' : 'drew'}</span>
                  {t.url && <a href={t.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">game ↗</a>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  )
}
