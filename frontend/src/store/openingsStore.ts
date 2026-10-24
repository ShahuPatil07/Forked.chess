/**
 * Opening Explorer state that outlives the page: the chosen game pool and, per
 * pool, the loaded tree (children per path), what is expanded, what is
 * selected and the scroll position. Leaving for the Analysis Board or a game
 * vs Maia and coming back restores the tree exactly as it was.
 *
 * Kept in sessionStorage (one tab's session); engine evals are shared across pools.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ExploreResponse, OpeningMove, OpeningPool } from '../api/openings'

export interface PoolTree {
  root: ExploreResponse | null
  children: Record<string, OpeningMove[]>
  expanded: string[]
  selected: { path: string; depth: number } | null
  scrollY: number
}

const emptyTree = (): PoolTree => ({ root: null, children: {}, expanded: [], selected: null, scrollY: 0 })

export const poolKey = (p: OpeningPool) => (p.db === 'masters' ? 'masters' : `lichess|${p.ratings.join(',')}|${p.speeds.join(',')}`)

interface OpeningsStore {
  pool: OpeningPool | null
  trees: Record<string, PoolTree>
  evals: Record<string, string>
  setPool: (p: OpeningPool) => void
  patchTree: (key: string, fn: (t: PoolTree) => PoolTree) => void
  addEvals: (e: Record<string, string>) => void
}

export const useOpeningsStore = create<OpeningsStore>()(
  persist(
    (set) => ({
      pool: null,
      trees: {},
      evals: {},
      setPool: (pool) => set({ pool }),
      patchTree: (key, fn) => set(s => ({ trees: { ...s.trees, [key]: fn(s.trees[key] ?? emptyTree()) } })),
      addEvals: (e) => set(s => ({ evals: { ...s.evals, ...e } })),
    }),
    {
      name: 'forked-openings', storage: createJSONStorage(() => sessionStorage), version: 1,
      // keep the session copy small: at most 6 pools
      partialize: (s) => ({ pool: s.pool, evals: s.evals, trees: Object.fromEntries(Object.entries(s.trees).slice(-6)) }),
    },
  ),
)

export { emptyTree }
