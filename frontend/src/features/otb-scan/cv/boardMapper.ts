// Ported from CameraChessWeb (src/utils/findPieces.tsx: getSquares/getUpdate).
// Assigns each piece detection to its nearest board square (by projected
// square-centre distance) and folds the class scores into a 64x12 grid.
import * as tf from '@tensorflow/tfjs-core'
import { zeros } from './math'

// The "centre" used for assignment is shifted down to roughly where a piece
// touches the board (b - (r - l) / 3), matching CameraChessWeb.
const getBoxCenters = (boxes: tf.Tensor2D): tf.Tensor2D => {
  return tf.tidy(() => {
    const l = tf.slice(boxes, [0, 0], [-1, 1])
    const r = tf.slice(boxes, [0, 2], [-1, 1])
    const b = tf.slice(boxes, [0, 3], [-1, 1])
    const cx = tf.div(tf.add(l, r), 2)
    const cy = tf.sub(b, tf.div(tf.sub(r, l), 3))
    return tf.concat([cx, cy], 1) as tf.Tensor2D
  })
}

// Returns one square index (0..63) per detection, or -1 if the detection's
// centre falls outside the board boundary polygon.
export const getSquares = (
  boxes: tf.Tensor2D,
  centers3D: tf.Tensor3D,
  boundary3D: tf.Tensor3D,
): number[] => {
  return tf.tidy(() => {
    const boxCenters3D = tf.expandDims(getBoxCenters(boxes), 1) as tf.Tensor3D
    const dist = tf.sum(tf.square(tf.sub(boxCenters3D, centers3D)), 2)
    const squares = tf.argMin(dist, 1)

    const shiftedBoundary3D = tf.concat(
      [
        tf.slice(boundary3D, [0, 1, 0], [1, 3, 2]),
        tf.slice(boundary3D, [0, 0, 0], [1, 1, 2]),
      ],
      1,
    )

    const nBoxes = boxCenters3D.shape[0]

    const a = tf.squeeze(
      tf.sub(
        tf.slice(boundary3D, [0, 0, 0], [1, 4, 1]),
        tf.slice(shiftedBoundary3D, [0, 0, 0], [1, 4, 1]),
      ),
      [2],
    )
    const b = tf.squeeze(
      tf.sub(
        tf.slice(boundary3D, [0, 0, 1], [1, 4, 1]),
        tf.slice(shiftedBoundary3D, [0, 0, 1], [1, 4, 1]),
      ),
      [2],
    )
    const c = tf.squeeze(
      tf.sub(
        tf.slice(boxCenters3D, [0, 0, 0], [nBoxes, 1, 1]),
        tf.slice(shiftedBoundary3D, [0, 0, 0], [1, 4, 1]),
      ),
      [2],
    )
    const d = tf.squeeze(
      tf.sub(
        tf.slice(boxCenters3D, [0, 0, 1], [nBoxes, 1, 1]),
        tf.slice(shiftedBoundary3D, [0, 0, 1], [1, 4, 1]),
      ),
      [2],
    )

    const det = tf.sub(tf.mul(a, d), tf.mul(b, c))
    const newSquares = tf.where(
      tf.any(tf.less(det, 0), 1),
      tf.scalar(-1),
      squares,
    ) as tf.Tensor1D

    return newSquares.arraySync() as number[]
  })
}

// Folds detection class scores into a fresh 64x12 grid (max per square/class).
export const getUpdate = (scoresTensor: tf.Tensor2D, squares: number[]): number[][] => {
  const update = zeros(64, 12)
  const scores = scoresTensor.arraySync() as number[][]

  for (let i = 0; i < squares.length; i++) {
    const square = squares[i]
    if (!Number.isInteger(square) || square < 0 || square >= 64) continue
    for (let j = 0; j < 12; j++) {
      update[square][j] = Math.max(update[square][j], scores[i][j])
    }
  }
  return update
}

// Exponential moving average of the per-square state.
export const updateState = (
  state: number[][],
  update: number[][],
  decay = 0.5,
): number[][] => {
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < 12; j++) {
      state[i][j] = decay * state[i][j] + (1 - decay) * update[i][j]
    }
  }
  return state
}
