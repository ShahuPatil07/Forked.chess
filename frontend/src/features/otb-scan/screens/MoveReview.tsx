import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowRight, Check, ChevronLeft, ChevronRight, Copy, Download, Eye, Flag, Loader2, Microscope, RotateCcw,
  ScanSearch, Search, Sparkles, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import type { Ply, PlyStatus, ScanResult } from '../api/ocr'
import { BOARD_DARK, BOARD_LIGHT, LAST_MOVE, NEON_RGB } from '../../../theme'
import { libraryApi, type LibraryGame } from '../../../api/library'
import { useUserStore } from '../../../store/userStore'
import { useOpenReview } from '../../../lib/review'

/** First page of the scoresheet as a small JPEG (stored with the saved game). */
async function scanThumbnail(url: string, maxW = 900): Promise<string | undefined> {
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const scale = Math.min(1, maxW / img.naturalWidth)
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.78)
  } catch { return undefined }
}

interface Props {
  result: ScanResult
  pages: string[]
  onPin: (pins: Record<number, string>) => Promise<void>
  onBack: () => void
  onHistory?: () => void
}

const FLAGGED: PlyStatus[] = ['uncertain', 'inferred']

const STATUS_COPY: Record<PlyStatus, string> = {
  exact: 'Read straight off the sheet.',
  corrected: 'The sheet didn’t match a legal move exactly; this is the only legal move that fits.',
  uncertain: 'More than one legal move fits what’s written. Please check it against the sheet.',
  inferred: 'This move isn’t on the sheet. It was needed for the next written moves to be legal.',
  confirmed: 'You confirmed this move.',
}

