/**
 * Theme constants for places that need literal colour values (react-chessboard
 * props, SVG, canvas, inline styles). Keep in sync with tailwind.config.js.
 */
export const NEON = '#C8FF2A'
export const NEON_SOFT = '#D7FF5C'
export const NEON_PALE = '#E9FF9E'
export const NEON_RGB = '200,255,42'

export const BG = { 0: '#050505', 1: '#0C0C0C', 2: '#151515', 3: '#1F1F1F' } as const
export const TEXT = { 0: '#F5F5F5', 1: '#A3A3A3', 2: '#6B6B6B' } as const

/** Graphite board: neutral squares so neon highlights and arrows carry the colour. */
export const BOARD_DARK = '#5C5C5C'
export const BOARD_LIGHT = '#A9A9A9'
export const LAST_MOVE = 'rgba(200,255,42,0.32)'

/** Coach board arrows: the recommended move in neon, alternatives in white, threats/mistakes in red. */
export const ARROW_BEST = NEON
export const ARROW_ALT = 'rgba(245,245,245,0.75)'
export const ARROW_THREAT = 'rgba(255,90,90,0.9)'
export const PUZZLE_WRONG = 'rgba(255,90,90,0.9)'
export const HINT_SQUARE = 'rgba(200,255,42,0.45)'

/** Ordered series palette for charts: neon first, then whites and greys. */
export const SERIES = ['#C8FF2A', '#F5F5F5', '#8FD400', '#A3A3A3', '#E9FF9E', '#5E8C00', '#6B6B6B']

/** Puzzle feedback squares (Puzzle Themes board). */
export const PUZZLE_RIGHT = 'rgba(46,230,166,0.42)'
export const PUZZLE_WRONG_SQ = 'rgba(255,77,94,0.45)'
export const SUCCESS = '#2EE6A6'
export const DANGER = '#FF4D5E'

/**
 * Chart series colours. The brand neon is too bright to sit next to another hue
 * in a chart, so data marks use an in-band step of it. Pairs validated with the
 * dataviz palette checker on the #0C0C0C card surface (lightness band, chroma,
 * colour-blind separation, contrast) — keep legends + dashed peer lines as the
 * secondary encoding.
 */
export const CHART = {
  you: '#76A503',      // the player
  peer: '#6F8AD8',     // rating-matched opponents (same games)
  win: '#6F8AD8',      // diverging pair for outcomes (blue ↔ red, never red ↔ green)
  loss: '#E5484D',
  neutral: '#8A8F98',
  grid: '#1F1F1F',
  axis: '#6B6B6B',
  surface: '#0C0C0C',
} as const
