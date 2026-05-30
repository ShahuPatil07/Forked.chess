/**
 * Static endgame theory tree.
 *
 * The tree is curriculum content — it doesn't come from an API.
 * Every leaf node carries:
 *   - id          : stable slug used for routing / state
 *   - title       : human display name
 *   - fen         : canonical FEN illustrating the concept
 *   - result      : "white_wins" | "black_wins" | "draw" | "depends"
 *   - difficulty  : "beginner" | "intermediate" | "advanced"
 *   - category    : one of the 7 top-level material categories (slugged)
 *
 * The same `category` value is what the Practice tab uses when asking
 * the backend for a random position from that bucket.
 */

export type EndgameResult     = 'white_wins' | 'black_wins' | 'draw' | 'depends'
export type EndgameDifficulty = 'beginner'   | 'intermediate' | 'advanced'

export type EndgameCategory =
  | 'kp'                // King + Pawn endings
  | 'kr'                // King + Rook endings
  | 'kq'                // King + Queen endings
  | 'kminor'            // King + Minor Piece endings
  | 'rook'              // Rook endings (multi-pawn)
  | 'minor'             // Minor piece endings (multi-pawn)
  | 'pawn'              // Pawn endings (multi-pawn)

export interface EndgameLeaf {
  id:          string
  title:       string
  fen:         string
  result:      EndgameResult
  difficulty:  EndgameDifficulty
  category:    EndgameCategory
  /** Short one-line summary shown under the title in the tree. */
  summary?:    string
}

export interface EndgameGroup {
  id:       string
  title:    string
  leaves:   EndgameLeaf[]
}

export interface EndgameSection {
  id:         EndgameCategory
  title:      string
  /** Short description shown next to the category in the tree. */
  blurb:      string
  groups:     EndgameGroup[]
}

// ── Category 1 — King + Pawn endings ─────────────────────────────────────────

const KP: EndgameSection = {
  id:    'kp',
  title: 'King + Pawn endings',
  blurb: 'The foundation: opposition, key squares, the rule of the square.',
  groups: [
    {
      id: 'kp-vs-k',
      title: 'King + Pawn vs King',
      leaves: [
        {
          id: 'rule-of-the-square',
          title: 'Rule of the Square',
          summary: 'Can the lone king catch the passed pawn?',
          fen: '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1',
          result: 'white_wins', difficulty: 'beginner', category: 'kp',
        },
        {
          id: 'kp-opposition',
          title: 'Opposition (basic)',
          summary: 'Direct opposition wins or holds key squares.',
          fen: '8/8/4k3/8/4K3/4P3/8/8 w - - 0 1',
          result: 'white_wins', difficulty: 'beginner', category: 'kp',
        },
        {
          id: 'kp-key-squares',
          title: 'Key Squares',
          summary: 'When the attacker can reach a key square in front of the pawn, it wins.',
          fen: '8/8/3k4/8/3P4/3K4/8/8 w - - 0 1',
          result: 'white_wins', difficulty: 'intermediate', category: 'kp',
        },
        {
          id: 'rook-pawn-exception',
          title: 'Rook Pawn exception',
          summary: 'King + a/h pawn vs lone king is drawn if the defender reaches the corner.',
          fen: '8/8/8/8/k7/8/P7/K7 w - - 0 1',
          result: 'draw', difficulty: 'intermediate', category: 'kp',
        },
      ],
    },
    {
      id: 'kpp-vs-k',
      title: 'King + 2 Pawns vs King',
      leaves: [
        {
          id: 'connected-pawns',
          title: 'Connected passed pawns',
          summary: 'Two connected pawns on the 6th defend each other and win.',
          fen: '4k3/8/3PP3/8/8/8/8/4K3 w - - 0 1',
          result: 'white_wins', difficulty: 'beginner', category: 'kp',
        },
        {
          id: 'doubled-pawns',
          title: 'Doubled pawns',
          summary: 'Doubled pawns often don\'t win — the front pawn must clear before the back can promote.',
          fen: '8/8/4k3/8/8/3P4/3P4/4K3 w - - 0 1',
          result: 'depends', difficulty: 'intermediate', category: 'kp',
        },
        {
          id: 'separated-passed-pawns',
          title: 'Separated passed pawns',
          summary: 'Two pawns two files apart usually win — the king cannot stop both.',
          fen: '4k3/8/8/8/8/8/P3P3/4K3 w - - 0 1',
          result: 'white_wins', difficulty: 'intermediate', category: 'kp',
        },
      ],
    },
    {
      id: 'opposition',
      title: 'Opposition and triangulation',
      leaves: [
        {
          id: 'direct-opposition',
          title: 'Direct opposition',
          summary: 'Kings one square apart — whoever doesn\'t have to move "has the opposition".',
          fen: '8/8/8/3k4/8/3K4/8/8 w - - 0 1',
          result: 'draw', difficulty: 'beginner', category: 'kp',
        },
        {
          id: 'distant-opposition',
          title: 'Distant opposition',
          summary: 'Kings 3 or 5 squares apart on the same line — same colour squares wins for the side to move.',
          fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
          result: 'draw', difficulty: 'intermediate', category: 'kp',
        },
        {
          id: 'diagonal-opposition',
          title: 'Diagonal opposition',
          summary: 'Same as direct opposition but on a diagonal.',
          fen: '8/8/5k2/8/8/3K4/8/8 w - - 0 1',
          result: 'draw', difficulty: 'advanced', category: 'kp',
        },
      ],
    },
  ],
}

