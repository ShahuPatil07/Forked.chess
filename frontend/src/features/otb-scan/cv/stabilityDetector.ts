// Frame-differencing motion gate. Piece detection only runs on frames that
// have been visually still for a short window (hands out of the way).
// Not part of CameraChessWeb — added per the Forked scanner spec.

export interface StabilityResult {
  changedFraction: number
  /** True once the frame has been still for `stableMs`. */
  stable: boolean
}

export interface BoardRegion {
  x: number
  y: number
  width: number
  height: number
}

export class StabilityDetector {
  private prev: Float32Array | null = null
  private prevW = 0
  private prevH = 0
  private stableSince: number | null = null

  constructor(
    /** Fraction of changed pixels below which a frame counts as still. */
    private readonly changeThreshold = 0.02,
    /** How long the frame must stay still before `stable` flips true (ms). */
    private readonly stableMs = 1500,
    /** Per-pixel luminance delta (0-255) that counts as "changed". */
    private readonly pixelDelta = 24,
    /** Sample stride for speed (every Nth pixel). */
    private readonly stride = 2,
  ) {}

  reset(): void {
    this.prev = null
    this.stableSince = null
  }

  // Feed a frame; returns the changed fraction and whether we're stable.
  update(
    image: ImageData,
    region?: BoardRegion,
    now: number = performance.now(),
  ): StabilityResult {
    const { data, width, height } = image
    const x0 = region ? Math.max(0, Math.floor(region.x)) : 0
    const y0 = region ? Math.max(0, Math.floor(region.y)) : 0
    const x1 = region ? Math.min(width, Math.ceil(region.x + region.width)) : width
    const y1 = region ? Math.min(height, Math.ceil(region.y + region.height)) : height

    const cols = Math.ceil((x1 - x0) / this.stride)
    const rows = Math.ceil((y1 - y0) / this.stride)
    const gray = new Float32Array(cols * rows)

    let k = 0
    for (let y = y0; y < y1; y += this.stride) {
      for (let x = x0; x < x1; x += this.stride) {
        const idx = (y * width + x) * 4
        // Rec. 601 luma
        gray[k++] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]
      }
    }

    // Reset history if the sampled geometry changed.
    if (!this.prev || this.prevW !== cols || this.prevH !== rows) {
      this.prev = gray
      this.prevW = cols
      this.prevH = rows
      this.stableSince = null
      return { changedFraction: 1, stable: false }
    }

    let changed = 0
    for (let i = 0; i < gray.length; i++) {
      if (Math.abs(gray[i] - this.prev[i]) > this.pixelDelta) changed++
    }
    const changedFraction = changed / gray.length
    this.prev = gray

    if (changedFraction < this.changeThreshold) {
      if (this.stableSince === null) this.stableSince = now
    } else {
      this.stableSince = null
    }

    const stable =
      this.stableSince !== null && now - this.stableSince >= this.stableMs
    return { changedFraction, stable }
  }
}
