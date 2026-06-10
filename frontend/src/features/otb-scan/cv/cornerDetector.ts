// Ported from CameraChessWeb (src/utils/findCorners.tsx).
// Two-stage geometric board-corner detection:
//   1. run the pieces model to get piece centres (used to orient a1/h8)
//   2. run the xcorners model to get the ~49 interior grid intersections
//   3. Delaunay-triangulate them into quads, score each quad by how well a
//      perspective fit matches an ideal 7x7 grid, recover the 4 outer corners
import * as tf from '@tensorflow/tfjs-core'
import type { GraphModel } from '@tensorflow/tfjs-converter'
import Delaunator from 'delaunator'
import { NDArray } from 'vectorious'
import { getInput, getBoxesAndScores, sourceSize, type FrameSource } from './detect'
import { getPerspectiveTransform, perspectiveTransform } from './warp'
import { processBoxesAndScores, detectPieceCenters } from './pieceDetector'
import { clamp } from './math'
import {
  MODEL_WIDTH,
  MODEL_HEIGHT,
  CORNER_KEYS,
  type CornersDict,
} from './constants'

const GRID: number[][] = (() => {
  const x = Array.from({ length: 7 }, (_, i) => i)
  const y = Array.from({ length: 7 }, (_, i) => i)
  return y.map((yy) => x.map((xx) => [xx, yy])).flat()
})()
const IDEAL_QUAD: number[][] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
]

export interface CornerResult {
  corners: CornersDict // a1/h1/h8/a8 -> [x, y] in model space (480x288)
  keypoints: number[][] // ordered by CORNER_KEYS (h1, a1, a8, h8)
  xCorners: number[][] // interior grid intersections (for overlay)
  confidence: number // 0..1, fraction of the ideal grid matched
}

const runXcornersModel = async (
  model: GraphModel,
  source: FrameSource,
  pieces: number[][],
): Promise<number[][]> => {
  const keypoints = pieces.map((x) => [x[0], x[1]])
  const { width: videoWidth, height: videoHeight } = sourceSize(source)
  const { image4D, width, height, padding, roi } = getInput(source, keypoints)
  const preds = model.execute(image4D) as tf.Tensor3D
  const { boxes, scores } = getBoxesAndScores(
    preds,
    width,
    height,
    videoWidth,
    videoHeight,
    padding,
    roi,
  )
  tf.dispose([preds, image4D])
  const xCorners = await processBoxesAndScores(boxes, scores)
  return xCorners.map((x) => [x[0], x[1]])
}

const getQuads = (xCorners: number[][]): number[][][] => {
  const intXcorners = xCorners.flat().map((x) => Math.round(x))
  const delaunay = new Delaunator(intXcorners)
  const triangles = delaunay.triangles
  const quads: number[][][] = []
  for (let i = 0; i < triangles.length; i += 3) {
    const t1 = triangles[i]
    const t2 = triangles[i + 1]
    const t3 = triangles[i + 2]
    const quad = [t1, t2, t3, -1]

    for (let j = 0; j < triangles.length; j += 3) {
      if (i === j) continue
      const cond1 =
        (t1 === triangles[j] && t2 === triangles[j + 1]) ||
        (t1 === triangles[j + 1] && t2 === triangles[j])
      const cond2 =
        (t2 === triangles[j] && t3 === triangles[j + 1]) ||
        (t2 === triangles[j + 1] && t3 === triangles[j])
      const cond3 =
        (t3 === triangles[j] && t1 === triangles[j + 1]) ||
        (t3 === triangles[j + 1] && t1 === triangles[j])
      if (cond1 || cond2 || cond3) {
        quad[3] = triangles[j + 2]
        break
      }
    }

    if (quad[3] !== -1) {
      quads.push(quad.map((x) => xCorners[x]))
    }
  }
  return quads
}

const cdist = (a: number[][], b: number[][]): number[][] => {
  const dist = Array.from({ length: a.length }, () => Array(b.length).fill(0))
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const dx = a[i][0] - b[j][0]
      const dy = a[i][1] - b[j][1]
      dist[i][j] = Math.sqrt(dx * dx + dy * dy)
    }
  }
  return dist
}

const calculateOffsetScore = (warpedXcorners: number[][], shift: number[]): number => {
  const grid = GRID.map((x) => [x[0] + shift[0], x[1] + shift[1]])
  const dist = cdist(grid, warpedXcorners)
  let assignmentCost = 0
  for (let i = 0; i < dist.length; i++) {
    assignmentCost += Math.min(...dist[i])
  }
  return 1 / (1 + assignmentCost)
}

const findOffset = (warpedXcorners: number[][]): number[] => {
  const bestOffset = [0, 0]
  for (let i = 0; i < 2; i++) {
    let low = -7
    let high = 1
    const scores: Record<number, number> = {}
    while (high - low > 1) {
      const mid = (high + low) >> 1
      ;[mid, mid + 1].forEach((x) => {
        if (!(x in scores)) {
          const shift = [0, 0]
          shift[i] = x
          scores[x] = calculateOffsetScore(warpedXcorners, shift)
        }
      })
      if (scores[mid] > scores[mid + 1]) {
        high = mid
      } else {
        low = mid
      }
    }
    bestOffset[i] = low + 1
  }
  return bestOffset
}

const scoreQuad = (
  quad: number[][],
  xCorners: number[][],
): [number, NDArray, number[]] => {
  const M = getPerspectiveTransform(IDEAL_QUAD, quad)
  const warpedXcorners = perspectiveTransform(xCorners, M)
  const offset = findOffset(warpedXcorners)
  const score = calculateOffsetScore(warpedXcorners, offset)
  return [score, M, offset]
}

