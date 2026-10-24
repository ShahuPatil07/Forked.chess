import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Chess } from 'chess.js'
import { Search, X, AlertCircle, BookOpen, Database } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { openingsApi, START_FEN, type OpeningMove, type OpeningPool } from '../api/openings'
import { OpeningTree } from '../components/openings/OpeningTree'
import { OpeningDetail } from '../components/openings/OpeningDetail'
import { SectionHeader } from '../components/layout/SectionHeader'
import { emptyTree, poolKey, useOpeningsStore } from '../store/openingsStore'
import { lichessToChesscom, toLichess } from '../lib/ratings'
import openingsIndex from '../data/openings_index.json'

interface IndexedOpening {
  name: string
  eco:  string
  uci:  string[]
}

// ── Fuzzy matching for search (typo-tolerant) ────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, (_, i) => i)
  for (let j = 1; j <= n; j++) {
    let prev = dp[0]
    dp[0] = j
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i]
      dp[i] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[i - 1], dp[i]) + 1
      prev = tmp
    }
  }
  return dp[m]
}

/** Normalize for matching: lowercase, strip apostrophes/punctuation, collapse spaces. */
function norm(s: string): string {
  return s.toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Allowed Levenshtein distance per token length. */
function maxDistFor(len: number): number {
  return len <= 4 ? 1 : len <= 7 ? 2 : 3
}

/**
 * Score how well `query` matches `name`. Higher = better. 0 = no match.
 * Handles substring, prefix, typo-tolerant word matching, and multi-word queries.
 */
function fuzzyScore(query: string, name: string): number {
  const q = norm(query)
  const n = norm(name)
  if (q.length === 0) return 0

  // Tier 1: exact substring (best, e.g. "ruy" → "ruy lopez")
  if (n.includes(q)) {
    const startBonus = n.startsWith(q) ? 30 : 0
    return 200 + startBonus - Math.abs(n.length - q.length) * 0.5
  }

  const qTokens = q.split(' ').filter(t => t.length > 0)
  const nTokens = n.split(' ').filter(t => t.length > 0)

  // Tier 2: multi-word query — all query tokens must match some name token (fuzzy)
  if (qTokens.length > 1) {
    let totalScore = 0
    let allMatched = true
    for (const qt of qTokens) {
      let bestForToken = 0
      for (const nt of nTokens) {
        if (nt.includes(qt)) {
          bestForToken = Math.max(bestForToken, nt.startsWith(qt) ? 120 : 100)
          continue
        }
        if (qt.length < 3) continue
        const dist = levenshtein(qt, nt)
        if (dist <= maxDistFor(Math.max(qt.length, nt.length))) {
          bestForToken = Math.max(bestForToken, 80 - dist * 15)
        }
      }
      if (bestForToken === 0) { allMatched = false; break }
      totalScore += bestForToken
    }
    if (allMatched) return Math.round(totalScore / qTokens.length) + 40   // multi-word bonus
  }

  // Tier 3: single-word fuzzy match against any name token
  let best = 0
  for (const w of nTokens) {
    if (w.length < 3) continue
    if (w.startsWith(q)) {
      best = Math.max(best, 150 - Math.abs(w.length - q.length))
      continue
    }
    const dist = levenshtein(q, w)
    if (dist <= maxDistFor(Math.max(q.length, w.length))) {
      best = Math.max(best, 100 - dist * 20)
    }
  }
  return best
}

// ── FEN computation from UCI path ────────────────────────────────────────────

function fenFromPath(path: string): string {
  if (!path) return START_FEN
  const chess = new Chess()
  for (const uci of path.split(' ')) {
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] ?? undefined })
    } catch { break }
  }
  return chess.fen()
}

// ── Search bar ──────────────────────────────────────────────────────────────

