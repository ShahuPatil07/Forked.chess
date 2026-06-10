// Main orchestrator. Wraps CameraChessWeb's CV + probabilistic matcher in a
// small state machine and exposes the Forked scanner interface.
import * as tf from '@tensorflow/tfjs-core'
import { loadModels, type Models } from '../cv/models'
import { findCorners, modelToDisplay } from '../cv/cornerDetector'
import { detect } from '../cv/pieceDetector'
import { getSquares, getUpdate, updateState } from '../cv/boardMapper'
import { getInvTransform, transformCenters, transformBoundary } from '../cv/warp'
import { StabilityDetector, type BoardRegion } from '../cv/stabilityDetector'
import type { FrameSource } from '../cv/detect'
import { CORNER_KEYS, START_FEN, type CornersDict } from '../cv/constants'
import { zeros } from '../cv/math'
import { TrackedBoard } from './board'
import { getMovesPairs } from './moves'
import { processState, calculateScore } from './moveInference'
import type { MovesPair, TrackerState, TrackerUpdate } from './types'
import { parseSan } from 'chessops/san'
import { makeUci } from 'chessops/util'

// Two distinct first-ply moves whose scores fall within this margin are
// treated as ambiguous and surfaced to the user for correction.
const AMBIGUITY_MARGIN = 0.15

const sanToUci = (board: TrackedBoard, san: string): string | null => {
  const move = parseSan(board.pos, san)
  return move ? makeUci(move) : null
}

export class GameTracker {
  private models: Models | null = null
  private state: TrackerState = 'idle'

  private board = new TrackedBoard(START_FEN)
  private movesPairs: MovesPair[] = []
  private possibleMoves = new Set<string>()
  private greedyMoveToTime: Record<string, number> = {}

  private boardState: number[][] = zeros(64, 12)
  private stability = new StabilityDetector()

  // Locked board geometry (set on confirmStartPosition).
  private corners: CornersDict | null = null
  private keypoints: number[][] | null = null
  private centers3D: tf.Tensor3D | null = null
  private boundary3D: tf.Tensor3D | null = null

  // Latest calibration read (live, before locking).
  private liveCorners: CornersDict | null = null
  private liveConfidence = 0
  private liveXCorners: number[][] = []

  private lastMove: string | null = null
  private correctionOptions: string[] = []

  async init(): Promise<void> {
    this.models = await loadModels()
  }

  get ready(): boolean {
    return this.models !== null
  }

  startCalibration(): void {
    if (this.state === 'idle' || this.state === 'finished') {
      this.reset()
    }
    this.state = 'calibrating'
  }

  // Called every animation frame. `motion` (raw ImageData) drives the
  // stability gate; `source` (ideally the live <video>) drives inference.
  async processFrame(source: FrameSource, motion?: ImageData): Promise<TrackerUpdate> {
    if (!this.models) return this.snapshot()

    if (this.state === 'calibrating') {
      await this.runCalibration(source)
      return this.snapshot()
    }

    if (this.state === 'playing' || this.state === 'correction_needed') {
      const motionImage = motion ?? (source instanceof ImageData ? source : undefined)
      const region = this.boardRegionFor(motionImage)
      const { stable } = motionImage
        ? this.stability.update(motionImage, region)
        : { stable: true }

      // Only run the (expensive) piece model on still frames.
      if (stable && this.state === 'playing') {
        await this.runTracking(source)
      }
    }

    return this.snapshot()
  }

  private async runCalibration(source: FrameSource): Promise<void> {
    const result = await findCorners(this.models!, source)
    if (result.ok) {
      this.liveCorners = result.corners
      this.liveConfidence = result.confidence
      this.liveXCorners = result.xCorners
    } else {
      this.liveConfidence = 0
      this.liveXCorners = result.xCorners
    }
  }

