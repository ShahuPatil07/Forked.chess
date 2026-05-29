import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Chess } from 'chess.js'
import { Search, X, AlertCircle, BookOpen } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { openingsApi, START_FEN, type OpeningMove, type ExploreResponse } from '../api/openings'
import { OpeningTree } from '../components/openings/OpeningTree'
import { OpeningDetail } from '../components/openings/OpeningDetail'
import { OpeningCoachChat } from '../components/openings/OpeningCoachChat'
import { SectionHeader, SectionHeaderStat } from '../components/layout/SectionHeader'
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

// ── Main page ────────────────────────────────────────────────────────────────

export default function OpeningExplorer() {
  const { elo }  = useUserStore()

  const [rootData,     setRootData]     = useState<ExploreResponse | null>(null)
  const [rootError,    setRootError]    = useState<string | null>(null)
  const [rootLoading,  setRootLoading]  = useState(true)

  // Children loaded per path (Map preserves insertion order)
  const [childrenMap,  setChildrenMap]  = useState<Map<string, OpeningMove[]>>(new Map())
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set())
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [selected,     setSelected]     = useState<{ move: OpeningMove; path: string; depth: number } | null>(null)

  // Re-fetch root whenever ELO changes
  useEffect(() => {
    let cancelled = false
    setRootLoading(true); setRootError(null)
    openingsApi.explore(START_FEN, '', elo || null)
      .then(r => { if (!cancelled) setRootData(r) })
      .catch((e: Error) => { if (!cancelled) setRootError(e.message || 'Failed to load explorer') })
      .finally(() => { if (!cancelled) setRootLoading(false) })
    return () => { cancelled = true }
  }, [elo])

  // ── Fetch children of a node ──────────────────────────────────────────────

  const fetchChildrenFor = useCallback(async (path: string): Promise<OpeningMove[]> => {
    if (childrenMap.has(path)) return childrenMap.get(path)!

    setLoadingPaths(prev => { const s = new Set(prev); s.add(path); return s })
    try {
      const fen = fenFromPath(path)
      const res = await openingsApi.explore(fen, path, elo || null)
      setChildrenMap(prev => { const m = new Map(prev); m.set(path, res.moves); return m })
      return res.moves
    } catch (e) {
      // Cache empty array so we don't retry on every click — banner shown at top level
      setChildrenMap(prev => { const m = new Map(prev); m.set(path, []); return m })
      console.error('[OpeningExplorer] children fetch failed:', e)
      return []
    } finally {
      setLoadingPaths(prev => { const s = new Set(prev); s.delete(path); return s })
    }
  }, [childrenMap, elo])

  // ── Select a node ─────────────────────────────────────────────────────────

  const handleSelect = useCallback((move: OpeningMove, path: string, depth: number) => {
    setSelected({ move, path, depth })
  }, [])

  // ── Toggle expand / fetch children ────────────────────────────────────────

  const handleToggle = useCallback((_move: OpeningMove, path: string, depth: number) => {
    if (depth >= 10) return
    const isOpen = expanded.has(path)
    if (isOpen) {
      setExpanded(prev => { const s = new Set(prev); s.delete(path); return s })
      return
    }
    setExpanded(prev => { const s = new Set(prev); s.add(path); return s })
    if (!childrenMap.has(path)) {
      fetchChildrenFor(path)
    }
  }, [expanded, childrenMap, fetchChildrenFor])

  // ── Navigate to a named opening (from search) ─────────────────────────────

  const navigateToOpening = useCallback(async (op: IndexedOpening) => {
    if (!rootData) return

    // Walk root → leaf, fetching each level if not cached
    let path = ''
    let currentMoves: OpeningMove[] = rootData.moves
    let finalMove: OpeningMove | null = null

    for (let i = 0; i < op.uci.length; i++) {
      const uci = op.uci[i]
      const match = currentMoves.find(m => m.uci === uci)

      if (!match) {
        // Move not in top-N (too rare at this depth) — fall back to selecting last found
        if (finalMove) {
          setSelected({ move: finalMove, path, depth: i })
        }
        return
      }

      finalMove = match
      path = path ? `${path} ${uci}` : uci

      // Expand
      if (i < op.uci.length - 1) {
        setExpanded(prev => { const s = new Set(prev); s.add(path); return s })
        currentMoves = await fetchChildrenFor(path)
      }
    }

    if (finalMove) {
      setSelected({ move: finalMove, path, depth: op.uci.length })
    }
  }, [rootData, fetchChildrenFor])

  // ── UI ────────────────────────────────────────────────────────────────────

  const totalGames = rootData?.moves.reduce((acc, m) => acc + m.games, 0) ?? 0
  const eloBucket  = rootData?.elo_bucket ?? 'all'
  const parentOpening = rootData?.opening?.name ?? null

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <SectionHeader
        icon={BookOpen}
        title="Openings"
        description="Lazy tree from real Lichess games · engine eval + AI ideas at every node"
        right={rootData && (
          <SectionHeaderStat
            label="Stats from"
            value={`${totalGames.toLocaleString()} games · ${eloBucket === 'all' ? 'all levels' : eloBucket}`}
          />
        )}
      />

      {/* Search bar */}
      <div className="mb-4">
        <SearchBar onPick={navigateToOpening} />
      </div>

      {/* Error banner */}
      {rootError && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
          className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-lg border border-danger/30 bg-danger/10 text-sm text-danger">
          <AlertCircle size={14} />
          {rootError}
        </motion.div>
      )}

      {/* Layout */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
        {/* Tree */}
        <div className="card p-3 min-h-[60vh]">
          {rootLoading ? (
            <div className="space-y-2 p-2">
              {[0,1,2,3].map(i => (
                <div key={i} className="flex items-center gap-3 animate-pulse">
                  <div className="w-11 h-11 bg-bg-3 rounded-[2px]" />
                  <div className="flex-1 space-y-1">
                    <div className="h-3 bg-bg-3 rounded w-20" />
                    <div className="h-2 bg-bg-3 rounded w-40" />
                  </div>
                </div>
              ))}
            </div>
          ) : rootData && rootData.moves.length > 0 ? (
            <OpeningTree
              nodes={rootData.moves}
              parentPath=""
              depth={0}
              expanded={expanded}
              loading={loadingPaths}
              selectedPath={selected?.path ?? null}
              children_={childrenMap}
              onSelect={handleSelect}
              onToggle={handleToggle}
            />
          ) : !rootError ? (
            <p className="text-sm text-text-2 italic p-4">No moves found.</p>
          ) : null}
        </div>

        {/* Coach + detail rail */}
        <div className="space-y-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto xl:pr-1">
          <OpeningCoachChat
            selected={selected}
            parentName={parentOpening}
          />
          <OpeningDetail
            selected={selected}
            eloBucket={eloBucket}
            parentName={parentOpening}
          />
        </div>
      </div>
    </div>
  )
}