function SearchBar({ onPick }: { onPick: (op: IndexedOpening) => void }) {
  const [query, setQuery] = useState('')
  const [open,  setOpen]  = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
      // Cmd/Ctrl+K to focus
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const scored: { op: IndexedOpening; score: number }[] = []
    for (const op of openingsIndex as IndexedOpening[]) {
      // ECO prefix match is always strong
      let score = op.eco.toLowerCase().startsWith(q) ? 180 : 0
      // Fuzzy name match
      score = Math.max(score, fuzzyScore(q, op.name))
      if (score > 0) scored.push({ op, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 8).map(s => s.op)
  }, [query])

  return (
    <div ref={boxRef} className="relative w-full">
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-2 pointer-events-none" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="Search openings (Sicilian, Ruy Lopez, B90…)   ⌘K"
          className="w-full pl-9 pr-9 py-2 text-sm rounded-lg border border-border
                     bg-bg-1 text-text-0 placeholder:text-text-2
                     focus:outline-none focus:border-accent/60 focus:bg-bg-2
                     transition-colors"
        />
        {query && (
          <button
            onClick={() => { setQuery(''); inputRef.current?.focus() }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-bg-3
                       text-text-2 hover:text-text-0">
            <X size={12} />
          </button>
        )}
      </div>

      <AnimatePresence>
        {open && matches.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.12 }}
            className="absolute top-full mt-1 left-0 right-0 z-50 bg-bg-1 border border-border
                       rounded-lg shadow-2xl overflow-hidden max-h-80 overflow-y-auto"
          >
            {matches.map((op, i) => (
              <button key={i}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onPick(op); setOpen(false); setQuery('') }}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-bg-2 text-left transition-colors">
                <BookOpen size={12} className="text-text-2 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-0 truncate">{op.name}</p>
                  <p className="text-[10px] text-text-2 mt-0.5">
                    {op.uci.length} moves &middot; {op.uci.join(' ')}
                  </p>
                </div>
                <span className="text-[10px] font-semibold text-text-2 px-1.5 py-0.5 rounded
                                 bg-bg-2 border border-border tabular-nums">
                  {op.eco}
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Game pool bar ────────────────────────────────────────────────────────────

const BUCKETS: { v: string; label: string; lo: number; hi: number | null }[] = [
  { v: '0', label: '<1000', lo: 400, hi: 999 }, { v: '1000', label: '1000', lo: 1000, hi: 1199 },
  { v: '1200', label: '1200', lo: 1200, hi: 1399 }, { v: '1400', label: '1400', lo: 1400, hi: 1599 },
  { v: '1600', label: '1600', lo: 1600, hi: 1799 }, { v: '1800', label: '1800', lo: 1800, hi: 1999 },
  { v: '2000', label: '2000', lo: 2000, hi: 2199 }, { v: '2200', label: '2200', lo: 2200, hi: 2499 },
  { v: '2500', label: '2500+', lo: 2500, hi: null },
]
const SPEED_OPTIONS: { v: string; label: string }[] = [
  { v: 'bullet', label: 'Bullet' }, { v: 'blitz', label: 'Blitz' }, { v: 'rapid', label: 'Rapid' }, { v: 'classical', label: 'Classical' },
]

/** The player's rating as Lichess brackets: their own bracket and the one below. */
function defaultPool(elo: number, platform: 'chesscom' | 'lichess'): OpeningPool {
  const li = toLichess(elo || 1500, platform)
  let i = BUCKETS.findIndex(b => li >= b.lo && (b.hi == null || li <= b.hi))
  if (i < 0) i = 4
  const picked = [BUCKETS[Math.max(0, i - 1)].v, BUCKETS[i].v].filter((v, k, a) => a.indexOf(v) === k)
  return { db: 'lichess', ratings: picked, speeds: ['blitz', 'rapid', 'classical'] }
}

function bucketRange(vs: string[]): { lo: number; hi: number | null } | null {
  const sel = BUCKETS.filter(b => vs.includes(b.v))
  if (!sel.length) return null
  return { lo: sel[0].lo, hi: sel[sel.length - 1].hi }
}

function PoolBar({ pool, onChange, games }: { pool: OpeningPool; onChange: (p: OpeningPool) => void; games?: number }) {
  const [open, setOpen] = useState(false)
  const range = bucketRange(pool.ratings)
  const ccRange = range ? `${lichessToChesscom(range.lo)}–${range.hi ? lichessToChesscom(range.hi) : '2400+'}` : ''
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])
  const summary = pool.db === 'masters'
    ? 'Masters · over-the-board games, both players FIDE 2200+'
    : `Lichess · ${range ? `${range.lo}${range.hi ? '–' + range.hi : '+'} (≈ Chess.com ${ccRange})` : 'all ratings'} · ${pool.speeds.map(s => s[0].toUpperCase() + s.slice(1)).join(', ')}`
  return (
    <div className="card p-3 mb-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 text-left" aria-expanded={open}>
        <Database size={15} className="text-accent flex-shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] text-text-2">Games pool{games ? ` · ${games.toLocaleString()} games` : ''}</span>
          <span className="block text-sm text-text-0 truncate">{summary}</span>
        </span>
        <span className="text-xs text-accent flex-shrink-0">{open ? 'Done' : 'Change'}</span>
      </button>
      {open && (
        <div className="mt-3 pt-3 border-t border-border space-y-3">
          <div className="flex flex-wrap gap-2">
            {([['lichess', 'Lichess players', 'Online rated games, filtered by rating & speed'], ['masters', 'Masters', 'Over-the-board, FIDE 2200+']] as const).map(([db, label, sub]) => (
              <button key={db} onClick={() => onChange({ ...pool, db })}
                className={`rounded-xl border px-3 py-2 text-left ${pool.db === db ? 'border-accent bg-accent/10' : 'border-border hover:border-border-hover'}`}>
                <span className={`block text-sm font-semibold ${pool.db === db ? 'text-accent' : 'text-text-0'}`}>{label}</span>
                <span className="block text-[11px] text-text-2">{sub}</span>
              </button>
            ))}
          </div>
          {pool.db === 'lichess' && (
            <>
              <div>
                <p className="text-[11px] text-text-2 mb-1.5">Rating bracket — the <span className="text-text-1">average Lichess rating of both players</span>. Pick one or more.</p>
                <div className="flex flex-wrap gap-1.5">
                  {BUCKETS.map(b => (
                    <button key={b.v} onClick={() => { const next = toggle(pool.ratings, b.v); if (next.length) onChange({ ...pool, ratings: BUCKETS.filter(x => next.includes(x.v)).map(x => x.v) }) }}
                      title={`Lichess ${b.lo}${b.hi ? '–' + b.hi : '+'} ≈ Chess.com ${lichessToChesscom(b.lo)}${b.hi ? '–' + lichessToChesscom(b.hi) : '+'}`}
                      className={`px-2.5 py-1 rounded-full text-xs border tabular-nums ${pool.ratings.includes(b.v) ? 'bg-accent text-accent-ink border-accent font-semibold' : 'border-border text-text-1 hover:text-text-0'}`}>
                      {b.label}
                    </button>
                  ))}
                </div>
                {range && <p className="text-[11px] text-text-2 mt-1.5">≈ Chess.com {ccRange} (rapid scale)</p>}
              </div>
              <div>
                <p className="text-[11px] text-text-2 mb-1.5">Time controls</p>
                <div className="flex flex-wrap gap-1.5">
                  {SPEED_OPTIONS.map(s => (
                    <button key={s.v} onClick={() => { const next = toggle(pool.speeds, s.v); if (next.length) onChange({ ...pool, speeds: SPEED_OPTIONS.filter(x => next.includes(x.v)).map(x => x.v) }) }}
                      className={`px-2.5 py-1 rounded-full text-xs border ${pool.speeds.includes(s.v) ? 'bg-accent text-accent-ink border-accent font-semibold' : 'border-border text-text-1 hover:text-text-0'}`}>{s.label}</button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function OpeningExplorer() {
  const { elo, platform } = useUserStore()
  const { pool: storedPool, trees, evals, setPool, patchTree, addEvals } = useOpeningsStore()
  const pool = storedPool ?? defaultPool(elo, platform)
  const key = poolKey(pool)
  const tree = trees[key] ?? emptyTree()
  const rootData = tree.root
  const [rootError, setRootError] = useState<string | null>(null)
  const [rootLoading, setRootLoading] = useState(!rootData)
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const expanded = useMemo(() => new Set(tree.expanded), [tree.expanded])
  const childrenMap = useMemo(() => new Map(Object.entries(tree.children)), [tree.children])
  const selected = useMemo(() => {
    if (!tree.selected) return null
    const { path, depth } = tree.selected
    const parent = path.split(' ').slice(0, -1).join(' ')
    const list = parent ? tree.children[parent] : rootData?.moves
    const move = list?.find(m => m.uci === path.split(' ').slice(-1)[0])
    return move ? { move, path, depth } : null
  }, [tree.selected, tree.children, rootData])

  // (the default pool follows the live rating until the player picks one explicitly)

  const requestEvals = useCallback((moves: OpeningMove[]) => {
    const missing = moves.map(m => m.fen_after).filter(f => !useOpeningsStore.getState().evals[f])
    if (!missing.length) return
    openingsApi.evals(missing).then(r => addEvals(r.evals)).catch(() => undefined)
  }, [addEvals])

  // root of the current pool (cached per pool for the session)
  useEffect(() => {
    if (rootData) { setRootLoading(false); requestEvals(rootData.moves); return }
    let cancelled = false
    setRootLoading(true); setRootError(null)
    openingsApi.explore(START_FEN, '', null, pool)
      .then(r => { if (!cancelled) { patchTree(key, t => ({ ...t, root: r })); requestEvals(r.moves) } })
      .catch((e: Error) => { if (!cancelled) setRootError(e.message || 'Failed to load explorer') })
      .finally(() => { if (!cancelled) setRootLoading(false) })
    return () => { cancelled = true }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  // restore the scroll position when coming back
  useEffect(() => {
    if (rootData && tree.scrollY) requestAnimationFrame(() => window.scrollTo(0, tree.scrollY))
    return () => { const y = window.scrollY; patchTree(key, t => ({ ...t, scrollY: y })) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchChildrenFor = useCallback(async (path: string): Promise<OpeningMove[]> => {
    const have = useOpeningsStore.getState().trees[key]?.children[path]
    if (have) { requestEvals(have); return have }
    setLoadingPaths(prev => new Set(prev).add(path))
    try {
      const res = await openingsApi.explore(fenFromPath(path), path, null, pool)
      patchTree(key, t => ({ ...t, children: { ...t.children, [path]: res.moves } }))
      requestEvals(res.moves)
      return res.moves
    } catch (e) {
      patchTree(key, t => ({ ...t, children: { ...t.children, [path]: [] } }))
      console.error('[OpeningExplorer] children fetch failed:', e)
      return []
    } finally {
      setLoadingPaths(prev => { const s = new Set(prev); s.delete(path); return s })
    }
  }, [key, pool, patchTree, requestEvals])

  const handleSelect = useCallback((_move: OpeningMove, path: string, depth: number) => {
    patchTree(key, t => ({ ...t, selected: { path, depth } }))
  }, [key, patchTree])

  const handleToggle = useCallback((_move: OpeningMove, path: string, depth: number) => {
    if (depth >= 10) return
    const isOpen = useOpeningsStore.getState().trees[key]?.expanded.includes(path)
    patchTree(key, t => ({ ...t, expanded: isOpen ? t.expanded.filter(p => p !== path) : [...t.expanded, path] }))
    if (!isOpen) void fetchChildrenFor(path)
  }, [key, patchTree, fetchChildrenFor])

  const navigateToOpening = useCallback(async (op: IndexedOpening) => {
    if (!rootData) return
    let path = ''
    let currentMoves: OpeningMove[] = rootData.moves
    for (let i = 0; i < op.uci.length; i++) {
      const uci = op.uci[i]
      const match = currentMoves.find(m => m.uci === uci)
      if (!match) { if (path) patchTree(key, t => ({ ...t, selected: { path, depth: i } })); return }
      path = path ? `${path} ${uci}` : uci
      const p = path
      if (i < op.uci.length - 1) {
        patchTree(key, t => ({ ...t, expanded: t.expanded.includes(p) ? t.expanded : [...t.expanded, p] }))
        currentMoves = await fetchChildrenFor(p)
      }
    }
    patchTree(key, t => ({ ...t, selected: { path, depth: op.uci.length } }))
  }, [rootData, fetchChildrenFor, key, patchTree])

  const parentOpening = rootData?.opening?.name ?? null
  const evalMap = useMemo(() => new Map(Object.entries(evals)), [evals])

  return (
    <div className="px-4 sm:px-6 py-6 max-w-7xl mx-auto">
      <SectionHeader icon={BookOpen} title="Openings"
        description="A live move tree from real games at the level you choose · engine eval on every move · the plans behind the main openings" />
      <PoolBar pool={pool} games={rootData?.pool?.games} onChange={p => setPool(p)} />
      <div className="mb-4"><SearchBar onPick={op => void navigateToOpening(op)} /></div>
      {rootError && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
          className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-lg border border-danger/30 bg-danger/10 text-sm text-danger">
          <AlertCircle size={14} />{rootError}
        </motion.div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6 items-start">
        <div className="card p-2 sm:p-3 min-h-[60vh] min-w-0 overflow-x-auto">
          {rootLoading ? (
            <div className="space-y-2 p-2">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-3 animate-pulse">
                  <div className="w-11 h-11 bg-bg-3 rounded-[2px]" />
                  <div className="flex-1 space-y-1"><div className="h-3 bg-bg-3 rounded w-20" /><div className="h-2 bg-bg-3 rounded w-40" /></div>
                </div>
              ))}
            </div>
          ) : rootData && rootData.moves.length > 0 ? (
            <OpeningTree nodes={rootData.moves} parentPath="" depth={0} expanded={expanded} loading={loadingPaths}
              selectedPath={selected?.path ?? null} children_={childrenMap} evals={evalMap}
              onSelect={handleSelect} onToggle={handleToggle} />
          ) : !rootError ? <p className="text-sm text-text-2 italic p-4">No moves found.</p> : null}
        </div>
        <div className="space-y-4 xl:sticky xl:top-[72px] xl:max-h-[calc(100vh-5.5rem)] xl:overflow-y-auto xl:pr-1">
          <OpeningDetail selected={selected} pool={pool} parentName={parentOpening} />
        </div>
      </div>
    </div>
  )
}