// ── Category 2 — King + Rook endings ─────────────────────────────────────────

const KR: EndgameSection = {
  id:    'kr',
  title: 'King + Rook endings',
  blurb: 'The most common endgame — Lucena, Philidor, building the bridge.',
  groups: [
    {
      id: 'lucena',
      title: 'Lucena Position',
      leaves: [
        {
          id: 'lucena-building-bridge',
          title: 'Building the bridge',
          summary: 'White wins by building a "bridge" with the rook on the 4th rank.',
          fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1',
          result: 'white_wins', difficulty: 'intermediate', category: 'kr',
        },
        {
          id: 'lucena-variations',
          title: 'Lucena — defender variations',
          summary: 'Common defensive tries and how to refute them.',
          fen: '1K1k4/1P6/8/8/r7/8/8/2R5 w - - 0 1',
          result: 'white_wins', difficulty: 'advanced', category: 'kr',
        },
      ],
    },
    {
      id: 'philidor',
      title: 'Philidor Position',
      leaves: [
        {
          id: 'philidor-passive',
          title: 'Philidor — passive defence',
          summary: 'Defender holds the third rank until the pawn is pushed, then drops behind.',
          fen: '3k4/8/3K4/3P4/8/r7/8/3R4 b - - 0 1',
          result: 'draw', difficulty: 'intermediate', category: 'kr',
        },
        {
          id: 'philidor-active',
          title: 'Active rook (behind the pawn)',
          summary: 'A rook behind a passed pawn — Tarrasch\'s rule for the defender.',
          fen: '3k4/8/8/8/8/3P4/3K4/r7 b - - 0 1',
          result: 'draw', difficulty: 'advanced', category: 'kr',
        },
      ],
    },
    {
      id: 'kr-vs-k',
      title: 'King + Rook vs King (mate)',
      leaves: [
        {
          id: 'kr-box-method',
          title: 'Box method',
          summary: 'Shrink the defender\'s "box" with the rook one rank/file at a time.',
          fen: '4k3/8/8/8/8/8/8/R3K3 w Q - 0 1',
          result: 'white_wins', difficulty: 'beginner', category: 'kr',
        },
        {
          id: 'kr-ladder-mate',
          title: 'Ladder / staircase mate',
          summary: 'Cooperate king + rook to drive the lone king to the edge.',
          fen: '8/8/4k3/8/8/4K3/8/4R3 w - - 0 1',
          result: 'white_wins', difficulty: 'beginner', category: 'kr',
        },
      ],
    },
    {
      id: 'rp-vs-r',
      title: 'Rook + Pawn vs Rook',
      leaves: [
        {
          id: 'rp-7th-rank',
          title: 'Pawn on 7th rank',
          summary: 'Generally winning if the king is also far advanced — see Lucena.',
          fen: 'K7/P7/8/4k3/8/8/7r/1R6 w - - 0 1',
          result: 'white_wins', difficulty: 'intermediate', category: 'kr',
        },
        {
          id: 'rp-6th-rank',
          title: 'Pawn on 6th rank',
          summary: 'Often drawn with active defence (Philidor) but pivots on king position.',
          fen: '4k3/8/3P4/3K4/8/r7/8/3R4 w - - 0 1',
          result: 'draw', difficulty: 'advanced', category: 'kr',
        },
        {
          id: 'rp-lower-rank',
          title: 'Pawn on 5th rank or lower',
          summary: 'Usually drawn against accurate defence.',
          fen: '4k3/8/8/3P4/8/r7/8/3K1R2 w - - 0 1',
          result: 'draw', difficulty: 'intermediate', category: 'kr',
        },
      ],
    },
  ],
}