export function MoveReview({ result, pages, onPin, onBack, onHistory }: Props) {
  const navigate = useNavigate()
  const { username } = useUserStore()
  const openReview = useOpenReview()
  const [saved, setSaved] = useState<LibraryGame | null>(null)
  const [saving, setSaving] = useState<'save' | 'review' | 'analyse' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(() => firstFlag(result.plies))
  const [pins, setPins] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [endAt, setEndAt] = useState<number | null>(null)
  const [readyOpen, setReadyOpen] = useState(false)
  const [headers, setHeaders] = useState({
    white: result.meta.white ?? '', black: result.meta.black ?? '', result: result.meta.result ?? '*',
    event: result.meta.event ?? '', date: result.meta.date ?? '',
  })

  // slide the "game ready" panel in once the game is extracted
  useEffect(() => { const t = window.setTimeout(() => setReadyOpen(true), 700); return () => clearTimeout(t) }, [])

  const plies = useMemo(() => endAt === null ? result.plies : result.plies.slice(0, endAt), [result.plies, endAt])
  const sans = plies.map(p => p.san)
  const fens = useMemo(() => {
    const c = new Chess(); const out = [c.fen()]
    for (const s of sans) { c.move(s); out.push(c.fen()) }
    return out
  }, [sans.join(' ')]) // eslint-disable-line react-hooks/exhaustive-deps

  const flagged = plies.filter(p => FLAGGED.includes(p.status))
  const sel = selected !== null && selected < plies.length ? plies[selected] : null
  const viewPly = selected ?? plies.length - 1
  const fen = fens[Math.min(fens.length - 1, viewPly + 1)]

  const pgn = useMemo(() => buildPgn(sans, headers), [sans.join(' '), headers]) // eslint-disable-line react-hooks/exhaustive-deps
  const title = headers.white || headers.black ? `${headers.white || '?'} – ${headers.black || '?'}` : 'OTB game'

  /** The player confirms this is the game: it joins their Forked history with the photo. */
  async function save(): Promise<LibraryGame> {
    const scan = pages[0] ? await scanThumbnail(pages[0]) : undefined
    const { game } = await libraryApi.addGame(username, {
      pgn, source: 'otb', title, scan_image: scan,
      meta: { pages: pages.length, flagged: flagged.length, provider: result.provider ?? null, event: headers.event || null },
    })
    setSaved(game)
    return game
  }
  async function act(kind: 'save' | 'review' | 'analyse') {
    setSaving(kind); setSaveError(null)
    try {
      const g = await save()
      if (kind === 'review') await openReview({ pgn: g.pgn ?? pgn, source: 'otb', user_color: g.user_color ?? undefined })
      if (kind === 'analyse') navigate('/analysis', { state: { pgn: g.pgn ?? pgn, title } })
    } catch (e) { setSaveError(e instanceof Error ? e.message : 'Could not save the game.') }
    finally { setSaving(null) }
  }

  async function choose(ply: number, san: string) {
    const p = plies[ply]
    const c = new Chess(fens[ply])
    let uci = ''
    try { const m = c.move(san); uci = m.from + m.to + (m.promotion ?? '') } catch { return }
    const next = { ...pins, [ply]: uci }
    setPins(next); setBusy(true); setError(null)
    try {
      await onPin(next)
      if (p && san !== p.san) setEndAt(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the game')
    } finally {
      setBusy(false)
    }
  }

  // keyboard: arrows move through plies, N jumps to the next flagged move
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); setSelected(s => Math.max(0, (s ?? plies.length) - 1)) }
      if (e.key === 'ArrowRight') { e.preventDefault(); setSelected(s => Math.min(plies.length - 1, (s ?? -1) + 1)) }
      if (e.key.toLowerCase() === 'n') setSelected(s => nextFlag(plies, s))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [plies])

  const st = result.stats
  return (
    <div className="max-w-[1400px] mx-auto px-2 sm:px-4 py-4">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button onClick={onBack} className="btn-ghost flex items-center gap-1"><ChevronLeft size={15} /> New scan</button>
        <h1 className="font-display text-xl font-semibold text-text-0">Review the game</h1>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <Chip tone="text">{Math.ceil(plies.length / 2)} moves</Chip>
          <Chip tone="text">{st.exact} read exactly</Chip>
          {st.corrected > 0 && <Chip tone="accent">{st.corrected} auto-fixed</Chip>}
          {flagged.length > 0 ? <Chip tone="warn">{flagged.length} to check</Chip> : <Chip tone="success">nothing to check</Chip>}
          {result.elapsed_s !== undefined && <span className="text-text-2 ml-1">read in {result.elapsed_s}s</span>}
        </div>
        <div className="ml-auto flex gap-2">
          {flagged.length > 0 && (
            <button onClick={() => setSelected(s => nextFlag(plies, s))} className="btn-ghost border border-warn/40 text-warn text-sm inline-flex items-center gap-1.5">
              <Flag size={13} />Next to check <kbd className="text-[10px] opacity-60">N</kbd>
            </button>
          )}
          <button onClick={() => setReadyOpen(true)} className="btn-primary text-sm inline-flex items-center gap-1.5">
            Done <ArrowRight size={14} />
          </button>
        </div>
      </div>

      {result.warning === 'few_moves' && (
        <Banner>We could only make out a few moves. Is the whole move table in the photo, in focus?</Banner>
      )}
      {result.warning === 'low_confidence' && (
        <Banner>This sheet was hard to read, so more moves than usual need a check. A sharper photo usually fixes it.</Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)_minmax(0,380px)] items-start">
        <SheetViewer pages={pages} />

        <div className="space-y-3 lg:sticky lg:top-20">
          <BoardPane fen={fen} lastUci={viewPly >= 0 ? plies[viewPly]?.uci : undefined} />
          <div className="flex items-center justify-between">
            <button className="btn-ghost border border-border px-2" onClick={() => setSelected(s => Math.max(0, (s ?? plies.length) - 1))}><ChevronLeft size={15} /></button>
            <span className="text-xs text-text-2 tabular-nums">
              {viewPly < 0 ? 'Start' : `${Math.floor(viewPly / 2) + 1}${viewPly % 2 ? '…' : '.'} ${plies[viewPly]?.san}`} · ply {viewPly + 1}/{plies.length}
            </span>
            <button className="btn-ghost border border-border px-2" onClick={() => setSelected(s => Math.min(plies.length - 1, (s ?? -1) + 1))}><ChevronRight size={15} /></button>
          </div>
          <AnimatePresence mode="wait">
            {sel && (
              <FixPanel key={`${sel.ply}-${sel.san}`} ply={sel} busy={busy} error={error}
                onChoose={san => void choose(sel.ply, san)}
                onConfirm={() => void choose(sel.ply, sel.san)}
                onEndHere={() => { setEndAt(sel.ply + 1); setSelected(sel.ply) }} />
            )}
          </AnimatePresence>
        </div>

        <MoveTable plies={plies} selected={selected} onSelect={setSelected} busy={busy}
          dropped={result.dropped} truncated={endAt !== null} onRestore={() => setEndAt(null)} />
      </div>

      <ReadyPanel open={readyOpen} onClose={() => setReadyOpen(false)} pgn={pgn} sans={sans}
        headers={headers} setHeaders={setHeaders} flagged={flagged.length}
        onShowFlag={() => { setReadyOpen(false); setSelected(firstFlag(plies)) }}
        busy={saving} saved={!!saved} error={saveError} onHistory={onHistory}
        onSave={() => void act('save')}
        onReview={() => void act('review')}
        onAnalyse={() => void act('analyse')} />
    </div>
  )
}