  // Lock the current corner detection and begin tracking from the standard
  // starting position (the usual case for a full OTB game).
  confirmStartPosition(): boolean {
    if (!this.liveCorners || this.liveConfidence <= 0) return false
    this.lockCorners(this.liveCorners)

    this.board = new TrackedBoard(START_FEN)
    this.boardState = zeros(64, 12)
    this.possibleMoves = new Set<string>()
    this.greedyMoveToTime = {}
    this.movesPairs = getMovesPairs(this.board.pos)
    this.lastMove = null
    this.correctionOptions = []
    this.stability.reset()
    this.state = 'playing'
    return true
  }

  private lockCorners(corners: CornersDict): void {
    this.disposeGeometry()
    this.corners = corners
    this.keypoints = CORNER_KEYS.map((k) => corners[k])
    const invTransform = getInvTransform(this.keypoints)
    const [, centers3D] = transformCenters(invTransform)
    const [, boundary3D] = transformBoundary(invTransform)
    this.centers3D = tf.keep(centers3D)
    this.boundary3D = tf.keep(boundary3D)
  }

  private async runTracking(source: FrameSource): Promise<void> {
    if (!this.centers3D || !this.boundary3D || !this.keypoints) return

    const { boxes, scores } = detect(this.models!.pieces, source, this.keypoints)
    const squares = getSquares(boxes, this.centers3D, this.boundary3D)
    const update = getUpdate(scores, squares)
    this.boardState = updateState(this.boardState, update)
    tf.dispose([boxes, scores])

    this.evaluateAndMaybePlay()
  }

  private evaluateAndMaybePlay(now: number = performance.now()): void {
    const { bestScore1, bestScore2, bestJointScore, bestMove, bestMoves } =
      processState(this.boardState, this.movesPairs, this.possibleMoves)

    // Fast two-ply exchange: accept immediately.
    let hasMove = false
    if (bestMoves !== null) {
      const move = bestMoves.sans[0]
      hasMove = bestScore2 > 0 && bestJointScore > 0 && this.possibleMoves.has(move)
      if (hasMove) {
        this.acceptMove(move)
        return
      }
    }

    // Single move: require it to persist for ~1s before committing (greedy).
    if (bestMove !== null && !hasMove && bestScore1 > 0) {
      const move = bestMove.sans[0]
      if (!(move in this.greedyMoveToTime)) this.greedyMoveToTime[move] = now

      const secondElapsed = now - this.greedyMoveToTime[move] > 1000
      const newMove = sanToUci(this.board, move) !== this.lastMove

      if (secondElapsed && newMove) {
        // Before committing, check for a competing legal move (ambiguity).
        const competitor = this.findAmbiguousCompetitor(move, bestScore1)
        if (competitor) {
          this.raiseCorrection([move, competitor])
          return
        }
        this.acceptMove(move)
      }
    }
  }

  // Returns a distinct first-ply SAN whose score is within AMBIGUITY_MARGIN of
  // the leader, or null if the leader is clear.
  private findAmbiguousCompetitor(leaderSan: string, leaderScore: number): string | null {
    const seen = new Set<string>()
    let competitor: string | null = null
    let bestOther = Number.NEGATIVE_INFINITY
    for (const pair of this.movesPairs) {
      const san = pair.move1.sans[0]
      if (san === leaderSan || seen.has(san)) continue
      seen.add(san)
      const score = calculateScore(this.boardState, pair.move1)
      if (score > 0 && score > bestOther && leaderScore - score < AMBIGUITY_MARGIN) {
        bestOther = score
        competitor = san
      }
    }
    return competitor
  }

  private raiseCorrection(sans: string[]): void {
    this.correctionOptions = sans
    this.state = 'correction_needed'
  }

  private acceptMove(san: string): void {
    this.board.playSan(san)
    this.afterMovePlayed()
  }