// ── Category 3 — King + Queen endings ────────────────────────────────────────

const KQ: EndgameSection = {
  id:    'kq',
  title: 'King + Queen endings',
  blurb: 'Queen mates and the surprisingly tricky Q vs pawn-on-7th positions.',
  groups: [
    {
      id: 'kq-vs-k',
      title: 'King + Queen vs King (basic mate)',
      leaves: [
        {
          id: 'kqk-mate',
          title: 'Walking the king to the edge',
          summary: 'Use the queen a knight-move away to shrink the box; bring your king for the mate.',
          fen: '4k3/8/8/8/8/8/8/3QK3 w - - 0 1',
          result: 'white_wins', difficulty: 'beginner', category: 'kq',
        },
      ],
    },
    {
      id: 'kq-vs-kp',
      title: 'King + Queen vs King + Pawn',
      leaves: [
        {
          id: 'kqp-7th-rank',
          title: 'Pawn on 7th rank',
          summary: 'Often drawn — defender uses stalemate tricks with the king in front of pawn.',
          fen: '8/8/8/3K4/8/1k6/1p6/Q7 w - - 0 1',
          result: 'depends', difficulty: 'advanced', category: 'kq',
        },
        {
          id: 'kqp-rook-bishop-pawn-draw',
          title: 'Rook & Bishop pawn stalemate',
          summary: 'a- and c-pawns (and h-/f-) on 7th with king in front are famous draws.',
          fen: '8/8/8/8/8/k7/p7/K6Q w - - 0 1',
          result: 'draw', difficulty: 'advanced', category: 'kq',
        },
      ],
    },
    {
      id: 'qp-vs-q',
      title: 'Queen + Pawn vs Queen',
      leaves: [
        {
          id: 'qp-vs-q-general',
          title: 'Queen + Pawn vs Queen',
          summary: 'Usually winning if the king is well placed; pure technique problem otherwise.',
          fen: '8/3k4/8/8/8/3K4/3P4/3Q3q w - - 0 1',
          result: 'depends', difficulty: 'advanced', category: 'kq',
        },
      ],
    },
  ],
}

// ── Category 4 — King + Minor Piece endings ──────────────────────────────────

const KMINOR: EndgameSection = {
  id:    'kminor',
  title: 'King + Minor Piece endings',
  blurb: 'Bare-piece mates and the brutally hard B+N mate.',
  groups: [
    {
      id: 'kb-vs-k',
      title: 'King + Bishop vs King',
      leaves: [
        {
          id: 'kbk-draw',
          title: 'Insufficient material',
          summary: 'A lone bishop cannot mate — automatic draw.',
          fen: '4k3/8/8/8/8/8/8/3BK3 w - - 0 1',
          result: 'draw', difficulty: 'beginner', category: 'kminor',
        },
      ],
    },
    {
      id: 'kn-vs-k',
      title: 'King + Knight vs King',
      leaves: [
        {
          id: 'knk-draw',
          title: 'Insufficient material',
          summary: 'A lone knight cannot mate — automatic draw.',
          fen: '4k3/8/8/8/8/8/8/3NK3 w - - 0 1',
          result: 'draw', difficulty: 'beginner', category: 'kminor',
        },
      ],
    },
    {
      id: 'kbb-vs-k',
      title: 'King + 2 Bishops vs King',
      leaves: [
        {
          id: 'kbbk-mate',
          title: 'Two bishops mate',
          summary: 'Drive the lone king to a corner of any colour. ~17 moves with technique.',
          fen: '4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1',
          result: 'white_wins', difficulty: 'intermediate', category: 'kminor',
        },
      ],
    },
    {
      id: 'kbn-vs-k',
      title: 'King + Bishop + Knight vs King',
      leaves: [
        {
          id: 'kbnk-mate',
          title: 'The B+N mate',
          summary: 'Notoriously hard. Drive the king to the corner OF THE BISHOP\'S COLOUR.',
          fen: '4k3/8/8/8/8/8/8/2B1KN2 w - - 0 1',
          result: 'white_wins', difficulty: 'advanced', category: 'kminor',
        },
      ],
    },
    {
      id: 'knn-vs-k',
      title: 'King + 2 Knights vs King',
      leaves: [
        {
          id: 'knnk-draw',
          title: 'Usually drawn',
          summary: 'No forced mate against best defence — defender just keeps the king centralised.',
          fen: '4k3/8/8/8/8/8/8/2N1KN2 w - - 0 1',
          result: 'draw', difficulty: 'advanced', category: 'kminor',
        },
      ],
    },
  ],
}

