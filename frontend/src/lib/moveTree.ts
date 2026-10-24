/**
 * A chess move tree: the main line plus any number of nested variations.
 * Immutable updates (every operation returns a new tree) so React state stays
 * simple. Used by the Analysis Board.
 *
 * Node ids are stable paths ("e2e4/e7e5/g1f3"), so playing a move that already
 * exists from a position just selects it instead of duplicating the branch.
 */
import { Chess, type Move } from 'chess.js'

export const ROOT = 'root'

export interface TreeNode {
  id: string
  parent: string | null
  san: string
  uci: string
  fen: string
  children: string[]
  ply: number
  /** part of the loaded game (vs an explored variation) */
  game?: boolean
}

export interface MoveTree {
  nodes: Record<string, TreeNode>
  rootFen: string
}

export function newTree(rootFen: string): MoveTree {
  return { rootFen, nodes: { [ROOT]: { id: ROOT, parent: null, san: '', uci: '', fen: rootFen, children: [], ply: 0 } } }
}

const childId = (parent: string, uci: string) => (parent === ROOT ? uci : `${parent}/${uci}`)

/** Play a move from `parentId`. Returns the new tree and the id of the resulting node (or null if illegal). */
export function addMove(tree: MoveTree, parentId: string, move: { from: string; to: string; promotion?: string } | string,
                        opts: { game?: boolean } = {}): { tree: MoveTree; id: string } | null {
  const parent = tree.nodes[parentId]
  if (!parent) return null
  const chess = new Chess(parent.fen)
  let m: Move
  try { m = chess.move(move as never) } catch { return null }
  if (!m) return null
  const uci = m.from + m.to + (m.promotion ?? '')
  const id = childId(parentId, uci)
  if (tree.nodes[id]) return { tree, id }
  const node: TreeNode = { id, parent: parentId, san: m.san, uci, fen: chess.fen(), children: [], ply: parent.ply + 1, game: opts.game }
  return {
    id,
    tree: { ...tree, nodes: { ...tree.nodes, [id]: node, [parentId]: { ...parent, children: [...parent.children, id] } } },
  }
}

/** Ids from the root's first move to `id` (root excluded). */
export function pathTo(tree: MoveTree, id: string): string[] {
  const out: string[] = []
  let cur: TreeNode | undefined = tree.nodes[id]
  while (cur && cur.id !== ROOT) { out.unshift(cur.id); cur = cur.parent ? tree.nodes[cur.parent] : undefined }
  return out
}

/** The main continuation from `fromId` (first child each time), excluding `fromId`. */
export function mainlineFrom(tree: MoveTree, fromId = ROOT): string[] {
  const out: string[] = []
  let cur = tree.nodes[fromId]
  while (cur && cur.children.length) { const next = tree.nodes[cur.children[0]]; out.push(next.id); cur = next }
  return out
}

export function isMainline(tree: MoveTree, id: string): boolean {
  let cur = tree.nodes[id]
  while (cur && cur.parent) {
    const p = tree.nodes[cur.parent]
    if (p.children[0] !== cur.id) return false
    cur = p
  }
  return true
}

/** Remove a node and everything after it. */
export function deleteFrom(tree: MoveTree, id: string): MoveTree {
  const node = tree.nodes[id]
  if (!node || !node.parent) return tree
  const nodes = { ...tree.nodes }
  const drop = (n: string) => { for (const c of nodes[n]?.children ?? []) drop(c); delete nodes[n] }
  drop(id)
  const p = nodes[node.parent]
  nodes[node.parent] = { ...p, children: p.children.filter(c => c !== id) }
  return { ...tree, nodes }
}

/** Move a variation one step towards the main line (to the front when it reaches it). */
export function promote(tree: MoveTree, id: string): MoveTree {
  // promote the first ancestor that isn't already the first child
  let cur = tree.nodes[id]
  while (cur && cur.parent) {
    const p = tree.nodes[cur.parent]
    const idx = p.children.indexOf(cur.id)
    if (idx > 0) {
      const children = [...p.children]
      children.splice(idx, 1)
      children.splice(idx - 1, 0, cur.id)
      return { ...tree, nodes: { ...tree.nodes, [p.id]: { ...p, children } } }
    }
    cur = p
  }
  return tree
}

