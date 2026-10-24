/**
 * The app's navigation tree. The hub (/home), each section page
 * (/home/:section) and the top-bar breadcrumbs are all rendered from this one
 * definition — rename, regroup or re-describe things here.
 */
import type { LucideIcon } from 'lucide-react'
import {
  BookOpen, Bot, Clock, Crown, Flame, LayoutDashboard, MessageSquare, Microscope, MonitorUp,
  Puzzle, ScanLine, ScanSearch, Sparkles, Swords, Target,
} from 'lucide-react'

export interface NavLeaf {
  id: string
  title: string
  blurb: string
  icon: LucideIcon
  to: string
  /** other routes that belong to this leaf (for breadcrumbs) */
  match?: string[]
}

export interface NavSection {
  id: string
  title: string
  blurb: string
  icon: LucideIcon
  /** a section with no children opens this route directly */
  to?: string
  match?: string[]
  children?: NavLeaf[]
}

export const SECTIONS: NavSection[] = [
  {
    id: 'dashboard', title: 'Dashboard', icon: LayoutDashboard, to: '/dashboard', match: ['/blindspot/'],
    blurb: 'Your blindspots, ranked against players at your level, with the games they came from.',
  },
  {
    id: 'theory', title: 'Theory', icon: BookOpen,
    blurb: 'Learn the openings you reach and the endings you need.',
    children: [
      { id: 'openings', title: 'Openings', icon: BookOpen, to: '/openings',
        blurb: 'Every line with live game stats, engine evaluation and the ideas behind it.' },
      { id: 'endgames', title: 'Endgames', icon: Crown, to: '/endgames',
        blurb: 'Tablebase-verified theory, then practise any ending against Maia.' },
    ],
  },
  {
    id: 'practice', title: 'Practice', icon: Swords,
    blurb: 'Warm up before a game, drill your weak patterns, train any puzzle theme, and play a human-like opponent.',
    children: [
      { id: 'warmup', title: 'Warm-Up', icon: Flame, to: '/warmup', match: ['/warmup/'],
        blurb: 'Five minutes before you play: quick board-vision drills on real positions, then straight to your game.' },
      { id: 'drills', title: 'Drills', icon: Target, to: '/session',
        blurb: 'Puzzles aimed at your blindspots, spaced so they stick.' },
      { id: 'themes', title: 'Puzzle Themes', icon: Puzzle, to: '/puzzles',
        blurb: 'Every Lichess theme and finer sub-types, rated per theme, with Rush and Streak runs and puzzles from your own games.' },
      { id: 'maia', title: 'Play vs Maia', icon: Bot, to: '/bot-game', match: ['/bot-game/'],
        blurb: 'A human-like opponent at your rating, with a debrief after every game.' },
    ],
  },
  {
    id: 'coach', title: 'AI Coach', icon: Sparkles,
    blurb: 'Ask about any position. Every answer is checked by Stockfish.',
    children: [
      { id: 'chat', title: 'Chat', icon: MessageSquare, to: '/coach',
        blurb: 'A board-aware coach for any move, opening or whole game.' },
      { id: 'screen', title: 'Screen Share', icon: MonitorUp, to: '/share-screen',
        blurb: 'Share your board and talk it through out loud.' },
    ],
  },
  {
    id: 'analyze', title: 'Analyze', icon: ScanSearch,
    blurb: 'Review your games and explore any position.',
    children: [
      { id: 'review', title: 'Game Review', icon: ScanSearch, to: '/game-review',
        blurb: 'Move labels, accuracy and game rating, close to Chess.com’s review.' },
      { id: 'board', title: 'Analysis Board', icon: Microscope, to: '/analysis',
        blurb: 'Free play with a live Stockfish evaluation.' },
      { id: 'history', title: 'Game History', icon: Clock, to: '/history',
        blurb: 'Every analysed game and the moments it turned.' },
    ],
  },
  {
    id: 'scan', title: 'OTB Scan', icon: ScanLine, to: '/otb-scan',
    blurb: 'Photograph your scoresheet and get the game back, checked move by move, ready to review. Camera and video coming soon.',
  },
]

const covers = (path: string, to?: string, match?: string[]) =>
  (!!to && (path === to || path.startsWith(to + '/'))) || (match ?? []).some(m => path.startsWith(m))

/** Where a route sits in the tree, for breadcrumbs. */
export function locate(pathname: string): { section?: NavSection; leaf?: NavLeaf } {
  for (const section of SECTIONS) {
    if (covers(pathname, section.to, section.match)) return { section }
    for (const leaf of section.children ?? []) {
      if (covers(pathname, leaf.to, leaf.match)) return { section, leaf }
    }
  }
  const hub = pathname.match(/^\/home\/([^/]+)/)
  if (hub) return { section: SECTIONS.find(s => s.id === hub[1]) }
  return {}
}

/** Where a section tile leads: its own route, or its section page. */
export const sectionHref = (s: NavSection) => s.to ?? `/home/${s.id}`