// Fraction of the ideal 7x7 grid that has a detected xcorner within half a cell.
const gridMatchConfidence = (
  xCorners: number[][],
  M: NDArray,
  offset: number[],
): number => {
  const warped = perspectiveTransform(xCorners, M)
  const grid = GRID.map((x) => [x[0] + offset[0], x[1] + offset[1]])
  const dist = cdist(grid, warped)
  let matched = 0
  for (let i = 0; i < dist.length; i++) {
    if (Math.min(...dist[i]) < 0.5) matched++
  }
  return matched / GRID.length
}

const findCornersFromXcorners = (
  xCorners: number[][],
): { corners: number[][]; confidence: number } | undefined => {
  const quads = getQuads(xCorners)
  if (quads.length === 0) return undefined

  let [bestScore, bestM, bestOffset] = scoreQuad(quads[0], xCorners)
  for (let i = 1; i < quads.length; i++) {
    const [score, M, offset] = scoreQuad(quads[i], xCorners)
    if (score > bestScore) {
      bestScore = score
      bestM = M
      bestOffset = offset
    }
  }

  const invM = bestM.inv()
  const warpedCorners = [
    [bestOffset[0] - 1, bestOffset[1] - 1],
    [bestOffset[0] - 1, bestOffset[1] + 7],
    [bestOffset[0] + 7, bestOffset[1] + 7],
    [bestOffset[0] + 7, bestOffset[1] - 1],
  ]
  const corners = perspectiveTransform(warpedCorners, invM)

  // Clamp corners to the model frame.
  for (let i = 0; i < 4; i++) {
    corners[i][0] = clamp(corners[i][0], 0, MODEL_WIDTH)
    corners[i][1] = clamp(corners[i][1], 0, MODEL_HEIGHT)
  }

  const confidence = gridMatchConfidence(xCorners, bestM, bestOffset)
  return { corners, confidence }
}

const getCenter = (points: number[][]): number[] => {
  let center = points.reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0])
  center = center.map((x) => x / points.length)
  return center
}

const euclidean = (a: number[], b: number[]): number => {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return Math.sqrt(dx * dx + dy * dy)
}

// Orient the 4 corners into a1/h1/h8/a8 using the centroids of the white and
// black pieces (white sits near the a1-h1 edge, black near a8-h8).
const calculateKeypoints = (
  blackPieces: number[][],
  whitePieces: number[][],
  corners: number[][],
): CornersDict => {
  const blackCenter = getCenter(blackPieces)
  const whiteCenter = getCenter(whitePieces)

  let bestShift = 0
  let bestScore = 0
  for (let shift = 0; shift < 4; shift++) {
    const cw = [
      (corners[shift % 4][0] + corners[(shift + 1) % 4][0]) / 2,
      (corners[shift % 4][1] + corners[(shift + 1) % 4][1]) / 2,
    ]
    const cb = [
      (corners[(shift + 2) % 4][0] + corners[(shift + 3) % 4][0]) / 2,
      (corners[(shift + 2) % 4][1] + corners[(shift + 3) % 4][1]) / 2,
    ]
    const score = 1 / (1 + euclidean(whiteCenter, cw) + euclidean(blackCenter, cb))
    if (score > bestScore) {
      bestScore = score
      bestShift = shift
    }
  }

  return {
    a1: corners[bestShift % 4],
    h1: corners[(bestShift + 1) % 4],
    h8: corners[(bestShift + 2) % 4],
    a8: corners[(bestShift + 3) % 4],
  }
}

export interface FindCornersFailure {
  ok: false
  reason: string
  xCorners: number[][]
}
export interface FindCornersSuccess extends CornerResult {
  ok: true
}
export type FindCornersResult = FindCornersSuccess | FindCornersFailure

// Full corner-detection pass over a frame.
export const findCorners = async (
  models: { pieces: GraphModel; xcorners: GraphModel },
  source: FrameSource,
): Promise<FindCornersResult> => {
  const startTensors = tf.memory().numTensors

  const pieces = await detectPieceCenters(models.pieces, source)
  const blackPieces = pieces.filter((x) => x[2] <= 5)
  const whitePieces = pieces.filter((x) => x[2] > 5)
  if (blackPieces.length === 0 || whitePieces.length === 0) {
    return { ok: false, reason: 'No pieces to orient the board', xCorners: [] }
  }

  const xCorners = await runXcornersModel(models.xcorners, source, pieces)
  if (xCorners.length < 5) {
    return {
      ok: false,
      reason: `Need >=5 interior corners (found ${xCorners.length})`,
      xCorners,
    }
  }

  const found = findCornersFromXcorners(xCorners)
  if (found === undefined) {
    return { ok: false, reason: 'Failed to fit board grid', xCorners }
  }

  const corners = calculateKeypoints(blackPieces, whitePieces, found.corners)
  const keypoints = CORNER_KEYS.map((k) => corners[k])

  const endTensors = tf.memory().numTensors
  if (startTensors < endTensors) {
    console.warn(`findCorners leaked tensors (${endTensors} > ${startTensors})`)
  }

  return {
    ok: true,
    corners,
    keypoints,
    xCorners,
    confidence: found.confidence,
  }
}

// Map a model-space point (480x288) to display pixels on a w x h canvas/video.
export const modelToDisplay = (
  xy: number[],
  displayWidth: number,
  displayHeight: number,
): number[] => {
  return [
    (xy[0] / MODEL_WIDTH) * displayWidth,
    (xy[1] / MODEL_HEIGHT) * displayHeight,
  ]
}
