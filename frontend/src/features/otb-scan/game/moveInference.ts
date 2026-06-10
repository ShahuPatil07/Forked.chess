// Ported from CameraChessWeb (findPieces.tsx scoring + findFen.tsx reader).
// Scores candidate moves against the live probabilistic board state, and
// reconstructs a FEN from a single state snapshot (used for resync / start).
import { Chess } from 'chessops/chess'
import { parseFen, makeFen } from 'chessops/fen'
import { opposite } from 'chessops/util'
import type { Color, Role } from 'chessops/types'
import { PIECE_SYMBOLS, SQUARE_NAMES } from '../cv/constants'
import type { MovesData, MovesPair } from './types'

export const calculateScore = (
  state: number[][],
  move: MovesData,
  fromThr = 0.6,
  toThr = 0.6,
): number => {
  let score = 0
  move.from.forEach((square) => {
    score += 1 - Math.max(...state[square]) - fromThr
  })
  for (let i = 0; i < move.to.length; i++) {
    score += state[move.to[i]][move.targets[i]] - toThr
  }
  return score
}

export interface ProcessStateResult {
  bestScore1: number
  bestScore2: number
  bestJointScore: number
  bestMove: MovesData | null
  bestMoves: MovesData | null
}

// `possibleMoves` accumulates first-ply SANs that have ever scored positive;
// it is mutated across frames (matching CameraChessWeb's behaviour).
export const processState = (
  state: number[][],
  movesPairs: MovesPair[],
  possibleMoves: Set<string>,
): ProcessStateResult => {
  let bestScore1 = Number.NEGATIVE_INFINITY
  let bestScore2 = Number.NEGATIVE_INFINITY
  let bestJointScore = Number.NEGATIVE_INFINITY
  let bestMove: MovesData | null = null
  let bestMoves: MovesData | null = null
  const seen = new Set<string>()

  movesPairs.forEach((movePair) => {
    if (!seen.has(movePair.move1.sans[0])) {
      seen.add(movePair.move1.sans[0])
      const score = calculateScore(state, movePair.move1)
      if (score > 0) possibleMoves.add(movePair.move1.sans[0])
      if (score > bestScore1) {
        bestMove = movePair.move1
        bestScore1 = score
      }
    }

    if (
      movePair.move2 === null ||
      movePair.moves === null ||
      !possibleMoves.has(movePair.move1.sans[0])
    ) {
      return
    }

    const score2 = calculateScore(state, movePair.move2)
    if (score2 < 0) return
    if (score2 > bestScore2) bestScore2 = score2

    const jointScore = calculateScore(state, movePair.moves)
    if (jointScore > bestJointScore) {
      bestJointScore = jointScore
      bestMoves = movePair.moves
    }
  })

  return { bestScore1, bestScore2, bestJointScore, bestMove, bestMoves }
}

export interface FenRead {
  fen: string | null
  error: string | null
}

// Reconstruct a board from a single 64x12 state snapshot. Greedily assigns the
// two kings first, then the remaining pieces above a confidence floor, and
// validates the resulting position.
export const readBoardFen = (state: number[][], color: Color): FenRead => {
  const assignment: number[] = Array(64).fill(-1)

  // Black king (label index 1)
  let bestBlackKingScore = -1
  let bestBlackKingIdx = -1
  for (let i = 0; i < 64; i++) {
    if (state[i][1] > bestBlackKingScore) {
      bestBlackKingScore = state[i][1]
      bestBlackKingIdx = i
    }
  }
  assignment[bestBlackKingIdx] = 1

  // White king (label index 7)
  let bestWhiteKingScore = -1
  let bestWhiteKingIdx = -1
  for (let i = 0; i < 64; i++) {
    if (i === bestBlackKingIdx) continue
    if (state[i][7] > bestWhiteKingScore) {
      bestWhiteKingScore = state[i][7]
      bestWhiteKingIdx = i
    }
  }
  assignment[bestWhiteKingIdx] = 7

  // Remaining pieces
  const remainingPieceIdxs = [0, 2, 3, 4, 5, 6, 8, 9, 10, 11]
  for (let i = 0; i < 64; i++) {
    if (assignment[i] !== -1) continue
    let bestIdx: number | null = null
    let bestScore = 0.3
    remainingPieceIdxs.forEach((j) => {
      const squareName = SQUARE_NAMES[i]
      const badRank = squareName[1] === '1' || squareName[1] === '8'
      const isPawn = PIECE_SYMBOLS[j % 6] === 'pawn'
      if (isPawn && badRank) return
      if (state[i][j] > bestScore) {
        bestIdx = j
        bestScore = state[i][j]
      }
    })
    if (bestIdx !== null) assignment[i] = bestIdx
  }

  const board = Chess.fromSetup(parseFen('8/8/8/8/8/8/8/8 w - - 0 1').unwrap()).unwrap()
  for (let i = 0; i < 64; i++) {
    if (assignment[i] === -1) continue
    const role: Role = PIECE_SYMBOLS[assignment[i] % 6]
    const pieceColor: Color = assignment[i] > 5 ? 'white' : 'black'
    board.board.set(i, { role, color: pieceColor })
  }

  const fen = makeFen(board.toSetup())

  // Reject positions where the side to move already has the opponent in check.
  const otherColor = opposite(color)
  const otherKing = board.board.kingOf(otherColor)
  if (otherKing !== undefined) {
    if (board.kingAttackers(otherKing, color, board.board.occupied).nonEmpty()) {
      return { fen, error: 'Side to move has opponent in check' }
    }
  }

  return { fen, error: null }
}
