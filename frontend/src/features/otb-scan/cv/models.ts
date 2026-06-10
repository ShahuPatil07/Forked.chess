// Loads the two LeYOLO TFJS graph models (ported from CameraChessWeb's
// loadModels.tsx) and warms them up. We use the WebGL backend for speed and
// fall back to whatever tf has available.
import * as tf from '@tensorflow/tfjs-core'
import '@tensorflow/tfjs-backend-webgl'
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter'
import {
  MODEL_HEIGHT,
  MODEL_WIDTH,
  PIECES_MODEL_URL,
  XCORNERS_MODEL_URL,
} from './constants'

export interface Models {
  pieces: GraphModel
  xcorners: GraphModel
}

let modelsPromise: Promise<Models> | null = null

export const loadModels = (): Promise<Models> => {
  if (modelsPromise) return modelsPromise

  modelsPromise = (async (): Promise<Models> => {
    await tf.ready()
    try {
      await tf.setBackend('webgl')
    } catch {
      // Fall back to the default backend (wasm/cpu) if webgl is unavailable.
    }

    tf.env().set('WEBGL_EXP_CONV', true)
    tf.env().set('WEBGL_PACK', false)
    tf.env().set('ENGINE_COMPILE_ONLY', true)

    const dummyInput = tf.zeros([1, MODEL_HEIGHT, MODEL_WIDTH, 3])

    const pieces = await loadGraphModel(PIECES_MODEL_URL)
    const piecesOut = pieces.execute(dummyInput)

    const xcorners = await loadGraphModel(XCORNERS_MODEL_URL)
    const xcornersOut = xcorners.execute(dummyInput)

    // Finish shader compilation if we're on WebGL.
    const backend = tf.backend() as unknown as {
      checkCompileCompletion?: () => void
      getUniformLocations?: () => void
    }
    backend.checkCompileCompletion?.()
    backend.getUniformLocations?.()
    tf.env().set('ENGINE_COMPILE_ONLY', false)

    tf.dispose([dummyInput, piecesOut, xcornersOut])

    return { pieces, xcorners }
  })()

  return modelsPromise
}
