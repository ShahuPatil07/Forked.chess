import { useEffect, useMemo, useRef, useState } from 'react'
import type { SprintItem } from '../api'
import type { ThemePuzzle } from '../../../api/themes'
import { ThemePuzzleBoard, type BoardEvent } from '../../../components/puzzles/ThemePuzzleBoard'
import type { DrillProps } from './types'

/** Easy tactic, solved on the same board as Puzzle Themes (fast mode). Attempts are logged by
 *  Warm-Up only -- never sent to the Puzzle Themes rating / review queue or the SM-2 drills. */
export function EasySprint({ item, reveal, width, onAnswer }: DrillProps<SprintItem>) {
  const onset = useRef(performance.now())
  const done = useRef(false)
  const [revealKey, setRevealKey] = useState(0)
  useEffect(() => { onset.current = performance.now(); done.current = false }, [item.id])
  useEffect(() => { if (reveal && !done.current) setRevealKey(k => k + 1) }, [reveal])

  const puzzle: ThemePuzzle = useMemo(() => ({
    id: item.id, fen: item.fen, moves: item.moves, rating: item.rating, rd: 0, plays: 0, popularity: 0,
    themes: item.themes, game_url: null, opening: '', color: item.color, source: 'local', angle: 'warmup', rated: false,
    hint: { theme: '', name: '', text: '' },
  }), [item])

  const onEvent = (e: BoardEvent) => {
    if (done.current) return
    if (e.type === 'solved') { done.current = true; onAnswer({ correct: true, response_ms: performance.now() - onset.current }) }
    if (e.type === 'mistake') {
      done.current = true
      onAnswer({ correct: false, response_ms: performance.now() - onset.current, extra: { played: e.uci } })
      setRevealKey(k => k + 1)
    }
  }
  return (
    <div className="flex flex-col items-center gap-3 w-full">
      <p className="text-sm text-text-1">{item.color === 'w' ? 'White' : 'Black'} to play and win · rated {item.rating}</p>
      <div className="w-full" style={{ maxWidth: width }}>
        <ThemePuzzleBoard puzzle={puzzle} hintLevel={0} revealKey={revealKey} onEvent={onEvent} fast maxSize={width} />
      </div>
    </div>
  )
}
