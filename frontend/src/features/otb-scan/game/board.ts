// A small chessops wrapper that keeps SAN/Move history so we can emit a clean
// PGN. Adapted from CameraChessWeb's makeBoard helper (gameSlice.tsx).
import { Chess } from 'chessops/chess'
import { parseFen, makeFen } from 'chessops/fen'
import { parseSan, makeSan } from 'chessops/san'
import { makeUci, parseUci } from 'chessops/util'
import type { Move } from 'chessops/types'
import { START_FEN } from '../cv/constants'

interface HistoryEntry {
  move: Move
  san: string
}

export class TrackedBoard {
  pos: Chess
  readonly startFen: string
  history: HistoryEntry[] = []

  constructor(startFen: string = START_FEN) {
    this.startFen = startFen
    this.pos = Chess.fromSetup(parseFen(startFen).unwrap()).unwrap()
  }

  private rebuild(): void {
    this.pos = Chess.fromSetup(parseFen(this.startFen).unwrap()).unwrap()
    this.history.forEach((entry) => this.pos.play(entry.move))
  }

  playSan(san: string): Move | null {
    const move = parseSan(this.pos, san)
    if (!move) return null
    this.history.push({ move, san })
    this.pos.play(move)
    return move
  }

  playUci(uci: string): Move | null {
    const move = parseUci(uci)
    if (!move) return null
    const san = makeSan(this.pos, move)
    this.history.push({ move, san })
    this.pos.play(move)
    return move
  }

  undo(): void {
    if (this.history.length > 0) {
      this.history.pop()
      this.rebuild()
    }
  }

  fen(): string {
    return makeFen(this.pos.toSetup())
  }

  lastMoveUci(): string | null {
    if (this.history.length === 0) return null
    return makeUci(this.history[this.history.length - 1].move)
  }

  /** SAN move list, e.g. ["e4", "e5", "Nf3"]. */
  sanMoves(): string[] {
    return this.history.map((h) => h.san)
  }

  /** Movetext body, e.g. "1. e4 e5 2. Nf3 ...". */
  moveText(): string {
    const tmp = Chess.fromSetup(parseFen(this.startFen).unwrap()).unwrap()
    let pgn = ''
    this.history.forEach((entry) => {
      if (tmp.turn === 'white') pgn += `${tmp.fullmoves}. `
      pgn += `${entry.san} `
      tmp.play(entry.move)
    })
    return pgn.trim()
  }

  /** Full PGN with a FEN/SetUp header when the game didn't start from the
   *  standard position. */
  pgn(): string {
    const headers: string[] = []
    if (this.startFen !== START_FEN) {
      headers.push('[SetUp "1"]')
      headers.push(`[FEN "${this.startFen}"]`)
    }
    const header = headers.length ? headers.join('\n') + '\n\n' : ''
    return header + this.moveText()
  }
}
