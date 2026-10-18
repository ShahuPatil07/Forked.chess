import { useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Crown, BookOpen, Sword, Bot, type LucideIcon } from 'lucide-react'
import { SectionHeader } from '../components/layout/SectionHeader'
import { EndgameTree } from '../components/endgames/EndgameTree'
import { EndgameDetail } from '../components/endgames/EndgameDetail'
import { EndgamePractice } from '../components/endgames/EndgamePractice'
import { ENDGAME_TREE, endgameLeafCount, type EndgameLeaf } from '../data/endgameTree'

type TabId = 'theory' | 'practice'

interface TabSpec {
  id:    TabId
  label: string
  icon:  LucideIcon
}

const TABS: TabSpec[] = [
  { id: 'theory',   label: 'Theory',   icon: BookOpen },
  { id: 'practice', label: 'Practice', icon: Sword },
]

export default function Endgames() {
  const [tab, setTab] = useState<TabId>('theory')

  // ── Cross-tab state ──────────────────────────────────────────────────────
  // Theory selection (shown in detail panel)
  const [selectedLeaf, setSelectedLeaf] = useState<EndgameLeaf | null>(null)

  // Practice tab — a position handed over from the Theory tab
  const [practicePosition, setPracticePosition] = useState<EndgameLeaf | null>(null)

  const handlePracticeRequest = useCallback((leaf: EndgameLeaf) => {
    setPracticePosition(leaf)
    setTab('practice')
  }, [])

  const sectionCount   = ENDGAME_TREE.length
  const positionsCount = endgameLeafCount()

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <SectionHeader
        icon={Crown}
        title="Endgames"
        description={`Theoretical positions and practice vs Maia · ${positionsCount} positions across ${sectionCount} categories`}
        right={
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-2 uppercase tracking-wider">Tablebase</span>
            <span className="text-xs text-success font-mono font-medium">Syzygy ≤7</span>
          </div>
        }
      />

      {/* Tab switcher */}
      <div className="flex gap-1 mb-5 border-b border-border">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors
              ${tab === id ? 'text-text-0' : 'text-text-2 hover:text-text-1'}`}
          >
            <Icon size={14} className={tab === id ? 'text-accent' : ''} />
            {label}
            {tab === id && (
              <motion.div
                layoutId="endgames-tab-underline"
                className="absolute -bottom-px left-0 right-0 h-0.5 bg-accent"
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'theory' && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start">
          <div>
            <EndgameTree selectedId={selectedLeaf?.id ?? null} onSelect={setSelectedLeaf} />
          </div>
          <div className="xl:sticky xl:top-4">
            <EndgameDetail
              leaf={selectedLeaf}
              onPracticeRequest={handlePracticeRequest}
            />
          </div>
        </div>
      )}

      {tab === 'practice' && (
        <EndgamePractice
          forcedPosition={practicePosition}
        />
      )}


    </div>
  )
}
