import { useEffect, useRef } from 'react'

/**
 * Ambient app background — minimal, modern, "control-room" aesthetic.
 *
 * Layers (back-to-front):
 *   1. Deep base color
 *   2. Two large gradient-mesh blobs that slowly drift (independent of mouse)
 *   3. Fine grid lines with a faint mouse-parallax shift (subtle depth)
 *   4. Cursor-following spotlight (soft purple glow)
 *   5. Scroll-driven accent line at the top edge
 *   6. Grain + vignette to keep it premium, not flat
 *
 * No motifs / glyphs — purely abstract. Performance: mouse + scroll write to
 * CSS custom properties via rAF, never triggering a React re-render. All
 * animation is GPU-accelerated transform/background — smooth at 60fps.
 */
export function ChessBackground() {
  const rootRef   = useRef<HTMLDivElement>(null)
  const mouseTgt  = useRef({ x: 0.5, y: 0.5 })
  const mouseCur  = useRef({ x: 0.5, y: 0.5 })
  const scrollTgt = useRef(0)
  const scrollCur = useRef(0)
  const rafId     = useRef<number | null>(null)
  const lastWrite = useRef({ mx: -1, my: -1, sc: -1 })

  useEffect(() => {
    function onMouse(e: MouseEvent) {
      mouseTgt.current.x = e.clientX / window.innerWidth
      mouseTgt.current.y = e.clientY / window.innerHeight
    }
    function onScroll() {
      const main = document.querySelector('main')
      scrollTgt.current = main ? main.scrollTop : window.scrollY
    }

    function tick() {
      mouseCur.current.x += (mouseTgt.current.x - mouseCur.current.x) * 0.07
      mouseCur.current.y += (mouseTgt.current.y - mouseCur.current.y) * 0.07
      scrollCur.current  += (scrollTgt.current  - scrollCur.current)  * 0.10

      const el = rootRef.current
      if (el) {
        const mx = Math.round(mouseCur.current.x * 10000)
        const my = Math.round(mouseCur.current.y * 10000)
        const sc = Math.round(scrollCur.current)
        if (mx !== lastWrite.current.mx) {
          el.style.setProperty('--mx', String(mouseCur.current.x))
          lastWrite.current.mx = mx
        }
        if (my !== lastWrite.current.my) {
          el.style.setProperty('--my', String(mouseCur.current.y))
          lastWrite.current.my = my
        }
        if (sc !== lastWrite.current.sc) {
          el.style.setProperty('--sc', String(sc))
          lastWrite.current.sc = sc
        }
      }
      rafId.current = requestAnimationFrame(tick)
    }

    window.addEventListener('mousemove', onMouse, { passive: true })
    window.addEventListener('scroll',   onScroll, { passive: true })
    const main = document.querySelector('main')
    if (main) main.addEventListener('scroll', onScroll, { passive: true })

    rafId.current = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('scroll',   onScroll)
      if (main) main.removeEventListener('scroll', onScroll)
      if (rafId.current) cancelAnimationFrame(rafId.current)
    }
  }, [])

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className="fixed inset-0 pointer-events-none overflow-hidden"
      style={{
        zIndex: 0,
        '--mx': 0.5, '--my': 0.5, '--sc': 0,
      } as React.CSSProperties}
    >
      {/* 1 — base */}
      <div className="absolute inset-0" style={{ background: '#08080D' }} />

      {/* 2 — slowly drifting gradient-mesh blobs */}
      <div
        className="absolute -inset-32"
        style={{
          background:
            'radial-gradient(45% 45% at 22% 28%, rgba(123,97,255,0.18), transparent 60%), ' +
            'radial-gradient(40% 40% at 82% 72%, rgba(167,139,250,0.14), transparent 60%), ' +
            'radial-gradient(35% 35% at 60% 18%, rgba(80,120,255,0.08), transparent 60%)',
          animation: 'bgDrift 32s ease-in-out infinite alternate',
          willChange: 'transform',
          filter: 'blur(8px)',
        }}
      />

      {/* 3 — fine grid lines with subtle mouse parallax */}
      <div
        className="absolute -inset-8"
        style={{
          backgroundImage:
            'linear-gradient(rgba(150,140,200,0.05) 1px, transparent 1px), ' +
            'linear-gradient(90deg, rgba(150,140,200,0.05) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          transform:
            'translate3d(calc((var(--mx) - 0.5) * -14px), calc((var(--my) - 0.5) * -14px), 0)',
          maskImage:
            'radial-gradient(ellipse 75% 75% at center, black 30%, transparent 80%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 75% 75% at center, black 30%, transparent 80%)',
        }}
      />

      {/* 4 — cursor-following spotlight */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(600px circle at calc(var(--mx) * 100%) calc(var(--my) * 100%), ' +
            'rgba(123,97,255,0.14) 0%, ' +
            'rgba(123,97,255,0.05) 28%, ' +
            'transparent 55%)',
        }}
      />

      {/* 5 — scroll accent at top edge */}
      <div
        className="absolute top-0 inset-x-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(123,97,255,0.55), transparent)',
          transform: 'translateX(calc(var(--sc) * -0.2px))',
          opacity: 0.6,
        }}
      />

      {/* 6 — vignette */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 50%, rgba(4,4,9,0.6) 100%)',
        }}
      />

      {/* Drift keyframes */}
      <style>{`
        @keyframes bgDrift {
          0%   { transform: translate3d(0, 0, 0) scale(1); }
          50%  { transform: translate3d(-28px, 22px, 0) scale(1.05); }
          100% { transform: translate3d(24px, -26px, 0) scale(1); }
        }
      `}</style>
    </div>
  )
}
