import { memo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import {
  ENDGAME_TREE,
  type EndgameLeaf,
  type EndgameResult,
} from '../../data/endgameTree'
import { MiniBoardThumbnail } from '../openings/MiniBoardThumbnail'

interface Props {
  selectedId:  string | null
  onSelect:    (leaf: EndgameLeaf) => void
}

const RESULT_STYLE: Record<EndgameResult, string> = {
  white_wins: 'bg-success/15 text-success',
  black_wins: 'bg-bg-2     text-text-0 border border-border',
  draw:       'bg-bg-3     text-text-1',
  depends:    'bg-accent/15 text-accent',
}

const RESULT_GLYPH: Record<EndgameResult, string> = {
  white_wins: '1-0',
  black_wins: '0-1',
  draw:       '½-½',
  depends:    '?',
}

const DIFFICULTY_DOT: Record<string, string> = {
  beginner:     'bg-success',
  intermediate: 'bg-accent',
  advanced:     'bg-danger',
}

// ── Leaf row ─────────────────────────────────────────────────────────────────

function LeafRow_({
  leaf, isSelected, onSelect,
}: { leaf: EndgameLeaf; isSelected: boolean; onSelect: (l: EndgameLeaf) => void }) {
  return (
    <button
      onClick={() => onSelect(leaf)}
      className={`group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-all
        text-left
        ${isSelected
          ? 'bg-accent/12 ring-1 ring-accent/45'
          : 'hover:bg-bg-2'}`}
    >
      <MiniBoardThumbnail fen={leaf.fen} size={42} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${DIFFICULTY_DOT[leaf.difficulty]}`}
            title={leaf.difficulty} />
          <span className="text-sm font-medium text-text-0 truncate">{leaf.title}</span>
        </div>
        {leaf.summary && (
          <p className="text-[10px] text-text-2 leading-snug mt-0.5 line-clamp-1">
            {leaf.summary}
          </p>
        )}
      </div>
      <span className={`font-mono text-[10px] font-bold px-1.5 py-0.5 rounded ${RESULT_STYLE[leaf.result]}`}>
        {RESULT_GLYPH[leaf.result]}
      </span>
    </button>
  )
}
const LeafRow = memo(LeafRow_)

// ── Group (sub-section) ──────────────────────────────────────────────────────

function Group({
  title, leaves, selectedId, onSelect,
}: { title: string; leaves: EndgameLeaf[]; selectedId: string | null; onSelect: (l: EndgameLeaf) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-1 py-1 text-text-1 hover:text-text-0 transition-colors"
      >
        <motion.div animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }}>
          <ChevronRight size={11} className="text-text-2" />
        </motion.div>
        <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
        <span className="text-[10px] text-text-2 ml-1">{leaves.length}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden pl-2 space-y-0.5"
          >
            {leaves.map(leaf => (
              <LeafRow key={leaf.id} leaf={leaf}
                       isSelected={selectedId === leaf.id} onSelect={onSelect} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Section (top-level category) ─────────────────────────────────────────────

export function EndgameTree({ selectedId, onSelect }: Props) {
  const [openSection, setOpenSection] = useState<string | null>(ENDGAME_TREE[0]?.id ?? null)

  return (
    <div className="space-y-3">
      {ENDGAME_TREE.map(section => {
        const isOpen = openSection === section.id
        return (
          <div key={section.id} className="card p-3">
            <button
              onClick={() => setOpenSection(isOpen ? null : section.id)}
              className="w-full flex items-center gap-2 text-left"
            >
              <motion.div animate={{ rotate: isOpen ? 90 : 0 }} transition={{ duration: 0.15 }}>
                <ChevronRight size={14} className="text-accent" />
              </motion.div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-text-0">{section.title}</p>
                <p className="text-[11px] text-text-2 leading-snug">{section.blurb}</p>
              </div>
              <span className="text-[10px] text-text-2 tabular-nums">
                {section.groups.reduce((acc, g) => acc + g.leaves.length, 0)} positions
              </span>
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden mt-3 pt-3 border-t border-border space-y-2"
                >
                  {section.groups.map(group => (
                    <Group key={group.id} title={group.title} leaves={group.leaves}
                           selectedId={selectedId} onSelect={onSelect} />
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}
