import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Chess } from 'chess.js'
import { Search, X, AlertCircle, BookOpen } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { openingsApi, START_FEN, type OpeningMove, type ExploreResponse } from '../api/openings'
import { OpeningTree } from '../components/openings/OpeningTree'
import { OpeningDetail } from '../components/openings/OpeningDetail'
import { ForkedWordmark } from '../components/layout/AppShell'
import openingsIndex from '../data/openings_index.json'

interface IndexedOpening {
  name: string
  eco:  string
  uci:  string[]
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
    return (openingsIndex as IndexedOpening[])
      .filter(o =>
        o.name.toLowerCase().includes(q) ||
        o.eco.toLowerCase().startsWith(q)
      )
      .slice(0, 8)
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
      {/* Header */}
      <div className="flex items-end justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-text-0 flex items-center gap-2">
            <BookOpen size={18} className="text-accent" />
            <ForkedWordmark className="text-xl" />
            <span className="text-text-1 font-semibold">Openings</span>
          </h1>
          <p className="text-xs text-text-2 mt-1">
            Lazy tree from real Lichess games · engine eval + AI ideas at every node
          </p>
        </div>
        {rootData && (
          <div className="text-right">
            <p className="text-[10px] text-text-2 uppercase tracking-wider">Stats from</p>
            <p className="text-xs text-text-1 tabular-nums">
              {totalGames.toLocaleString()} games · {eloBucket === 'all' ? 'all levels' : eloBucket}
            </p>
          </div>
        )}
      </div>

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
      <div className="grid grid-cols-[1fr_280px] gap-6 items-start">
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

        {/* Detail panel */}
        <div>
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
