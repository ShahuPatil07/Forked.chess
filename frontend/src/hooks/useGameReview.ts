import { useState, useMemo, useEffect, useCallback } from 'react'
import { Chess } from 'chess.js'

/**
 * Move-history review for a live game.
 *
 * The live game (WebSocket / engine) keeps progressing independently. This
 * hook only controls *which* position the board shows. When `viewingIndex`
 * is null the board shows the live position; otherwise it shows the position
 * after move `viewingIndex` (0-based into `sanMoves`), reconstructed by
 * replaying SAN from `baseFen`.
 *
 * Used by both BotGame and EndgamePractice.
 */
export interface GameReview {
  /** null = following the live position; number = reviewing after that move index */
  viewingIndex: number | null
  isReviewing:  boolean
  /** FEN to render: the reviewed position when reviewing, else `liveFen`. */
  displayFen:   string
  /** Jump to the position after move `idx`. idx >= last move → snaps to live. */
  goToMove:     (idx: number) => void
  /** Stop reviewing, return to the live position. */
  backToLive:   () => void
  /** Index highlighted in the move list (review index, or last live move). */
  highlightIndex: number
}

export function useGameReview({
  baseFen,
  sanMoves,
  liveFen,
  enableKeyboard = true,
}: {
  baseFen:        string
  sanMoves:       string[]
  liveFen:        string
  enableKeyboard?: boolean
}): GameReview {
  const [viewingIndex, setViewingIndex] = useState<number | null>(null)

  // Reset review whenever a brand-new game starts (base position changes)
  useEffect(() => {
    setViewingIndex(null)
  }, [baseFen])

  const reviewFen = useMemo(() => {
    if (viewingIndex === null) return null
    const chess = new Chess(baseFen)
    for (let i = 0; i <= viewingIndex && i < sanMoves.length; i++) {
      try { chess.move(sanMoves[i]) } catch { break }
    }
    return chess.fen()
  }, [viewingIndex, baseFen, sanMoves])

  const backToLive = useCallback(() => setViewingIndex(null), [])

  const goToMove = useCallback((idx: number) => {
    if (sanMoves.length === 0) return
    // Clicking the most recent move = live position (keep play interactive)
    if (idx >= sanMoves.length - 1) { setViewingIndex(null); return }
    setViewingIndex(Math.max(0, idx))
  }, [sanMoves.length])

  // Arrow-key navigation
  useEffect(() => {
    if (!enableKeyboard) return
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (sanMoves.length === 0) return

      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setViewingIndex(prev => {
          const cur = prev === null ? sanMoves.length - 1 : prev
          return Math.max(0, cur - 1)
        })
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setViewingIndex(prev => {
          if (prev === null) return null            // already live
          const next = prev + 1
          return next >= sanMoves.length - 1 ? null : next   // past last → live
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enableKeyboard, sanMoves.length])

  return {
    viewingIndex,
    isReviewing: viewingIndex !== null,
    displayFen:  reviewFen ?? liveFen,
    goToMove,
    backToLive,
    highlightIndex: viewingIndex ?? sanMoves.length - 1,
  }
}