// ── Category 5 — Rook endings (with extra pawns) ─────────────────────────────

const ROOK: EndgameSection = {
  id:    'rook',
  title: 'Rook endings',
  blurb: 'Tarrasch\'s rule, passive vs active rooks, the most common endgame in practice.',
  groups: [
    {
      id: 'rook-activity',
      title: 'Rook activity principles',
      leaves: [
        {
          id: 'tarrasch-rule',
          title: 'Tarrasch — rooks behind passed pawns',
          summary: 'Place the rook BEHIND your own AND your opponent\'s passed pawns.',
          fen: '8/8/8/8/3k4/8/2KP4/r6R w - - 0 1',
          result: 'depends', difficulty: 'intermediate', category: 'rook',
        },
        {
          id: 'passive-vs-active',
          title: 'Passive vs active rook',
          summary: 'An active rook is worth a pawn — never let your rook get stuck defending.',
          fen: '8/8/4k3/8/3pK3/8/3R4/3r4 w - - 0 1',
          result: 'depends', difficulty: 'intermediate', category: 'rook',
        },
        {
          id: '7th-rank-rook',
          title: 'Rook on the 7th rank',
          summary: 'A rook on the 7th attacks pawns and confines the king to the back rank.',
          fen: '4k3/R7/8/8/8/8/4K3/8 w - - 0 1',
          result: 'depends', difficulty: 'intermediate', category: 'rook',
        },
      ],
    },
  ],
}

// ── Category 6 — Minor piece endings (with extra pawns) ──────────────────────

const MINOR: EndgameSection = {
  id:    'minor',
  title: 'Minor piece endings',
  blurb: 'Bishop vs knight, good/bad bishops, opposite-colour bishop draws.',
  groups: [
    {
      id: 'bishop-vs-knight',
      title: 'Bishop vs Knight',
      leaves: [
        {
          id: 'bishop-better',
          title: 'When the bishop is better',
          summary: 'Open positions, pawns on both sides — the bishop\'s long-range power wins.',
          fen: '8/p5p1/1p1k1p2/2p5/2P5/1P1K1P2/P5P1/8 w - - 0 1',
          result: 'depends', difficulty: 'intermediate', category: 'minor',
        },
        {
          id: 'knight-better',
          title: 'When the knight is better',
          summary: 'Closed positions, pawns on one side, fixed pawns on the bishop\'s colour.',
          fen: '8/4kp2/8/8/3PP3/4K3/8/4N3 w - - 0 1',
          result: 'depends', difficulty: 'intermediate', category: 'minor',
        },
      ],
    },
    {
      id: 'good-bad-bishop',
      title: 'Good bishop vs bad bishop',
      leaves: [
        {
          id: 'bad-bishop',
          title: 'Bad bishop blocked by own pawns',
          summary: 'A bishop locked behind its own pawns can be worse than a knight.',
          fen: '8/4kpp1/4p3/4P3/4P3/8/4K1B1/8 w - - 0 1',
          result: 'depends', difficulty: 'intermediate', category: 'minor',
        },
      ],
    },
    {
      id: 'opposite-bishops',
      title: 'Opposite-colour bishops',
      leaves: [
        {
          id: 'opposite-bishop-draw',
          title: 'Opposite bishops drawing tendency',
          summary: 'Famously drawish even with a pawn or two ahead. Defender controls one colour.',
          fen: '8/5pk1/8/5P2/5K2/5B2/8/5b2 w - - 0 1',
          result: 'draw', difficulty: 'advanced', category: 'minor',
        },
      ],
    },
  ],
}

