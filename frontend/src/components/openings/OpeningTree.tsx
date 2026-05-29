import { memo, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import type { OpeningMove } from '../../api/openings'
import { MiniBoardThumbnail } from './MiniBoardThumbnail'

export const MAX_DEPTH    = 10
export const INDENT_PX    = 24       // per-depth indentation
export const THUMB_SIZE   = 44

// ── Single node row ──────────────────────────────────────────────────────────

interface NodeRowProps {
  move:         OpeningMove
  path:         string
  depth:        number
  isExpanded:   boolean
  isLoading:    boolean
  isSelected:   boolean
  onSelect:     (move: OpeningMove, path: string, depth: number) => void
  onToggle:     (move: OpeningMove, path: string, depth: number) => void
}

function NodeRowInner({
  move, path, depth, isExpanded, isLoading, isSelected, onSelect, onToggle,
}: NodeRowProps) {
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isSelected && rowRef.current) {
      rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [isSelected])

  const canExpand = depth < MAX_DEPTH
  const evalStr   = move.eval

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      onClick={() => { onSelect(move, path, depth); if (canExpand) onToggle(move, path, depth) }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(move, path, depth)
          if (canExpand) onToggle(move, path, depth)
        }
      }}
      className={`group flex items-center gap-2.5 px-2 py-1.5 my-0.5 rounded-md cursor-pointer transition-all
        ${isSelected
          ? 'bg-accent/12 ring-1 ring-accent/45'
          : 'hover:bg-bg-2'}`}
    >
      {/* Mini board */}
      <MiniBoardThumbnail fen={move.fen_after} size={THUMB_SIZE} />

      {/* Expand chevron */}
      <div className="w-3 flex-shrink-0 flex items-center justify-center">
        {canExpand ? (
          <motion.div
            animate={{ rotate: isExpanded ? 90 : 0 }}
            transition={{ duration: 0.15 }}
            className="text-text-2 group-hover:text-text-1"
          >
            <ChevronRight size={12} />
          </motion.div>
        ) : (
          <span className="text-text-2 text-[10px]">—</span>
        )}
      </div>

      {/* Move + name */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-bold text-text-0">{move.san}</span>
          {move.eco && (
            <span className="text-[10px] font-semibold text-text-2 px-1 py-0.5 rounded
                             bg-bg-2 border border-border">
              {move.eco}
            </span>
          )}
        </div>
        {move.name && (
          <p className="text-[11px] text-text-2 truncate leading-tight mt-0.5">
            {move.name}
          </p>
        )}
      </div>

      {/* Eval badge */}
      {evalStr ? (
        <span className={`font-mono text-[11px] font-bold tabular-nums px-1.5 py-0.5 rounded
          ${evalStr.startsWith('+') || evalStr === '0.0' || evalStr === '+0.0'
            ? 'bg-success/15 text-success'
            : evalStr.includes('M')
              ? 'bg-accent/15 text-accent'
              : 'bg-bg-2 text-text-1'}`}>
          {evalStr}
        </span>
      ) : (
        <span className="text-[10px] text-text-2 px-1.5 py-0.5">—</span>
      )}

      {/* Popularity + mini WDL bar */}
      <div className="flex flex-col items-end gap-1 w-14 flex-shrink-0">
        <span className="text-[11px] text-text-1 tabular-nums font-medium">
          {move.popularity.toFixed(0)}%
        </span>
        <div className="flex h-1 w-12 rounded overflow-hidden">
          <div className="bg-accent"      style={{ width: `${move.w}%` }} />
          <div className="bg-bg-3"        style={{ width: `${move.d}%` }} />
          <div className="bg-[#181826]"   style={{ width: `${move.l}%` }} />
        </div>
      </div>

      {/* Loading dot */}
      {isLoading && (
        <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin flex-shrink-0" />
      )}
    </div>
  )
}

const NodeRow = memo(NodeRowInner)

// ── Recursive tree ───────────────────────────────────────────────────────────

interface OpeningTreeProps {
  nodes:         OpeningMove[]
  parentPath:    string        // UCI path of parent; '' for root
  depth:         number
  expanded:      Set<string>
  loading:       Set<string>
  selectedPath:  string | null
  children_:     Map<string, OpeningMove[]>
  onSelect:      (move: OpeningMove, path: string, depth: number) => void
  onToggle:      (move: OpeningMove, path: string, depth: number) => void
}

export function OpeningTree({
  nodes, parentPath, depth, expanded, loading, selectedPath, children_, onSelect, onToggle,
}: OpeningTreeProps) {
  return (
    <div
      className={depth > 0 ? 'border-l border-accent/15 pl-2' : ''}
      style={{ marginLeft: depth > 0 ? `${INDENT_PX}px` : 0 }}
    >
      {nodes.map((move) => {
        const path = parentPath ? `${parentPath} ${move.uci}` : move.uci

        const isExpanded = expanded.has(path)
        const isLoading  = loading.has(path)
        const isSelected = selectedPath === path
        const kids       = children_.get(path)

        return (
          <div key={path}>
            <NodeRow
              move={move}
              path={path}
              depth={depth}
              isExpanded={isExpanded}
              isLoading={isLoading}
              isSelected={isSelected}
              onSelect={onSelect}
              onToggle={onToggle}
            />

            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  key={path + '-children'}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  {isLoading && !kids ? (
                    <div style={{ marginLeft: `${INDENT_PX}px` }}
                      className="border-l border-accent/15 pl-2 py-2 space-y-1.5">
                      {[0, 1, 2].map(i => (
                        <div key={i} className="flex items-center gap-2 animate-pulse">
                          <div className="w-11 h-11 bg-bg-3 rounded-[2px]" />
                          <div className="flex-1 space-y-1">
                            <div className="h-3 bg-bg-3 rounded w-16" />
                            <div className="h-2 bg-bg-3 rounded w-32" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : kids && kids.length > 0 ? (
                    <OpeningTree
                      nodes={kids}
                      parentPath={path}
                      depth={depth + 1}
                      expanded={expanded}
                      loading={loading}
                      selectedPath={selectedPath}
                      children_={children_}
                      onSelect={onSelect}
                      onToggle={onToggle}
                    />
                  ) : kids && kids.length === 0 ? (
                    <p className="text-xs text-text-2 italic pl-6 py-2">
                      No common responses recorded
                    </p>
                  ) : null}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}
