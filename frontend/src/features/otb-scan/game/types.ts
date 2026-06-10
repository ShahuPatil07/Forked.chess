export interface MovesData {
  sans: string[]
  from: number[]
  to: number[]
  targets: number[]
}

export interface MovesPair {
  move1: MovesData
  move2: MovesData | null
  moves: MovesData | null
}

export type TrackerState =
  | 'idle'
  | 'calibrating'
  | 'playing'
  | 'correction_needed'
  | 'finished'

export interface TrackerUpdate {
  state: TrackerState
  fen: string
  moves: string[]
  lastMove: string | null
  correctionOptions: string[]
  cornersDetected: boolean
  cornerConfidence: number
}