/** Build a tree from a list of SAN or UCI moves (all marked as game moves). */
export function fromMoves(rootFen: string, moves: string[]): { tree: MoveTree; last: string } {
  let tree = newTree(rootFen)
  let at = ROOT
  for (const mv of moves) {
    const isUci = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(mv)
    const res = addMove(tree, at, isUci ? { from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] } : mv, { game: true })
    if (!res) break
    tree = res.tree; at = res.id
  }
  return { tree, last: at }
}

/** Strip comments, NAGs and variations (chess.js reads the main line only). */
export function cleanPgn(text: string): string {
  let s = text.replace(/\r/g, '').replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ').replace(/\$\d+/g, ' ')
  let prev = ''
  while (prev !== s) { prev = s; s = s.replace(/\([^()]*\)/g, ' ') }
  return s
}

export interface ParsedGame { tree: MoveTree; last: string; headers: Record<string, string>; pgn: string; moveCount: number }

export function parsePgn(text: string): ParsedGame {
  const chess = new Chess()
  const cleaned = cleanPgn(text.trim())
  try { chess.loadPgn(cleaned) } catch (e) {
    throw new Error(e instanceof Error ? `That PGN couldn't be read: ${e.message}` : "That PGN couldn't be read.")
  }
  const headers = chess.getHeaders() as Record<string, string>
  const history = chess.history({ verbose: true })
  const rootFen = headers.FEN && (headers.SetUp === '1' || headers.FEN) ? headers.FEN : new Chess().fen()
  const { tree, last } = fromMoves(rootFen, history.map(m => m.from + m.to + (m.promotion ?? '')))
  return { tree, last, headers, pgn: text.trim(), moveCount: history.length }
}

export type LoadKind = 'pgn' | 'fen' | 'empty' | 'invalid'

/** Guess what a pasted text is. */
export function detectInput(text: string): LoadKind {
  const t = text.trim()
  if (!t) return 'empty'
  const fenLike = /^[pnbrqkPNBRQK1-8]+(\/[pnbrqkPNBRQK1-8]+){7}(\s+[wb](\s+(-|[KQkq]{1,4})(\s+(-|[a-h][36])(\s+\d+\s+\d+)?)?)?)?$/
  if (fenLike.test(t)) return 'fen'
  if (/\d+\.\s*[a-hKQRBNO]/.test(t) || /^\[\w+\s+"/m.test(t) || /^[a-hKQRBNO][\w+#=-]*(\s+[a-hKQRBNO][\w+#=-]*)+/.test(t)) return 'pgn'
  return 'invalid'
}

/** Complete a FEN that only has the placement (and maybe side to move). */
export function completeFen(text: string): string {
  const parts = text.trim().split(/\s+/)
  const [placement, turn = 'w', castling = '-', ep = '-', half = '0', full = '1'] = parts
  return [placement, turn, castling, ep, half, full].join(' ')
}

function moveNumberPrefix(fen: string, force: boolean): string {
  const [, turn, , , , full] = fen.split(' ')
  if (turn === 'w') return `${full}. `
  return force ? `${full}... ` : ''
}

/** PGN text including variations. */
export function toPgn(tree: MoveTree, headers: Record<string, string> = {}): string {
  const h: Record<string, string> = { Event: '?', Site: 'Forked analysis', Result: '*', ...headers }
  const start = new Chess().fen()
  if (tree.rootFen !== start) { h.SetUp = '1'; h.FEN = tree.rootFen }
  const head = Object.entries(h).map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`).join('\n')
  const parts: string[] = []
  const walk = (fromId: string, force: boolean) => {
    let cur = tree.nodes[fromId]
    let forceNum = force
    while (cur && cur.children.length) {
      const [main, ...alts] = cur.children.map(c => tree.nodes[c])
      parts.push(moveNumberPrefix(cur.fen, forceNum) + main.san)
      forceNum = false
      for (const alt of alts) {
        parts.push('(' + moveNumberPrefix(cur.fen, true) + alt.san)
        walk(alt.id, false)
        parts.push(')')
        forceNum = true
      }
      cur = main
    }
  }
  walk(ROOT, true)
  const body = parts.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')')
  return `${head}\n\n${body} ${h.Result}`.trim()
}

/** PGN of the main line only (what gets sent to Game Review). */
export function mainlinePgn(tree: MoveTree, headers: Record<string, string> = {}): string {
  const ids = mainlineFrom(tree)
  const t = fromMoves(tree.rootFen, ids.map(i => tree.nodes[i].uci)).tree
  return toPgn(t, headers)
}
