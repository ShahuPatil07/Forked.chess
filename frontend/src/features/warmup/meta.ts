import type { LucideIcon } from 'lucide-react'
import {
  BellOff, Brain, Crosshair, Eye, Footprints, Grid3x3, Hourglass, Layers, NotebookPen, ShieldAlert, Swords, Wind, Zap,
} from 'lucide-react'
import type { ActivityId } from './api'

export interface ActivityMeta {
  icon: LucideIcon
  title: string
  pitch: string       // one line on the library card
  how: string         // the instruction shown during the drill
  keys?: string       // keyboard hint
  group: 'Perception' | 'Thinking' | 'Reset'
}

export const META: Record<ActivityId, ActivityMeta> = {
  check_flash: {
    icon: Zap, title: 'Check or Not?', group: 'Perception',
    pitch: 'A corner of the board flashes. Is the king in check?',
    how: 'Watch the flash. Is the black king in check?', keys: '← Check · → Not check',
  },
  double_check_hunt: {
    icon: Grid3x3, title: 'Double-Check Hunt', group: 'Perception',
    pitch: 'Six mini-boards. Find the one double check.',
    how: 'One board shows a double check. Tap it.', keys: '1–6',
  },
  loose_pieces: {
    icon: ShieldAlert, title: 'Loose Pieces', group: 'Perception',
    pitch: 'Tap every undefended piece, both colours. Loose pieces drop off.',
    how: 'Tap every piece that nothing defends (both colours, no kings).', keys: 'type squares · Enter = done',
  },
  threat_count: {
    icon: Crosshair, title: 'Threat Count', group: 'Perception',
    pitch: 'How many of your pieces are really in danger right now?',
    how: 'Count your knights, bishops, rooks and queens the opponent could win by taking — attacked by something cheaper, or attacked more than defended. A queen eyeing a defended knight does not count.', keys: '0–5',
  },
  what_changed: {
    icon: Eye, title: 'What Changed?', group: 'Perception',
    pitch: 'The board flickers with one piece moved. Spot it.',
    how: 'One piece moves between flickers. Tap the square it left or the square it landed on.', keys: 'tap a square',
  },
  opponent_threat: {
    icon: Swords, title: 'What Does It Threaten?', group: 'Thinking',
    pitch: 'Your opponent just moved. What are they threatening now?',
    how: 'Play their threat on the board: drag the piece (or tap it, then the square) — a winning capture or a mate. If there is none, press No threat.', keys: '0 = no threat · Esc = cancel'
  },
  two_candidates: {
    icon: Brain, title: 'Two Candidates', group: 'Thinking',
    pitch: 'The first good move is not always the best. Find two, then choose.',
    how: 'Play two different candidate moves, then pick the one you would play.',
  },
  easy_sprint: {
    icon: Layers, title: 'Easy Tactic Sprint', group: 'Thinking',
    pitch: 'Quick, easy tactics to get the pattern engine running.',
    how: 'Solve it before the bar runs out.',
  },
  setup_check: {
    icon: BellOff, title: 'Setup Check', group: 'Reset',
    pitch: 'Air, water, notifications off, time control chosen.',
    how: 'Thirty seconds that save a game.',
  },
  breathing_reset: {
    icon: Wind, title: 'Reset Breathing', group: 'Reset',
    pitch: 'A minute or two of paced breathing. Best after a loss.',
    how: 'Follow the circle: breathe in as it grows, out as it shrinks.',
  },
  worry_dump: {
    icon: NotebookPen, title: 'Clear Your Head', group: 'Reset',
    pitch: 'Write down what is on your mind. It never leaves this device.',
    how: 'Write whatever is on your mind about this game. It is not saved or sent anywhere.',
  },
  move_nudge: {
    icon: Footprints, title: 'Move First', group: 'Reset',
    pitch: 'Stand up and move for a few minutes before you sit down to play.',
    how: 'Stand up, walk around, shake out your arms. Back when the timer ends.',
  },
}

export const TC_LABEL: Record<string, string> = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical' }
export const HOURGLASS = Hourglass

export const fmtMs = (ms: number | null | undefined) =>
  ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
export const pct = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`)