  private afterMovePlayed(): void {
    this.possibleMoves.clear()
    this.greedyMoveToTime = {}
    this.movesPairs = getMovesPairs(this.board.pos)
    this.boardState = zeros(64, 12)
    this.lastMove = this.board.lastMoveUci()
    this.correctionOptions = []
    if (this.state === 'correction_needed') this.state = 'playing'
  }

  // Resolve a correction, or manually enter a move the scanner missed.
  // Accepts SAN ("Nf3") or UCI ("g1f3").
  correctMove(move: string): boolean {
    const played = this.board.playUci(move) ?? this.board.playSan(move)
    if (!played) return false
    this.afterMovePlayed()
    this.state = 'playing'
    return true
  }

  dismissCorrection(): void {
    this.correctionOptions = []
    if (this.state === 'correction_needed') this.state = 'playing'
  }

  // Re-read the whole board from the current frame and try to recover by
  // matching the accumulated state to a legal move. Returns whether a move was
  // committed. If nothing confident is found, raises correction for manual fix.
  async resync(source: FrameSource): Promise<boolean> {
    if (!this.models || !this.centers3D || !this.boundary3D || !this.keypoints) {
      return false
    }
    const before = this.board.lastMoveUci()
    // Accumulate a few frames to stabilise the read.
    for (let i = 0; i < 4; i++) {
      const { boxes, scores } = detect(this.models.pieces, source, this.keypoints)
      const squares = getSquares(boxes, this.centers3D, this.boundary3D)
      const update = getUpdate(scores, squares)
      this.boardState = updateState(this.boardState, update)
      tf.dispose([boxes, scores])
    }
    this.evaluateAndMaybePlay()
    return this.board.lastMoveUci() !== before
  }

  finishGame(): string {
    this.state = 'finished'
    return this.board.pgn()
  }

  reset(): void {
    this.disposeGeometry()
    this.board = new TrackedBoard(START_FEN)
    this.movesPairs = []
    this.possibleMoves = new Set<string>()
    this.greedyMoveToTime = {}
    this.boardState = zeros(64, 12)
    this.stability.reset()
    this.corners = null
    this.keypoints = null
    this.liveCorners = null
    this.liveConfidence = 0
    this.liveXCorners = []
    this.lastMove = null
    this.correctionOptions = []
    this.state = 'idle'
  }

  private disposeGeometry(): void {
    if (this.centers3D) tf.dispose(this.centers3D)
    if (this.boundary3D) tf.dispose(this.boundary3D)
    this.centers3D = null
    this.boundary3D = null
  }

  // ---- read-only views for the UI ----

  snapshot(): TrackerUpdate {
    const calibrating = this.state === 'calibrating'
    return {
      state: this.state,
      fen: this.board.fen(),
      moves: this.board.sanMoves(),
      lastMove: this.lastMove,
      correctionOptions: [...this.correctionOptions],
      cornersDetected: calibrating ? this.liveConfidence > 0 : this.corners !== null,
      cornerConfidence: calibrating ? this.liveConfidence : this.corners ? 1 : 0,
    }
  }

  pgn(): string {
    return this.board.pgn()
  }

  // Corner dots (display pixels) for the overlay, or null if none yet.
  displayCorners(displayWidth: number, displayHeight: number): number[][] | null {
    const src = this.state === 'calibrating' ? this.liveCorners : this.corners
    if (!src) return null
    return CORNER_KEYS.map((k) => modelToDisplay(src[k], displayWidth, displayHeight))
  }

  displayXCorners(displayWidth: number, displayHeight: number): number[][] {
    if (this.state !== 'calibrating') return []
    return this.liveXCorners.map((p) => modelToDisplay(p, displayWidth, displayHeight))
  }

  // Board region (in motion-image pixels) for the stability gate, derived from
  // the locked corners' bounding box.
  private boardRegionFor(motion?: ImageData): BoardRegion | undefined {
    if (!motion || !this.corners) return undefined
    const pts = CORNER_KEYS.map((k) =>
      modelToDisplay(this.corners![k], motion.width, motion.height),
    )
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
  }
}