// ── pieces ──────────────────────────────────────────────────────────────────

function firstFlag(plies: Ply[]): number | null {
  const i = plies.findIndex(p => FLAGGED.includes(p.status))
  return i >= 0 ? i : null
}

function nextFlag(plies: Ply[], from: number | null): number | null {
  const n = plies.length
  for (let k = 1; k <= n; k++) {
    const i = ((from ?? -1) + k) % n
    if (FLAGGED.includes(plies[i].status)) return i
  }
  return from
}

function buildPgn(sans: string[], h: { white: string; black: string; result: string; event: string; date: string }): string {
  const c = new Chess()
  for (const s of sans) c.move(s)
  c.setHeader('Event', h.event || 'Over-the-board game')
  c.setHeader('White', h.white || '?')
  c.setHeader('Black', h.black || '?')
  if (h.date) c.setHeader('Date', h.date)
  c.setHeader('Result', h.result || '*')
  c.setHeader('Annotator', 'Forked OTB Scan')
  const body = c.pgn()
  return /(1-0|0-1|1\/2-1\/2|\*)\s*$/.test(body) ? body : `${body} ${h.result || '*'}`
}

function Chip({ tone, children }: { tone: 'text' | 'accent' | 'warn' | 'success'; children: React.ReactNode }) {
  const cls = {
    text: 'border-border text-text-1', accent: 'border-accent/40 text-accent',
    warn: 'border-warn/40 text-warn bg-warn/10', success: 'border-success/40 text-success',
  }[tone]
  return <span className={`px-2 py-0.5 rounded-full border ${cls}`}>{children}</span>
}

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="card px-4 py-2.5 mb-4 border-warn/30 text-sm text-text-1">{children}</div>
}

function SheetViewer({ pages }: { pages: string[] }) {
  const [page, setPage] = useState(0)
  const [zoom, setZoom] = useState(false)
  const [open, setOpen] = useState(true)
  if (!pages.length) return null
  return (
    <div className="card p-2 lg:sticky lg:top-20">
      <div className="flex items-center gap-2 px-1 pb-2">
        <p className="text-[11px] uppercase tracking-[0.18em] text-text-2 flex-1">Your scoresheet</p>
        {pages.length > 1 && pages.map((_, i) => (
          <button key={i} onClick={() => setPage(i)}
            className={`text-[11px] px-2 py-0.5 rounded ${page === i ? 'bg-accent text-accent-ink' : 'text-text-2 hover:text-text-0'}`}>p{i + 1}</button>
        ))}
        <button onClick={() => setZoom(z => !z)} className="text-text-2 hover:text-accent p-1" title={zoom ? 'Fit' : 'Zoom'}>
          {zoom ? <ZoomOut size={15} /> : <ZoomIn size={15} />}
        </button>
        <button onClick={() => setOpen(o => !o)} className="lg:hidden text-text-2 hover:text-accent p-1" title="Show / hide"><Eye size={15} /></button>
      </div>
      {open && (
        <div className={`rounded-lg bg-black ${zoom ? 'overflow-auto max-h-[78vh]' : 'overflow-hidden'}`}>
          <img src={pages[page]} alt={`Scoresheet page ${page + 1}`}
            className={zoom ? 'max-w-none w-[200%]' : 'w-full max-h-[78vh] object-contain'} />
        </div>
      )}
    </div>
  )
}

