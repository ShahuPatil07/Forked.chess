import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { CoachBoard } from './CoachBoard'
import type { ExplainPayload, InvestigationScore } from '../../api/coach'

function scoreText(score: InvestigationScore) {
  if (score.white_mate != null) {
    return `${score.white_mate > 0 ? 'White' : 'Black'} mates in ${Math.abs(score.white_mate)}`
  }
  if (score.white_cp == null) return 'Not evaluated'
  return `${score.white_cp >= 0 ? '+' : ''}${(score.white_cp / 100).toFixed(2)}`
}

const LABELS = { verified: 'Verified fact', likely: 'Likely', uncertain: 'Uncertain', rejected: 'Rejected' }
const COLORS = { verified: 'text-success', likely: 'text-accent', uncertain: 'text-amber-300', rejected: 'text-danger' }

export function InvestigationEvidence({ data }: { data: ExplainPayload }) {
  const [selected, setSelected] = useState(0)
  const [ply, setPly] = useState(0)
  const [replyIndex, setReplyIndex] = useState<number | null>(null)
  if (data.source === 'error') return <p className="text-danger text-xs">{data.explanation}</p>
  const candidates = data.candidates ?? []
  const candidate = candidates[selected]
  const line = replyIndex == null ? candidate?.line : candidate?.replies[replyIndex]?.line
  const boardFen = line?.fens[Math.min(ply, line.fens.length - 1)] ?? data.fen
  const claims = (data.claims ?? []).filter(c => !candidate || c.candidate_id === candidate.id)

  return (
    <div className="mt-2 p-3 rounded-lg bg-bg-1 border border-border space-y-3 text-xs" data-testid="investigation-evidence">
      <div className="flex flex-wrap justify-between gap-2">
        <p className="font-semibold text-text-0">Position investigation</p>
        <p className="text-text-2">{data.status === 'partial' ? 'Partial analysis' : data.status === 'terminal' ? 'Game over' : 'Analysis complete'}
          {data.budget && ` · ${data.budget.elapsed_seconds.toFixed(1)}s`}</p>
      </div>
      <p className="text-text-2">Scores favor White when positive and Black when negative. Verified facts apply to the stated test; strategic explanations can remain uncertain.</p>
      {!!candidates.length && (
        <div className="flex flex-wrap gap-1.5" aria-label="Candidate moves">
          {candidates.map((c, i) => (
            <button key={c.id} type="button" onClick={() => { setSelected(i); setPly(0); setReplyIndex(null) }}
              aria-pressed={i === selected}
              className={`rounded-md border px-2 py-1.5 text-left ${i === selected ? 'border-accent/50 bg-accent/10 text-text-0' : 'border-border text-text-1'}`}>
              <span className="font-semibold">{c.move_san}</span> · {scoreText(c.score)}
              <span className="block text-[10px] text-text-2">depth {c.depth}{c.roles.includes('focus') ? ' · your move' : ''}{c.roles.includes('alternative') ? ' · alternative' : ''}</span>
            </button>
          ))}
        </div>
      )}
      {boardFen && <CoachBoard key={`${boardFen}:${selected}`} mode="view" fen={boardFen} size={220}
        orientation={data.side_to_move} bestUci={ply === 0 ? candidate?.move_uci : undefined} />}
      {line && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Previous variation move" disabled={ply === 0} onClick={() => setPly(p => Math.max(0, p - 1))} className="btn-ghost p-1 disabled:opacity-30"><ChevronLeft size={14} /></button>
            <button type="button" onClick={() => setPly(0)} className="text-text-2">Start</button>
            <span className="text-text-1">{ply ? line.san[ply - 1] : 'Original position'}</span>
            <button type="button" aria-label="Next variation move" disabled={ply >= line.san.length} onClick={() => setPly(p => Math.min(line.san.length, p + 1))} className="btn-ghost p-1 disabled:opacity-30"><ChevronRight size={14} /></button>
          </div>
          <div className="flex flex-wrap gap-1" aria-label="Principal variation">
            {line.san.map((san, i) => <button key={i} type="button" onClick={() => setPly(i + 1)} className={`px-1.5 py-1 rounded ${ply === i + 1 ? 'bg-accent/15 text-accent' : 'text-text-1 hover:bg-bg-2'}`}>{san}</button>)}
          </div>
          {line.terminal && <p className="text-text-2">This line ends: {line.terminal.replace(/_/g, ' ')}.</p>}
          {!!candidate?.replies.length && (
            <div className="flex flex-wrap gap-1">
              <button type="button" onClick={() => { setReplyIndex(null); setPly(0) }} className="btn-ghost text-[11px]">Main line</button>
              {candidate.replies.map((r, i) => <button key={r.move_uci} type="button" onClick={() => { setReplyIndex(i); setPly(1) }}
                className={`btn-ghost text-[11px] ${replyIndex === i ? 'text-accent' : ''}`}>Reply {r.move_san} · depth {r.depth}</button>)}
            </div>
          )}
        </div>
      )}
      <div className="space-y-2" aria-label="Checked hypotheses">
        {claims.map(c => (
          <details key={c.id} className="rounded border border-border px-2 py-1.5">
            <summary className="cursor-pointer leading-relaxed"><span className={`font-medium ${COLORS[c.status]}`}>{LABELS[c.status]}</span> · {c.hypothesis}</summary>
            <div className="mt-2 space-y-1 text-text-2">
              <p>Test: {c.test}</p>
              {c.supporting_evidence.map((s, i) => <p key={`s${i}`}>Supports: {s}</p>)}
              {c.contradicting_evidence.map((s, i) => <p key={`c${i}`} className="text-amber-300">Contradicts: {s}</p>)}
              <p>{c.scope}</p>
            </div>
          </details>
        ))}
        {!claims.length && <p className="text-text-2">No explanatory hypothesis was established for this move. The lines and scores are available for inspection.</p>}
      </div>
      {(data.warnings ?? []).map((w, i) => <p key={i} className="text-amber-300">{w}</p>)}
      {!!data.narration_warnings?.length && <p className="text-amber-300">AI wording failed an evidence check. The local factual summary is shown instead.</p>}
      {!!candidate?.legal_replies.length && <details className="text-text-2"><summary className="cursor-pointer">All {candidate.legal_replies.length} legal first replies</summary><p className="mt-1">{candidate.legal_replies.join(', ')}</p><p className="mt-1">The reply buttons above show only the independently searched defenses.</p></details>}
      <details className="text-text-2">
        <summary className="cursor-pointer">Analysis details and evidence</summary>
        <p className="mt-1">{data.engine?.name ?? 'Board validation'} · {data.budget?.engine_calls.length ?? 0} engine calls · budget {data.budget?.requested_seconds ?? 0}s</p>
        <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
          const a = document.createElement('a'); a.href = url; a.download = 'forked-investigation.json'; a.click(); URL.revokeObjectURL(url)
        }}>Download evidence for feedback</button>
      </details>
    </div>
  )
}
