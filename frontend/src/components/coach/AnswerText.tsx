import { Fragment, type ReactNode } from 'react'
import type { AgentLine } from '../../api/coach'

/**
 * Renders a coach answer: paragraphs, bullet/numbered lists, **bold**, *italic*,
 * `code` — and SAN moves that appear in this answer's analysed lines become
 * clickable, jumping the board to that point of the line.
 */
const SAN_RE = /((?:\d+\.(?:\.\.)?\s?)?(?:\.\.\.)?)(O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?|[a-h][1-8](?:=[QRBN])?[+#]?)(?![\w])/g

function findMove(lines: AgentLine[], san: string): { line: AgentLine; ply: number } | null {
  const clean = san.replace(/[+#]$/, '')
  for (const line of lines) {
    const i = line.san.findIndex(s => s.replace(/[+#]$/, '') === clean)
    if (i >= 0) return { line, ply: i + 1 }
  }
  return null
}

function withMoves(text: string, lines: AgentLine[], onMove: (line: AgentLine, ply: number) => void, key: string): ReactNode[] {
  if (!lines.length) return [text]
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  SAN_RE.lastIndex = 0
  while ((m = SAN_RE.exec(text))) {
    const hit = findMove(lines, m[2])
    // Bare squares ("the d5 square") only link when written as part of a line.
    if (!hit || (/^[a-h][1-8]$/.test(m[2]) && !m[1])) continue
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <button key={`${key}-${m.index}`} type="button" onClick={() => onMove(hit.line, hit.ply)}
        className="text-accent hover:underline decoration-dotted underline-offset-2 font-medium" title={`Show on board: ${hit.line.label}`}>
        {m[0]}
      </button>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function inline(text: string, lines: AgentLine[], onMove: (line: AgentLine, ply: number) => void, key: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g)
  return parts.map((p, i) => {
    const k = `${key}-${i}`
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={k} className="text-text-0 font-semibold">{withMoves(p.slice(2, -2), lines, onMove, k)}</strong>
    if (p.startsWith('`') && p.endsWith('`')) return <code key={k} className="px-1 rounded bg-bg-1 text-[0.85em]">{p.slice(1, -1)}</code>
    if ((p.startsWith('*') && p.endsWith('*') && p.length > 2) || (p.startsWith('_') && p.endsWith('_') && p.length > 2))
      return <em key={k} className="text-text-2">{withMoves(p.slice(1, -1), lines, onMove, k)}</em>
    return <Fragment key={k}>{withMoves(p, lines, onMove, k)}</Fragment>
  })
}

export function AnswerText({ text, lines, onMove }: { text: string; lines: AgentLine[]; onMove: (line: AgentLine, ply: number) => void }) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/)
  return (
    <div className="space-y-2 leading-relaxed">
      {blocks.map((block, bi) => {
        const rows = block.split('\n')
        const isList = rows.every(r => /^\s*([-*•]|\d+[.)])\s+/.test(r) || !r.trim())
        if (isList) {
          const ordered = /^\s*\d+[.)]\s+/.test(rows[0])
          const items = rows.filter(r => r.trim()).map((r, i) => (
            <li key={i}>{inline(r.replace(/^\s*([-*•]|\d+[.)])\s+/, ''), lines, onMove, `${bi}-${i}`)}</li>
          ))
          return ordered ? <ol key={bi} className="list-decimal pl-5 space-y-1">{items}</ol>
                         : <ul key={bi} className="list-disc pl-5 space-y-1">{items}</ul>
        }
        const heading = /^#{1,4}\s+/.test(rows[0])
        return (
          <p key={bi} className={heading ? 'font-semibold text-text-0' : undefined}>
            {rows.map((r, ri) => (
              <Fragment key={ri}>{ri > 0 && <br />}{inline(r.replace(/^#{1,4}\s+/, ''), lines, onMove, `${bi}-${ri}`)}</Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
