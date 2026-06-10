// Ported from CameraChessWeb (src/utils/constants.tsx).
// The LeYOLO models were trained at 480x288 (W x H), letterboxed.

import type { Role } from 'chessops/types'

export const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export const MODEL_WIDTH = 480
export const MODEL_HEIGHT = 288

// Class labels output by the pieces model, in index order.
// Lowercase = black, uppercase = white. Index <= 5 is black, > 5 is white.
export const LABELS = ['b', 'k', 'n', 'p', 'q', 'r', 'B', 'K', 'N', 'P', 'Q', 'R']

// chessops roles, indexed by (labelIndex % 6).
export const PIECE_SYMBOLS: Role[] = [
  'bishop',
  'king',
  'knight',
  'pawn',
  'queen',
  'rook',
]

export const SQUARE_NAMES = [
  'a1', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1',
  'a2', 'b2', 'c2', 'd2', 'e2', 'f2', 'g2', 'h2',
  'a3', 'b3', 'c3', 'd3', 'e3', 'f3', 'g3', 'h3',
  'a4', 'b4', 'c4', 'd4', 'e4', 'f4', 'g4', 'h4',
  'a5', 'b5', 'c5', 'd5', 'e5', 'f5', 'g5', 'h5',
  'a6', 'b6', 'c6', 'd6', 'e6', 'f6', 'g6', 'h6',
  'a7', 'b7', 'c7', 'd7', 'e7', 'f7', 'g7', 'h7',
  'a8', 'b8', 'c8', 'd8', 'e8', 'f8', 'g8', 'h8',
] as const

export const SQUARE_SIZE = 128
export const BOARD_SIZE = 8 * SQUARE_SIZE

// Corner keys in the order returned by the geometric corner finder.
export const CORNER_KEYS = ['h1', 'a1', 'a8', 'h8'] as const
export type CornersKey = (typeof CORNER_KEYS)[number]
export type CornersDict = Record<CornersKey, number[]>

const makeLabelMap = (): Record<string, number> => {
  const d: Record<string, number> = {}
  LABELS.forEach((label, i) => {
    d[label] = i
  })
  return d
}
export const LABEL_MAP = makeLabelMap()

const makeSquareMap = (): Record<string, number> => {
  const d: Record<string, number> = {}
  SQUARE_NAMES.forEach((square, i) => {
    d[square] = i
  })
  return d
}
export const SQUARE_MAP = makeSquareMap()

export const PIECES_MODEL_URL = '/models/480M_pieces_float16/model.json'
export const XCORNERS_MODEL_URL = '/models/480L_xcorners_float16/model.json'
