import { useEffect, useState } from 'react'

/**
 * Width of an element's CONTENT box, kept current with a ResizeObserver.
 * Use it to size chessboards responsively: measure a wrapper that has no
 * padding of its own (or rely on contentRect, which excludes padding), and
 * make sure the wrapper sits in a `min-w-0` / `minmax(0,1fr)` track so the
 * board can never push its container wider and feed back into itself.
 *
 *   const [ref, width] = useElementWidth<HTMLDivElement>(480)
 *   <div ref={ref}><Chessboard boardWidth={Math.min(width, 640)} … /></div>
 */
export function useElementWidth<T extends HTMLElement>(initial = 400): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null)
  const [width, setWidth] = useState(initial)
  useEffect(() => {
    if (!el) return
    const update = (w: number) => setWidth(prev => (Math.abs(prev - w) >= 1 ? Math.floor(w) : prev))
    update(el.getBoundingClientRect().width - padX(el))
    const ro = new ResizeObserver(entries => {
      for (const e of entries) update(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, width]
}

function padX(el: HTMLElement): number {
  const cs = getComputedStyle(el)
  return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
}