// ── Category 7 — Pawn endings (with extra pawns) ─────────────────────────────

const PAWN: EndgameSection = {
  id:    'pawn',
  title: 'Pawn endings',
  blurb: 'Triangulation, breakthroughs, outside passers — the deepest calculation.',
  groups: [
    {
      id: 'triangulation',
      title: 'Triangulation',
      leaves: [
        {
          id: 'triangulation-classic',
          title: 'Triangulation to pass the move',
          summary: 'Use the king to lose a tempo and put the opponent in zugzwang.',
          fen: '8/3k4/3p4/3P4/8/3K4/8/8 w - - 0 1',
          result: 'depends', difficulty: 'advanced', category: 'pawn',
        },
      ],
    },
    {
      id: 'breakthrough',
      title: 'Breakthrough combinations',
      leaves: [
        {
          id: 'classic-breakthrough',
          title: 'Three-pawn breakthrough',
          summary: 'Three vs three on the flank: push the middle to create a passed pawn by force.',
          fen: '8/p1p1p3/8/P1P1P3/8/8/8/4K2k w - - 0 1',
          result: 'white_wins', difficulty: 'advanced', category: 'pawn',
        },
      ],
    },
    {
      id: 'outside-passer',
      title: 'Outside passed pawn',
      leaves: [
        {
          id: 'outside-passer-classic',
          title: 'Outside passed pawn',
          summary: 'A passed pawn far from the action distracts the enemy king from the kingside.',
          fen: '8/p4k2/8/8/8/8/P4K2/8 w - - 0 1',
          result: 'depends', difficulty: 'intermediate', category: 'pawn',
        },
      ],
    },
    {
      id: 'zugzwang',
      title: 'Zugzwang positions',
      leaves: [
        {
          id: 'mutual-zugzwang',
          title: 'Mutual zugzwang',
          summary: 'Both sides would prefer to pass — whoever moves loses.',
          fen: '8/8/2k5/8/2K5/8/3P4/8 w - - 0 1',
          result: 'depends', difficulty: 'advanced', category: 'pawn',
        },
      ],
    },
  ],
}

// ── Tree root ────────────────────────────────────────────────────────────────

export const ENDGAME_TREE: EndgameSection[] = [
  KP, KR, KQ, KMINOR, ROOK, MINOR, PAWN,
]

/** Flatten all leaves — handy for fast lookup by id. */
export function allEndgameLeaves(): EndgameLeaf[] {
  return ENDGAME_TREE.flatMap(s => s.groups.flatMap(g => g.leaves))
}

export function findEndgameLeaf(id: string): EndgameLeaf | undefined {
  return allEndgameLeaves().find(l => l.id === id)
}

/** Total count for stats display. */
export function endgameLeafCount(): number {
  return allEndgameLeaves().length
}

/** Categories with their display labels — used in dropdowns/filters. */
export const ENDGAME_CATEGORY_LABELS: Record<EndgameCategory, string> = {
  kp:     'King + Pawn',
  kr:     'King + Rook',
  kq:     'King + Queen',
  kminor: 'King + Minor Piece',
  rook:   'Rook (multi-pawn)',
  minor:  'Minor piece (multi-pawn)',
  pawn:   'Pawn (multi-pawn)',
}

export const ENDGAME_DIFFICULTY_LABELS: Record<EndgameDifficulty, string> = {
  beginner:     'Beginner',
  intermediate: 'Intermediate',
  advanced:     'Advanced',
}

export const ENDGAME_RESULT_LABELS: Record<EndgameResult, string> = {
  white_wins: 'White wins',
  black_wins: 'Black wins',
  draw:       'Draw',
  depends:    'Depends on position',
}
