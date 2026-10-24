/**
 * Shared display formatting. Evaluations are shown in POINTS (pawns), never
 * centipawns: −193cp → "−1.9 pts". Use these helpers instead of hand-rolled
 * `/ 100` maths so every page reads the same.
 */

const MINUS = '−'

/** Centipawns → "+1.9" / "−0.4" (no unit). */
export function pts(cp: number | null | undefined, digits = 1): string {
  if (cp == null || Number.isNaN(cp)) return '—'
  const v = cp / 100
  const s = Math.abs(v).toFixed(digits)
  if (Number(s) === 0) return (0).toFixed(digits)
  return (v > 0 ? '+' : MINUS) + s
}

/** Centipawns → "+1.9 pts". */
export function ptsLabel(cp: number | null | undefined, digits = 1): string {
  return cp == null ? '—' : `${pts(cp, digits)} pts`
}

/** A loss in centipawns (always positive) → "−1.9 pts". */
export function lossPts(cp: number | null | undefined, digits = 1): string {
  if (cp == null) return '—'
  // mate scores are stored as huge centipawn values; a 20-point swing already means "lost"
  if (Math.abs(cp) >= 2000) return `${MINUS}20+ pts`
  return `${MINUS}${(Math.abs(cp) / 100).toFixed(digits)} pts`
}

/** Engine score (white POV) with mate support → "+1.9", "M3", "−M2". */
export function evalText(cp: number | null | undefined, mate: number | null | undefined, digits = 1): string {
  if (mate != null) {
    if (mate === 0) return '#'
    return `${mate > 0 ? '' : MINUS}M${Math.abs(mate)}`
  }
  return pts(cp, digits)
}

/** White's share of the eval bar (0–100) from a white-POV score. */
export function whiteShare(cp: number | null | undefined, mate: number | null | undefined): number {
  if (mate != null) return mate > 0 || (mate === 0) ? 100 : 0
  if (cp == null) return 50
  return Math.max(3, Math.min(97, 100 / (1 + Math.exp(-0.00368208 * cp))))
}

/** An expected-score loss (0–1) → "18%" of winning chances. */
export function pctLoss(loss: number | null | undefined): string {
  return loss == null ? '—' : `${Math.round(loss * 100)}%`
}

export function percent(x: number | null | undefined, digits = 0): string {
  return x == null ? '—' : `${(x * 100).toFixed(digits)}%`
}

export function shortDate(unix: number | null | undefined): string {
  if (!unix) return '—'
  const ms = unix > 1e11 ? unix : unix * 1000
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function relativeTime(unix: number | null | undefined): string {
  if (!unix) return ''
  const ms = unix > 1e11 ? unix : unix * 1000
  const diff = (Date.now() - ms) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)} d ago`
  return shortDate(unix)
}

export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
