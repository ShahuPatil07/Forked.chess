/**
 * Chess.com ↔ Lichess rating scale — a copy of backend/ratings.py RAPID_SCALE
 * (ChessGoals rating-comparison survey, rapid columns). Keep the two in sync;
 * tests/test_ratings.py checks they agree.
 *
 * The gap is not a constant "+200": it is ~+475 at the bottom, ~+260 around
 * 1600 Chess.com and the scales meet near 2400.
 */
import type { Platform } from '../types'

export const RAPID_SCALE: [number, number][] = [
  [815, 1290], [905, 1360], [995, 1425], [1085, 1490], [1170, 1555], [1255, 1615],
  [1340, 1680], [1380, 1710], [1420, 1740], [1460, 1765], [1500, 1795], [1540, 1825],
  [1580, 1850], [1620, 1880], [1655, 1905], [1690, 1935], [1730, 1960], [1765, 1990],
  [1800, 2015], [1835, 2040], [1870, 2065], [1900, 2090], [1935, 2115], [1965, 2140],
  [1995, 2165], [2055, 2215], [2110, 2260], [2165, 2310], [2215, 2355], [2260, 2400],
  [2300, 2445], [2340, 2490], [2375, 2530], [2405, 2575], [2430, 2615],
]

function interp(x: number, pairs: [number, number][]): number {
  const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1])
  if (x <= xs[0]) return Math.round(ys[0] + (x - xs[0]) * (ys[1] - ys[0]) / (xs[1] - xs[0]))
  const n = xs.length - 1
  if (x >= xs[n]) return Math.round(ys[n] + (x - xs[n]) * (ys[n] - ys[n - 1]) / (xs[n] - xs[n - 1]))
  for (let i = 1; i <= n; i++) {
    if (x <= xs[i]) {
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
      return Math.round(ys[i - 1] + t * (ys[i] - ys[i - 1]))
    }
  }
  return ys[n]
}

export const chesscomToLichess = (r: number) => interp(r, RAPID_SCALE)
export const lichessToChesscom = (r: number) => interp(r, RAPID_SCALE.map(([a, b]) => [b, a]))

export function toLichess(r: number, platform: Platform): number {
  return platform === 'lichess' ? Math.round(r) : chesscomToLichess(r)
}
export function fromLichess(r: number, platform: Platform): number {
  return platform === 'lichess' ? Math.round(r) : lichessToChesscom(r)
}

export const platformName = (p: Platform) => (p === 'chesscom' ? 'Chess.com' : 'Lichess')

/** "1588 Chess.com ≈ 1853 Lichess" */
export function bothScales(r: number, platform: Platform): string {
  const other: Platform = platform === 'chesscom' ? 'lichess' : 'chesscom'
  const converted = platform === 'chesscom' ? chesscomToLichess(r) : lichessToChesscom(r)
  return `${Math.round(r)} ${platformName(platform)} ≈ ${converted} ${platformName(other)}`
}
