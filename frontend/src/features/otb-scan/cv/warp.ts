// Ported from CameraChessWeb (src/utils/warp.tsx).
// Homography between the board's 4 corners and an ideal 8x8 grid, used to
// project square centres / board boundary into image space. The frame itself
// is never warped — only points are transformed.
import { array, NDArray, zeros } from 'vectorious'
import * as tf from '@tensorflow/tfjs-core'
import { BOARD_SIZE, SQUARE_SIZE } from './constants'

export const perspectiveTransform = (
  src: number[][],
  transform: NDArray,
): number[][] => {
  if (src[0].length === 2) {
    src = src.map((x) => [x[0], x[1], 1])
  }
  const warpedSrc = array(src).multiply(transform.T)

  for (let i = 0; i < warpedSrc.shape[0]; i++) {
    const x = warpedSrc.get(i, 0)
    const y = warpedSrc.get(i, 1)
    const w = warpedSrc.get(i, 2)
    warpedSrc.set(i, 0, x / w)
    warpedSrc.set(i, 1, y / w)
  }

  return warpedSrc.toArray().map((row: number[]) => row.slice(0, 2))
}

export const getPerspectiveTransform = (
  target: number[][],
  keypoints: number[][],
): NDArray => {
  const A = zeros(8, 8)
  const B = zeros(8, 1)

  for (let i = 0; i < 4; i++) {
    const [x, y] = keypoints[i]
    const [u, v] = target[i]
    A.set(i * 2, 0, x)
    A.set(i * 2, 1, y)
    A.set(i * 2, 2, 1)
    A.set(i * 2, 6, -u * x)
    A.set(i * 2, 7, -u * y)
    A.set(i * 2 + 1, 3, x)
    A.set(i * 2 + 1, 4, y)
    A.set(i * 2 + 1, 5, 1)
    A.set(i * 2 + 1, 6, -v * x)
    A.set(i * 2 + 1, 7, -v * y)
    B.set(i * 2, 0, u)
    B.set(i * 2 + 1, 0, v)
  }

  const solution = A.solve(B).toArray() as number[]
  return array([...solution, 1], { shape: [3, 3] })
}

export const getInvTransform = (keypoints: number[][]): NDArray => {
  const target = [
    [BOARD_SIZE, BOARD_SIZE],
    [0, BOARD_SIZE],
    [0, 0],
    [BOARD_SIZE, 0],
  ]
  return getPerspectiveTransform(target, keypoints).inv()
}

export const transformCenters = (
  invTransform: NDArray,
): [number[][], tf.Tensor3D] => {
  const x = Array.from({ length: 8 }, (_, i) => 0.5 + i)
  const y = Array.from({ length: 8 }, (_, i) => 7.5 - i)
  const warpedCenters = y
    .map((yy) => x.map((xx) => [xx * SQUARE_SIZE, yy * SQUARE_SIZE, 1]))
    .flat()
  const centers = perspectiveTransform(warpedCenters, invTransform)
  const centers3D = tf.tidy(() => tf.expandDims(tf.tensor2d(centers), 0) as tf.Tensor3D)
  return [centers, centers3D]
}

export const transformBoundary = (
  invTransform: NDArray,
): [number[][], tf.Tensor3D] => {
  const warpedBoundary = [
    [-0.5 * SQUARE_SIZE, -0.5 * SQUARE_SIZE, 1],
    [-0.5 * SQUARE_SIZE, 8.5 * SQUARE_SIZE, 1],
    [8.5 * SQUARE_SIZE, 8.5 * SQUARE_SIZE, 1],
    [8.5 * SQUARE_SIZE, -0.5 * SQUARE_SIZE, 1],
  ]
  const boundary = perspectiveTransform(warpedBoundary, invTransform)
  const boundary3D = tf.tidy(() => tf.expandDims(tf.tensor2d(boundary), 0) as tf.Tensor3D)
  return [boundary, boundary3D]
}
