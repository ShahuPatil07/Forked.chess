// Ported from CameraChessWeb (src/utils/detect.tsx).
// Preprocessing (letterbox to 480x288, /255, NHWC) and postprocessing
// (decode YOLO boxes back into source-image coordinates).
import * as tf from '@tensorflow/tfjs-core'
import { MODEL_WIDTH, MODEL_HEIGHT } from './constants'

// A live <video>, an offscreen <canvas>, or raw ImageData. tf.browser.fromPixels
// accepts all three; we only need a consistent way to read its natural size.
export type FrameSource = HTMLVideoElement | HTMLCanvasElement | ImageData

export const sourceSize = (source: FrameSource): { width: number; height: number } => {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight }
  }
  return { width: source.width, height: source.height }
}

export const getBbox = (points: number[][]) => {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const xmin = Math.min(...xs)
  const xmax = Math.max(...xs)
  const ymin = Math.min(...ys)
  const ymax = Math.max(...ys)
  return {
    xmin,
    xmax,
    ymin,
    ymax,
    width: xmax - xmin,
    height: ymax - ymin,
  }
}

export interface ModelInput {
  image4D: tf.Tensor4D
  width: number
  height: number
  padding: number[]
  roi: number[]
}

// Builds the model input tensor. When `keypoints` is supplied, the input is
// cropped to a padded ROI around those points (used for the second-pass
// corner detection); otherwise the whole frame is used.
export const getInput = (
  source: FrameSource,
  keypoints: number[][] | null = null,
  paddingRatio = 12,
): ModelInput => {
  const { width: videoWidth, height: videoHeight } = sourceSize(source)

  let roi: number[]
  if (keypoints !== null) {
    const bbox = getBbox(keypoints)
    let paddingLeft = Math.floor(bbox.width / paddingRatio)
    let paddingRight = Math.floor(bbox.width / paddingRatio)
    let paddingTop = Math.floor(bbox.height / paddingRatio)
    const paddingBottom = Math.floor(bbox.height / paddingRatio)

    const paddedRoiWidth = bbox.width + paddingLeft + paddingRight
    const paddedRoiHeight = bbox.height + paddingTop + paddingBottom
    const ratio = paddedRoiHeight / paddedRoiWidth
    const desiredRatio = MODEL_HEIGHT / MODEL_WIDTH

    if (ratio > desiredRatio) {
      const targetWidth = paddedRoiHeight / desiredRatio
      const dx = targetWidth - paddedRoiWidth
      paddingLeft += Math.floor(dx / 2)
      paddingRight += dx - Math.floor(dx / 2)
    } else {
      const targetHeight = paddedRoiWidth * desiredRatio
      paddingTop += targetHeight - paddedRoiHeight
    }
    roi = [
      Math.round(Math.max((videoWidth * (bbox.xmin - paddingLeft)) / MODEL_WIDTH, 0)),
      Math.round(Math.max((videoHeight * (bbox.ymin - paddingTop)) / MODEL_HEIGHT, 0)),
      Math.round(Math.min((videoWidth * (bbox.xmax + paddingRight)) / MODEL_WIDTH, videoWidth)),
      Math.round(Math.min((videoHeight * (bbox.ymax + paddingBottom)) / MODEL_HEIGHT, videoHeight)),
    ]
  } else {
    roi = [0, 0, videoWidth, videoHeight]
  }

  const [image4D, width, height, padding] = tf.tidy(() => {
    let image = tf.browser.fromPixels(source)

    // Crop to ROI
    image = tf.slice(image, [roi[1], roi[0], 0], [roi[3] - roi[1], roi[2] - roi[0], 3])
    const height = image.shape[0]
    const width = image.shape[1]

    // Resize keeping aspect ratio
    const ratio = height / width
    const desiredRatio = MODEL_HEIGHT / MODEL_WIDTH
    let resizeHeight = MODEL_HEIGHT
    let resizeWidth = MODEL_WIDTH
    if (ratio > desiredRatio) {
      resizeWidth = Math.round(MODEL_HEIGHT / ratio)
    } else {
      resizeHeight = Math.round(MODEL_WIDTH * ratio)
    }
    image = tf.image.resizeBilinear(image as tf.Tensor3D, [resizeHeight, resizeWidth])

    // Letterbox pad to model size with grey (114)
    const dx = MODEL_WIDTH - image.shape[1]
    const dy = MODEL_HEIGHT - image.shape[0]
    const padRight = Math.floor(dx / 2)
    const padLeft = dx - padRight
    const padBottom = Math.floor(dy / 2)
    const padTop = dy - padBottom
    const padding = [padLeft, padRight, padTop, padBottom]
    image = tf.pad(
      image,
      [
        [padTop, padBottom],
        [padLeft, padRight],
        [0, 0],
      ],
      114,
    )

    const image4D = tf.expandDims(tf.div(image, 255.0), 0) as tf.Tensor4D
    return [image4D, width, height, padding] as [tf.Tensor4D, number, number, number[]]
  })

  return { image4D, width, height, padding, roi }
}