function BoardPane({ fen, lastUci }: { fen: string; lastUci?: string }) {
  const [w, setW] = useState(420)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(220, Math.min(460, el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  const styles: Record<string, React.CSSProperties> = {}
  if (lastUci) {
    styles[lastUci.slice(0, 2)] = { backgroundColor: LAST_MOVE }
    styles[lastUci.slice(2, 4)] = { backgroundColor: LAST_MOVE }
  }
  return (
    <div ref={setEl} className="w-full">
      <Chessboard position={fen} boardWidth={w} arePiecesDraggable={false} customSquareStyles={styles}
        customDarkSquareStyle={{ backgroundColor: BOARD_DARK }} customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
        customBoardStyle={{ borderRadius: 10, boxShadow: `0 0 0 1px rgba(${NEON_RGB},0.16)` }} animationDuration={150} />
    </div>
  )
}

function FixPanel({ ply, busy, error, onChoose, onConfirm, onEndHere }: {
  ply: Ply; busy: boolean; error: string | null
  onChoose: (san: string) => void; onConfirm: () => void; onEndHere: () => void
}) {
  const [q, setQ] = useState('')
  const moveNo = Math.floor(ply.ply / 2) + 1
  const side = ply.ply % 2 === 0 ? 'White' : 'Black'
  const others = ply.legal.filter(s => s !== ply.san)
  const matches = q ? others.filter(s => s.toLowerCase().includes(q.toLowerCase())) : []
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-text-0">Move {moveNo} · {side}: <span className="font-mono text-accent">{ply.san}</span></p>
        <StatusPill status={ply.status} />
      </div>
      <p className="text-xs text-text-2 mt-1.5 leading-relaxed">{STATUS_COPY[ply.status]}</p>
      {ply.read && ply.status !== 'exact' && (
        <p className="text-xs text-text-1 mt-2">The sheet says <span className="font-mono px-1.5 py-0.5 rounded bg-bg-2 text-text-0">{ply.read}</span></p>
      )}
      {ply.status !== 'confirmed' && ply.status !== 'exact' && (
        <button onClick={onConfirm} disabled={busy}
          className="mt-3 w-full inline-flex items-center justify-center gap-1.5 text-sm py-2 rounded-lg border border-success/40 text-success hover:bg-success/10 disabled:opacity-50">
          <Check size={14} />{ply.san} is right
        </button>
      )}
      {ply.alternatives.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] text-text-2 mb-1.5">Or did they play</p>
          <div className="flex flex-wrap gap-1.5">
            {ply.alternatives.map(a => (
              <button key={a} onClick={() => onChoose(a)} disabled={busy}
                className="font-mono text-sm px-2.5 py-1 rounded-lg border border-border hover:border-accent/50 hover:text-accent disabled:opacity-50">{a}</button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-2" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Another legal move…" className="input pl-8 py-1.5 font-mono" />
      </div>
      {matches.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
          {matches.slice(0, 24).map(a => (
            <button key={a} onClick={() => { setQ(''); onChoose(a) }} disabled={busy}
              className="font-mono text-xs px-2 py-1 rounded border border-border hover:border-accent/50 hover:text-accent">{a}</button>
          ))}
        </div>
      )}
      {busy && <p className="mt-3 text-xs text-text-2 inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />Re-checking the rest of the game…</p>}
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      <button onClick={onEndHere} className="mt-3 text-[11px] text-text-2 hover:text-danger">End the game after this move</button>
    </motion.div>
  )
}

function StatusPill({ status }: { status: PlyStatus }) {
  const map: Record<PlyStatus, [string, string]> = {
    exact: ['Read', 'text-text-2 border-border'],
    corrected: ['Auto-fixed', 'text-accent border-accent/40'],
    uncertain: ['Check', 'text-warn border-warn/40 bg-warn/10'],
    inferred: ['Not on sheet', 'text-warn border-warn/40 border-dashed'],
    confirmed: ['Confirmed', 'text-success border-success/40'],
  }
  const [label, cls] = map[status]
  return <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border ${cls}`}>{label}</span>
}

function MoveTable({ plies, selected, onSelect, busy, dropped, truncated, onRestore }: {
  plies: Ply[]; selected: number | null; onSelect: (i: number) => void; busy: boolean
  dropped: ScanResult['dropped']; truncated: boolean; onRestore: () => void
}) {
  const rows: [Ply, Ply | undefined][] = []
  for (let i = 0; i < plies.length; i += 2) rows.push([plies[i], plies[i + 1]])
  return (
    <div className="card p-2">
      <div className="grid grid-cols-[2.2rem_1fr_1fr] gap-1 px-1 pb-1.5 text-[10px] text-text-2 uppercase tracking-wider">
        <span>#</span><span>White</span><span>Black</span>
      </div>
      <div className={`max-h-[62vh] overflow-y-auto space-y-0.5 ${busy ? 'opacity-60' : ''}`}>
        {rows.map(([w, b], r) => (
          <div key={r} className="grid grid-cols-[2.2rem_1fr_1fr] gap-1 items-stretch">
            <span className="text-xs text-text-2 tabular-nums pl-1 pt-1.5">{r + 1}.</span>
            <Cell ply={w} active={selected === w.ply} onClick={() => onSelect(w.ply)} />
            {b ? <Cell ply={b} active={selected === b.ply} onClick={() => onSelect(b.ply)} /> : <span />}
          </div>
        ))}
      </div>
      {truncated && (
        <button onClick={onRestore} className="mt-2 w-full text-xs text-text-2 hover:text-accent inline-flex items-center justify-center gap-1.5">
          <RotateCcw size={12} />Restore the moves after this point
        </button>
      )}
      {dropped.length > 0 && (
        <p className="mt-2 px-1 text-[11px] text-text-2 leading-relaxed">
          Ignored on the sheet: {dropped.slice(0, 6).map((d, i) => (
            <span key={i} className="font-mono text-text-1">{i ? ', ' : ''}{d.read || '—'}</span>
          ))}{dropped.length > 6 ? ` +${dropped.length - 6} more` : ''}
        </p>
      )}
    </div>
  )
}

function Cell({ ply, active, onClick }: { ply: Ply; active: boolean; onClick: () => void }) {
  const tone: Record<PlyStatus, string> = {
    exact: 'text-text-0 border-transparent hover:bg-bg-2',
    corrected: 'text-text-0 border-transparent hover:bg-bg-2',
    uncertain: 'text-warn bg-warn/10 border-warn/40',
    inferred: 'text-warn border-dashed border-warn/50',
    confirmed: 'text-text-0 border-transparent hover:bg-bg-2',
  }
  return (
    <button onClick={onClick} title={ply.read && ply.read !== ply.san ? `Sheet: ${ply.read}` : undefined}
      className={`text-left px-2 py-1 rounded-md border font-mono text-sm transition-colors ${tone[ply.status]}
        ${active ? 'ring-1 ring-accent bg-accent/10' : ''}`}>
      <span className="flex items-center gap-1.5">
        <span className="truncate">{ply.san}</span>
        {ply.status === 'corrected' && <Sparkles size={11} className="text-accent flex-shrink-0" />}
        {ply.status === 'confirmed' && <Check size={11} className="text-success flex-shrink-0" />}
        {ply.status === 'uncertain' && <span className="text-[10px] font-sans font-semibold">?</span>}
      </span>
      {ply.status !== 'exact' && ply.status !== 'confirmed' && (
        <span className="block text-[10px] font-sans text-text-2 truncate">
          {ply.status === 'inferred' ? 'not on sheet' : `sheet: ${ply.read || '—'}`}
        </span>
      )}
    </button>
  )
}

function ReadyPanel({ open, onClose, pgn, sans, headers, setHeaders, flagged, onShowFlag, onReview, onAnalyse, onSave, busy, saved, error, onHistory }: {
  open: boolean; onClose: () => void; pgn: string; sans: string[]
  headers: { white: string; black: string; result: string; event: string; date: string }
  setHeaders: (h: { white: string; black: string; result: string; event: string; date: string }) => void
  flagged: number; onShowFlag: () => void; onReview: () => void; onAnalyse: () => void
  onSave: () => void; busy: 'save' | 'review' | 'analyse' | null; saved: boolean; error: string | null; onHistory?: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(pgn); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* blocked */ }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }))
    const a = document.createElement('a')
    a.href = url; a.download = `${(headers.white || 'white')}-vs-${(headers.black || 'black')}.pgn`.replace(/\s+/g, '_')
    a.click(); URL.revokeObjectURL(url)
  }
  return (
    <AnimatePresence>
      {open && (
        <motion.aside role="dialog" aria-label="Game ready"
          initial={{ x: '110%' }} animate={{ x: 0 }} exit={{ x: '110%' }} transition={{ type: 'spring', stiffness: 260, damping: 30 }}
          className="fixed z-50 right-3 bottom-3 sm:top-20 sm:bottom-auto w-[calc(100%-24px)] sm:w-[380px] rounded-2xl border border-accent/40 bg-bg-1/95 backdrop-blur-xl shadow-neon p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-accent">Game ready</p>
              <p className="font-display text-xl font-semibold text-text-0 mt-1">{Math.ceil(sans.length / 2)} moves extracted</p>
            </div>
            <button onClick={onClose} className="text-text-2 hover:text-text-0" aria-label="Close"><X size={16} /></button>
          </div>

          {flagged > 0 && (
            <button onClick={onShowFlag} className="mt-3 w-full text-left text-xs rounded-lg border border-warn/40 bg-warn/10 text-warn px-3 py-2">
              {flagged} move{flagged > 1 ? 's are' : ' is'} worth a quick check against the sheet first. <u>Show me</u>
            </button>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2">
            <input className="input py-1.5 text-sm" placeholder="White player" value={headers.white} onChange={e => setHeaders({ ...headers, white: e.target.value })} />
            <input className="input py-1.5 text-sm" placeholder="Black player" value={headers.black} onChange={e => setHeaders({ ...headers, black: e.target.value })} />
            <select className="input py-1.5 text-sm" value={headers.result} onChange={e => setHeaders({ ...headers, result: e.target.value })} aria-label="Result">
              <option value="*">Result: unknown</option><option value="1-0">1-0 White won</option>
              <option value="0-1">0-1 Black won</option><option value="1/2-1/2">½-½ Draw</option>
            </select>
            <input className="input py-1.5 text-sm" placeholder="Event / round" value={headers.event} onChange={e => setHeaders({ ...headers, event: e.target.value })} />
          </div>

          <div className="mt-4 space-y-2">
            <motion.button whileTap={{ scale: 0.98 }} onClick={onReview} disabled={busy !== null}
              className="btn-primary w-full py-3 text-base inline-flex items-center justify-center gap-2">
              {busy === 'review' ? <Loader2 size={17} className="animate-spin" /> : <ScanSearch size={17} />}Review this game
            </motion.button>
            <motion.button whileTap={{ scale: 0.98 }} onClick={onAnalyse} disabled={busy !== null}
              className="w-full py-3 text-base rounded-lg border border-accent/40 text-accent hover:bg-accent/10 inline-flex items-center justify-center gap-2 font-semibold">
              {busy === 'analyse' ? <Loader2 size={17} className="animate-spin" /> : <Microscope size={17} />}Analysis Board
            </motion.button>
            <button onClick={onSave} disabled={busy !== null || saved}
              className="w-full py-2 text-sm rounded-lg border border-border text-text-1 hover:text-text-0 inline-flex items-center justify-center gap-2 disabled:opacity-70">
              {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} className="text-success" /> : <Flag size={14} />}
              {saved ? 'Saved to your scanned games' : 'This is my game: save it'}
            </button>
            {saved && onHistory && <button onClick={onHistory} className="w-full text-xs text-accent">See all scanned games →</button>}
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={copy} className="flex-1 btn-ghost border border-border text-xs inline-flex items-center justify-center gap-1.5">
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy PGN'}
            </button>
            <button onClick={download} className="flex-1 btn-ghost border border-border text-xs inline-flex items-center justify-center gap-1.5">
              <Download size={13} />Download .pgn
            </button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
