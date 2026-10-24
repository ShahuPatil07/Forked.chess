export interface Answer {
  correct: boolean
  /** partial credit 0..1 (F1 for Loose Pieces); defaults to correct ? 1 : 0 */
  score?: number
  /** measured by the drill from the moment the stimulus appeared (rAF-accurate) */
  response_ms: number
  extra?: Record<string, unknown>
}

export interface DrillProps<T> {
  item: T
  /** true while the runner shows feedback (after an answer or a timeout): show the truth */
  reveal: boolean
  /** the answer given (null on timeout), so the reveal can mark what the player chose */
  given: Answer | null
  reducedMotion: boolean
  width: number
  onAnswer: (a: Answer) => void
}

/** Button used by several drills: big, keyboard-hinted, neon on focus. */
export const choiceBtn =
  'flex-1 min-w-[120px] rounded-xl border border-border bg-bg-1 hover:border-accent/50 hover:bg-bg-2 active:scale-[.98] ' +
  'transition-all px-4 py-3.5 text-base font-semibold text-text-0 disabled:opacity-40 disabled:pointer-events-none'
