export const clamp = (x: number, min: number, max: number): number => {
  return Math.max(min, Math.min(x, max))
}

export const zeros = (rows: number, columns: number): number[][] => {
  return Array.from({ length: rows }, () => Array(columns).fill(0))
}
