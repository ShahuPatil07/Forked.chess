import { useMemo, useState } from 'react'
import { Chess } from 'chess.js'
import { motion } from 'framer-motion'
import { Check, X, ChevronLeft, ChevronRight, ArrowRight, AlertTriangle } from 'lucide-react'
import { BoardDisplay } from '../components/BoardDisplay'
import type { OCRResult } from '../api/ocr'

interface Props {
  result: OCRResult
  onConfirm: (pgn: string, moves: string[]) => void
  onBack: () => void
}

interface Row {
  number: number
  white: string
  black: string
}

type Color = 'w' | 'b'

interface Ply {
  rowIdx: number
  color: Color
  san: string
}

interface Validation {
  // cell key `${rowIdx}-${color}` -> valid?
  cellValid: Record<string, boolean>
  fens: string[] // fens[0] = start; fens[k] = after k applied plies
  validPlyCount: number
  allValid: boolean
  invalidCount: number
  detectedCount: number
  pgn: string
  sanMoves: string[]
}

const cellKey = (rowIdx: number, color: Color) => `${rowIdx}-${color}`

// Repair common OCR/typing formatting so a valid move isn't flagged for manual
// fixing: strip internal spaces ("Qx c7"), lowercase destination files
// ("QxC7" -> "Qxc7"), uppercase a mis-cased leading piece (q/r/n/k, not b),
// normalise castling and promotion. Mirrors the backend's clean_move().
function normalizeSan(raw: string): string {
  let s = raw.trim().replace(/\s+/g, '')
  if (!s) return ''
  if (/^[0o]-[0o]-[0o]$/i.test(s)) return 'O-O-O'
  if (/^[0o]-[0o]$/i.test(s)) return 'O-O'
  s = s.replace(/[!?]+/g, '').replace(/[+#]+$/, '')          // annotations / check-mate marks
  s = s.replace(/X/g, 'x')                                    // capture X -> x
  s = s.replace(/([A-H])(?=[1-8])/g, (c) => c.toLowerCase())  // file letters lowercase
  if (/^[qrnk]/.test(s)) s = s[0].toUpperCase() + s.slice(1)  // mis-cased leading piece
  s = s.replace(/=([qrbn])$/, (_m, p: string) => '=' + p.toUpperCase())
  return s
}

const buildPlies = (rows: Row[]): Ply[] => {
  const plies: Ply[] = []
  rows.forEach((r, rowIdx) => {
    plies.push({ rowIdx, color: 'w', san: r.white.trim() })
    plies.push({ rowIdx, color: 'b', san: r.black.trim() })
  })
  // Drop trailing empty plies (e.g. game ended on white's move).
  while (plies.length && plies[plies.length - 1].san === '') plies.pop()
  return plies
}

const validate = (rows: Row[]): Validation => {
  const plies = buildPlies(rows)
  const chess = new Chess()
  const fens = [chess.fen()]
  const cellValid: Record<string, boolean> = {}
  let firstBad = -1

  plies.forEach((ply, k) => {
    const key = cellKey(ply.rowIdx, ply.color)
    if (firstBad >= 0) {
      cellValid[key] = false
      return
    }
    const san = normalizeSan(ply.san)
    if (san === '') {
      cellValid[key] = false
      firstBad = k
      return
    }
    try {
      chess.move(san)
      cellValid[key] = true
      fens.push(chess.fen())
    } catch {
      cellValid[key] = false
      firstBad = k
    }
  })

  const validPlyCount = firstBad === -1 ? plies.length : firstBad
  const allValid = firstBad === -1 && plies.length > 0
  const invalidCount = plies.filter((p) => !cellValid[cellKey(p.rowIdx, p.color)]).length

  return {
    cellValid,
    fens,
    validPlyCount,
    allValid,
    invalidCount,
    detectedCount: plies.length,
    pgn: allValid ? chess.pgn() : '',
    sanMoves: allValid ? chess.history() : [],
  }
}

export function MoveReview({ result, onConfirm, onBack }: Props) {
  const [rows, setRows] = useState<Row[]>(() =>
    result.moves.map((m) => ({
      number: m.number,
      // Prefer the corrected SAN; fall back to the raw OCR token so the user
      // edits the engine's best guess rather than a blank "unclear".
      white: m.white ?? m.white_raw ?? '',
      black: m.black ?? m.black_raw ?? '',
    })),
  )
  const [editing, setEditing] = useState<string | null>(null)
  const [viewIdx, setViewIdx] = useState<number | null>(null) // null = follow valid count

  const v = useMemo(() => validate(rows), [rows])

  const boardPly = viewIdx ?? v.validPlyCount
  const clampedPly = Math.max(0, Math.min(boardPly, v.fens.length - 1))
  const fen = v.fens[clampedPly]

  const setCell = (rowIdx: number, color: Color, value: string) => {
    setRows((prev) =>
      prev.map((r, i) =>
        i === rowIdx ? { ...r, [color === 'w' ? 'white' : 'black']: value } : r,
      ),
    )
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-6">
      <button onClick={onBack} className="btn-ghost flex items-center gap-1 mb-3">
        <ChevronLeft size={15} /> Back
      </button>

      <h1 className="text-lg font-bold text-text-0 mb-1">Review moves</h1>
      <p className="text-xs text-text-2 mb-1">
        {v.detectedCount} {v.detectedCount === 1 ? 'move' : 'moves'} detected
        {v.invalidCount > 0 ? (
          <span className="text-danger"> · {v.invalidCount} need correction</span>
        ) : (
          <span className="text-success"> · all valid</span>
        )}
      </p>

      {result.warning === 'few_moves' && (
        <div className="card p-3 my-3 flex items-start gap-2 border-warn/30">
          <AlertTriangle size={15} className="text-warn flex-shrink-0 mt-0.5" />
          <p className="text-xs text-text-1">
            We could only read a few moves from this image. Check them carefully, or try the live
            recorder instead.
          </p>
        </div>
      )}

      {/* Live board */}
      <div className="flex justify-center my-4">
        <div className="w-full max-w-[300px]">
          <BoardDisplay fen={fen} />
          <div className="flex items-center justify-between mt-2">
            <button
              onClick={() => setViewIdx(Math.max(0, clampedPly - 1))}
              disabled={clampedPly <= 0}
              className="btn-ghost border border-border px-2"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="text-xs text-text-2 tabular-nums">
              ply {clampedPly} / {v.validPlyCount}
            </span>
            <button
              onClick={() => setViewIdx(Math.min(v.validPlyCount, clampedPly + 1))}
              disabled={clampedPly >= v.validPlyCount}
              className="btn-ghost border border-border px-2"
            >
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* Two-column scoresheet */}
      <div className="card p-2 mb-4">
        <div className="grid grid-cols-[2rem_1fr_1fr] gap-1 px-1 pb-1 text-[10px] text-text-2 uppercase tracking-wider">
          <span>#</span>
          <span>White</span>
          <span>Black</span>
        </div>
        <div className="max-h-64 overflow-y-auto space-y-0.5">
          {rows.map((row, rowIdx) => (
            <div key={rowIdx} className="grid grid-cols-[2rem_1fr_1fr] gap-1 items-center">
              <span className="text-xs text-text-2 tabular-nums pl-1">{row.number}.</span>
              <MoveCell
                value={row.white}
                valid={v.cellValid[cellKey(rowIdx, 'w')]}
                editing={editing === cellKey(rowIdx, 'w')}
                onEdit={() => setEditing(cellKey(rowIdx, 'w'))}
                onChange={(val) => setCell(rowIdx, 'w', val)}
                onBlur={() => setEditing(null)}
                onFocusBoard={() => setViewIdx(rowIdx * 2 + 1)}
              />
              <MoveCell
                value={row.black}
                valid={v.cellValid[cellKey(rowIdx, 'b')]}
                editing={editing === cellKey(rowIdx, 'b')}
                onEdit={() => setEditing(cellKey(rowIdx, 'b'))}
                onChange={(val) => setCell(rowIdx, 'b', val)}
                onBlur={() => setEditing(null)}
                onFocusBoard={() => setViewIdx(rowIdx * 2 + 2)}
                optional={rowIdx === rows.length - 1}
              />
            </div>
          ))}
        </div>
      </div>

      <motion.button
        whileTap={{ scale: 0.98 }}
        onClick={() => onConfirm(v.pgn, v.sanMoves)}
        disabled={!v.allValid}
        className="btn-primary w-full flex items-center justify-center gap-2 py-3 text-base"
      >
        Confirm and analyse <ArrowRight size={18} />
      </motion.button>
      {!v.allValid && (
        <p className="text-center text-[11px] text-danger mt-2">
          Fix the moves highlighted in red to continue.
        </p>
      )}
    </div>
  )
}

function MoveCell({
  value,
  valid,
  editing,
  onEdit,
  onChange,
  onBlur,
  onFocusBoard,
  optional = false,
}: {
  value: string
  valid: boolean | undefined
  editing: boolean
  onEdit: () => void
  onChange: (val: string) => void
  onBlur: () => void
  onFocusBoard: () => void
  optional?: boolean
}) {
  // An empty optional last cell (game ended) isn't an error.
  const isEmptyOptional = optional && value.trim() === ''
  const ok = valid || isEmptyOptional

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => e.key === 'Enter' && onBlur()}
        placeholder="SAN e.g. Nf3"
        className={`input py-1 text-sm font-mono ${ok ? 'border-success' : 'border-danger'}`}
      />
    )
  }

  return (
    <button
      onClick={() => {
        onEdit()
        onFocusBoard()
      }}
      className={`flex items-center justify-between gap-1 px-2 py-1 rounded text-sm font-mono text-left transition-colors ${
        isEmptyOptional
          ? 'text-text-2'
          : ok
            ? 'text-text-0 hover:bg-bg-2'
            : 'bg-danger/10 text-danger border border-danger/30'
      }`}
    >
      <span className="truncate">{value.trim() || (isEmptyOptional ? '—' : '✗ unclear')}</span>
      {!isEmptyOptional &&
        (ok ? (
          <Check size={12} className="text-success flex-shrink-0" />
        ) : (
          <X size={12} className="text-danger flex-shrink-0" />
        ))}
    </button>
  )
}