// Decodes raw YOLO predictions [1, channels, n] into boxes (l,t,r,b in
// source-frame pixel coords scaled to model space) and per-class scores.
export const getBoxesAndScores = (
  preds: tf.Tensor3D,
  width: number,
  height: number,
  videoWidth: number,
  videoHeight: number,
  padding: number[],
  roi: number[],
): { boxes: tf.Tensor2D; scores: tf.Tensor2D } => {
  return tf.tidy(() => {
    const predsT = tf.transpose(preds, [0, 2, 1])

    const w = tf.slice(predsT, [0, 0, 2], [-1, -1, 1])
    const h = tf.slice(predsT, [0, 0, 3], [-1, -1, 1])

    // xc, yc, w, h -> l, t, r, b
    let l = tf.sub(tf.slice(predsT, [0, 0, 0], [-1, -1, 1]), tf.div(w, 2))
    let t = tf.sub(tf.slice(predsT, [0, 0, 1], [-1, -1, 1]), tf.div(h, 2))
    let r = tf.add(l, w)
    let b = tf.add(t, h)

    // Remove letterbox padding
    l = tf.sub(l, padding[0])
    r = tf.sub(r, padding[0])
    t = tf.sub(t, padding[2])
    b = tf.sub(b, padding[2])

    // Scale to cropped ROI size
    l = tf.mul(l, width / (MODEL_WIDTH - padding[0] - padding[1]))
    r = tf.mul(r, width / (MODEL_WIDTH - padding[0] - padding[1]))
    t = tf.mul(t, height / (MODEL_HEIGHT - padding[2] - padding[3]))
    b = tf.mul(b, height / (MODEL_HEIGHT - padding[2] - padding[3]))

    // Translate by ROI origin
    l = tf.add(l, roi[0])
    r = tf.add(r, roi[0])
    t = tf.add(t, roi[1])
    b = tf.add(b, roi[1])

    // Scale into model space (relative to full frame)
    l = tf.mul(l, MODEL_WIDTH / videoWidth)
    r = tf.mul(r, MODEL_WIDTH / videoWidth)
    t = tf.mul(t, MODEL_HEIGHT / videoHeight)
    b = tf.mul(b, MODEL_HEIGHT / videoHeight)

    const boxes = tf.squeeze(tf.concat([l, t, r, b], 2)) as tf.Tensor2D
    const scores = tf.squeeze(
      tf.slice(predsT, [0, 0, 4], [-1, -1, predsT.shape[2] - 4]),
      [0],
    ) as tf.Tensor2D

    return { boxes, scores }
  })
}

export const getCenters = (boxes: tf.Tensor2D): tf.Tensor2D => {
  return tf.tidy(() => {
    const l = tf.slice(boxes, [0, 0], [-1, 1])
    const t = tf.slice(boxes, [0, 1], [-1, 1])
    const r = tf.slice(boxes, [0, 2], [-1, 1])
    const b = tf.slice(boxes, [0, 3], [-1, 1])
    const cx = tf.div(tf.add(l, r), 2)
    const cy = tf.div(tf.add(t, b), 2)
    return tf.concat([cx, cy], 1) as tf.Tensor2D
  })
}
