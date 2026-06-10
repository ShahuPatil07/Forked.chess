// Ported from CameraChessWeb (runPiecesModel + processBoxesAndScores).
// Runs the pieces model on a frame and returns either the raw boxes/scores
// (for board mapping) or NMS-reduced detection centres (for corner finding).
import * as tf from '@tensorflow/tfjs-core'
import type { GraphModel } from '@tensorflow/tfjs-converter'
import { getBoxesAndScores, getCenters, getInput, sourceSize, type FrameSource } from './detect'

export interface PieceBoxesScores {
  boxes: tf.Tensor2D
  scores: tf.Tensor2D
}

// Runs a model and decodes its predictions for the given (optional) ROI.
export const detect = (
  model: GraphModel,
  source: FrameSource,
  keypoints: number[][] | null = null,
): PieceBoxesScores => {
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
  tf.dispose([image4D, preds])
  return { boxes, scores }
}

// NMS over the multi-class scores, returning [cx, cy, classIndex] per detection.
export const processBoxesAndScores = async (
  boxes: tf.Tensor2D,
  scores: tf.Tensor2D,
): Promise<number[][]> => {
  const maxScores = tf.max(scores, 1) as tf.Tensor1D
  const argmaxScores = tf.argMax(scores, 1) as tf.Tensor1D
  const nms = await tf.image.nonMaxSuppressionAsync(boxes, maxScores, 100, 0.3, 0.1)
  const resTensor = tf.tidy(() => {
    const centers = getCenters(tf.gather(boxes, nms, 0) as tf.Tensor2D)
    const cls = tf.expandDims(tf.gather(argmaxScores, nms, 0), 1)
    return tf.concat([centers, cls], 1) as tf.Tensor2D
  })
  const res = resTensor.arraySync()
  tf.dispose([nms, resTensor, boxes, scores, argmaxScores, maxScores])
  return res
}

// Detect pieces over the whole frame as [cx, cy, classIndex] rows.
export const detectPieceCenters = async (
  model: GraphModel,
  source: FrameSource,
): Promise<number[][]> => {
  const { boxes, scores } = detect(model, source)
  // processBoxesAndScores disposes boxes & scores.
  return processBoxesAndScores(boxes, scores)
}
