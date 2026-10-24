import { useNavigate } from 'react-router-dom'
import { libraryApi, type StartReviewInput } from '../api/library'
import { useUserStore } from '../store/userStore'

/**
 * Start (or reuse) a background review and open it in Game Review. The review
 * runs server-side, so the page can be left and reopened at any time; a game
 * that was already reviewed opens instantly without recomputing.
 */
export function useOpenReview() {
  const navigate = useNavigate()
  const { username } = useUserStore()
  return async (input: StartReviewInput, opts: { ply?: number; replace?: boolean } = {}) => {
    const r = await libraryApi.startReview(username, input)
    navigate(`/game-review/${r.review_id}${opts.ply ? `?ply=${opts.ply}` : ''}`, { replace: opts.replace })
    return r
  }
}

/** URL of a stored review, optionally focused on one ply (the position before that move). */
export const reviewHref = (id: string, ply?: number | null) => `/game-review/${id}${ply ? `?ply=${ply}` : ''}`
