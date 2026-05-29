import { useEffect, useRef } from 'react'

/**
 * Professional interactive page background.
 *
 * Architecture (back-to-front):
 *   1. Deep base color
 *   2. Two large radial accent blobs that slowly drift independently
 *   3. Three parallax layers of chess pieces, each shifted by mouse position
 *      at different depths (farther = less shift). Creates a 3D feel.
 *   4. Cursor-following spotlight (600px radius, soft purple glow) that
 *      reveals subtle texture under the cursor
 *   5. Faint dot grid texture
 *   6. Scroll-driven hue accent at the top edge
 *
 * Performance: mouse + scroll write to CSS custom properties via rAF —
 * never triggers a React re-render. All animation is GPU-accelerated
 * transform/background. Stays smooth at 60fps even with the parallax.
 */

// Three depth layers of chess pieces. Closer = larger + more parallax shift.
type PieceSpec = { glyph: string; top: string; left: string; size: number; rotate: number }

const LAYER_FAR: PieceSpec[] = [
  { glyph: '♞', top: '6%',  left: '12%', size: 130, rotate: -8  },
  { glyph: '♛', top: '38%', left: '78%', size: 110, rotate: 12  },
  { glyph: '♝', top: '72%', left: '8%',  size: 120, rotate: -15 },
  { glyph: '♟', top: '88%', left: '92%', size: 90,  rotate: 6   },
]

const LAYER_MID: PieceSpec[] = [
  { glyph: '♜', top: '20%', left: '85%', size: 170, rotate: 10  },
  { glyph: '♚', top: '58%', left: '22%', size: 160, rotate: -6  },
  { glyph: '♘', top: '82%', left: '62%', size: 145, rotate: 18  },
  { glyph: '♕', top: '12%', left: '46%', size: 130, rotate: -10 },
]

const LAYER_NEAR: PieceSpec[] = [
  { glyph: '♔', top: '34%', left: '6%',  size: 240, rotate: -4 },
  { glyph: '♗', top: '64%', left: '88%', size: 220, rotate: 8  },
  { glyph: '♖', top: '4%',  left: '70%', size: 200, rotate: -12 },
]

export function ChessBackground() {
  const rootRef    = useRef<HTMLDivElement>(null)
  const mouseTgt   = useRef({ x: 0.5, y: 0.5 })
  const mouseCur   = useRef({ x: 0.5, y: 0.5 })
  const scrollTgt  = useRef(0)
  const scrollCur  = useRef(0)
  const rafId      = useRef<number | null>(null)
  const lastWrite  = useRef({ mx: -1, my: -1, sc: -1 })

  useEffect(() => {
    function onMouse(e: MouseEvent) {
      mouseTgt.current.x = e.clientX / window.innerWidth
      mouseTgt.current.y = e.clientY / window.innerHeight
    }
    function onScroll() {
      // Find the actual scrollable container — most pages scroll within <main>
      const main = document.querySelector('main')
      scrollTgt.current = main ? main.scrollTop : window.scrollY
    }

    function tick() {
      // Smooth interpolation (ease toward target)
      mouseCur.current.x  += (mouseTgt.current.x  - mouseCur.current.x)  * 0.07
      mouseCur.current.y  += (mouseTgt.current.y  - mouseCur.current.y)  * 0.07
      scrollCur.current   += (scrollTgt.current   - scrollCur.current)   * 0.10

      const el = rootRef.current
      if (el) {
        // Quantize to integers to skip writes when sub-pixel changes occur
        const mx = Math.round(mouseCur.current.x  * 10000)
        const my = Math.round(mouseCur.current.y  * 10000)
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
    // Many pages scroll inside <main> (per AppShell), so listen there too
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
        // CSS variables initialised — updated by rAF every frame
        '--mx': 0.5, '--my': 0.5, '--sc': 0,
      } as React.CSSProperties}
    >
      {/* 1 — base */}
      <div className="absolute inset-0" style={{ background: '#08080D' }} />

      {/* 2 — slowly drifting radial blobs (independent of mouse) */}
      <div
        className="absolute -inset-20"
        style={{
          background:
            'radial-gradient(60% 50% at 25% 30%, rgba(123,97,255,0.16), transparent 60%), ' +
            'radial-gradient(55% 45% at 80% 75%, rgba(167,139,250,0.13), transparent 60%)',
          animation: 'bgDrift 28s ease-in-out infinite alternate',
          willChange: 'transform',
        }}
      />

      {/* 3a — far parallax layer (subtle shift) */}
      <div
        className="absolute inset-0 chess-layer chess-layer-far"
        style={{
          transform:
            'translate3d(calc((var(--mx) - 0.5) * -8px), calc((var(--my) - 0.5) * -8px), 0)',
        }}
      >
        {LAYER_FAR.map((p, i) => (
          <span key={i}
            className="absolute select-none font-serif"
            style={{
              top: p.top, left: p.left,
              fontSize: p.size, color: 'rgba(180,160,255,0.025)',
              transform: `rotate(${p.rotate}deg)`,
              lineHeight: 1,
              textShadow: '0 0 40px rgba(123,97,255,0.06)',
            }}
          >{p.glyph}</span>
        ))}
      </div>

      {/* 3b — mid parallax layer */}
      <div
        className="absolute inset-0 chess-layer chess-layer-mid"
        style={{
          transform:
            'translate3d(calc((var(--mx) - 0.5) * -18px), calc((var(--my) - 0.5) * -18px), 0)',
        }}
      >
        {LAYER_MID.map((p, i) => (
          <span key={i}
            className="absolute select-none font-serif"
            style={{
              top: p.top, left: p.left,
              fontSize: p.size, color: 'rgba(180,160,255,0.035)',
              transform: `rotate(${p.rotate}deg)`,
              lineHeight: 1,
              textShadow: '0 0 50px rgba(123,97,255,0.08)',
            }}
          >{p.glyph}</span>
        ))}
      </div>

      {/* 3c — near parallax layer (largest shift) */}
      <div
        className="absolute inset-0 chess-layer chess-layer-near"
        style={{
          transform:
            'translate3d(calc((var(--mx) - 0.5) * -34px), calc((var(--my) - 0.5) * -34px), 0)',
        }}
      >
        {LAYER_NEAR.map((p, i) => (
          <span key={i}
            className="absolute select-none font-serif"
            style={{
              top: p.top, left: p.left,
              fontSize: p.size, color: 'rgba(190,170,255,0.045)',
              transform: `rotate(${p.rotate}deg)`,
              lineHeight: 1,
              textShadow: '0 0 60px rgba(123,97,255,0.10)',
            }}
          >{p.glyph}</span>
        ))}
      </div>

      {/* 4 — cursor-following spotlight */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(620px circle at calc(var(--mx) * 100%) calc(var(--my) * 100%), ' +
            'rgba(123,97,255,0.18) 0%, ' +
            'rgba(123,97,255,0.06) 25%, ' +
            'transparent 55%)',
        }}
      />

      {/* 5 — faint dot grid texture */}
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(190,170,255,0.6) 1px, transparent 0)',
          backgroundSize: '32px 32px',
          // tiny parallax on the grid for depth
          transform:
            'translate3d(calc((var(--mx) - 0.5) * -4px), calc((var(--my) - 0.5) * -4px), 0)',
        }}
      />

      {/* 6 — scroll accent at top edge */}
      <div
        className="absolute top-0 inset-x-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(123,97,255,0.6), transparent)',
          // line shifts horizontally with scroll for a subtle progress hint
          transform: 'translateX(calc(var(--sc) * -0.2px))',
          opacity: 0.7,
        }}
      />

      {/* 7 — vignette to keep edges quiet */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 55%, rgba(5,5,10,0.55) 100%)',
        }}
      />

      {/* Drift keyframes */}
      <style>{`
        @keyframes bgDrift {
          0%   { transform: translate3d(0, 0, 0) scale(1); }
          50%  { transform: translate3d(-30px, 20px, 0) scale(1.04); }
          100% { transform: translate3d(20px, -30px, 0) scale(1); }
        }
      `}</style>
    </div>
  )
}
