/**
 * Curated "typical ideas" for the main openings — hand-written, short and
 * plain, checked against each opening's Wikipedia article (linked as `source`).
 * No language model writes these at runtime.
 *
 * Lookup: a tree node shows the notes of the LONGEST curated line that is a
 * prefix of its move path, so every line inside the Najdorf shows the Najdorf
 * notes, the Sicilian shows the Sicilian notes, and so on.
 *
 * To add an opening: append { name, line (SAN from the start), ideas, source }.
 */
import { Chess } from 'chess.js'

export interface OpeningIdea {
  name: string
  line: string
  ideas: string
  source: string
}

const W = 'https://en.wikipedia.org/wiki/'

export const OPENING_IDEAS: OpeningIdea[] = [
  // ── 1.e4 e5 ──────────────────────────────────────────────────────────────
  { name: 'Ruy Lopez', line: 'e4 e5 Nf3 Nc6 Bb5', source: W + 'Ruy_Lopez',
    ideas: 'White pressures the c6-knight that guards e5, castles, and prepares d4 with c3, often rerouting the b1-knight via d2–f1–g3. Black kicks the bishop with …a6 and …b5, then fights for the centre with …d6, …c5 or …d5.' },
  { name: 'Ruy Lopez: Morphy Defence', line: 'e4 e5 Nf3 Nc6 Bb5 a6', source: W + 'Ruy_Lopez',
    ideas: '…a6 makes the bishop decide: take on c6 (Exchange Variation, damaging Black\'s pawns) or retreat to a4 and keep the pressure. The Closed main line becomes a slow, rich fight over d4 and e5 with c3, h3 and a knight manoeuvre to g3.' },
  { name: 'Ruy Lopez: Berlin Defence', line: 'e4 e5 Nf3 Nc6 Bb5 Nf6', source: W + 'Berlin_Defence',
    ideas: 'Black hits e4 instead of the bishop. After 4.O-O Nxe4 5.d4 Nd6 the queens often come off: in the Berlin endgame Black has the bishop pair and a very solid position, White a kingside pawn majority to push. 4.d3 (Anti-Berlin) keeps the queens on.' },
  { name: 'Italian Game', line: 'e4 e5 Nf3 Nc6 Bc4', source: W + 'Italian_Game',
    ideas: 'The bishop aims at f7, Black\'s weakest square. White develops fast and chooses between a slow build-up with c3 and d3 and an early c3–d4 to take the centre.' },
  { name: 'Giuoco Piano', line: 'e4 e5 Nf3 Nc6 Bc4 Bc5', source: W + 'Italian_Game',
    ideas: 'Black mirrors White\'s bishop. With c3 and d4 White grabs the centre and Black must strike back in time; the modern slow plan (c3, d3, a4, Re1, Nbd2–f1–g3) leads to long manoeuvring where Black answers with …d6, …a6 and …Ba7.' },
  { name: 'Two Knights Defence', line: 'e4 e5 Nf3 Nc6 Bc4 Nf6', source: W + 'Two_Knights_Defense',
    ideas: 'Black counter-attacks e4 instead of covering f7. 4.Ng5 hits f7 at once; the main answer 4…d5 5.exd5 Na5 gives a pawn for fast development (5…Nxd5?! invites Nxf7, the Fried Liver). Quieter 4.d3 leads to slow Italian play.' },
  { name: 'Evans Gambit', line: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4', source: W + 'Evans_Gambit',
    ideas: 'White gives the b-pawn to gain time: after 4…Bxb4 5.c3 Ba5 6.d4 White has a broad centre and fast development aimed at Black\'s king. Black keeps the pawn and defends carefully, or returns it with …d6 or …exd4 to finish developing.' },
  { name: 'Scotch Game', line: 'e4 e5 Nf3 Nc6 d4', source: W + 'Scotch_Game',
    ideas: 'White opens the centre at once (3.d4 exd4 4.Nxd4) for free piece play and space. Black hits back with 4…Bc5 or 4…Nf6; after Nxc6 bxc6 the …d5 break gives Black a sound, active game.' },
  { name: 'Four Knights Game', line: 'e4 e5 Nf3 Nc6 Nc3 Nf6', source: W + 'Four_Knights_Game',
    ideas: 'Solid and symmetrical: both sides develop knights before committing. 4.d4 (Scotch Four Knights) opens the centre while 4.Bb5 (Spanish) often brings a Bg5 pin; Black aims for …d5 or a mirror set-up and quick castling.' },
  { name: 'Petrov\'s Defence', line: 'e4 e5 Nf3 Nf6', source: W + 'Petrov%27s_Defence',
    ideas: 'Black counter-attacks e4 instead of defending e5, aiming for a solid, symmetrical game. After 3.Nxe5 Black must play 3…d6 first — 3…Nxe4? 4.Qe2! wins material. White then chooses 5.d4 for space or 5.Nc3 with queenside castling.' },
  { name: 'Philidor Defence', line: 'e4 e5 Nf3 d6', source: W + 'Philidor_Defence',
    ideas: 'A solid but passive guard of e5. Black often uses the Hanham set-up (…Nd7, …c6, …Be7) to hold the point; White takes space with 3.d4, develops quickly and keeps a pleasant edge.' },
  { name: 'King\'s Gambit', line: 'e4 e5 f4', source: W + 'King%27s_Gambit',
    ideas: 'White gives a pawn to open the f-file toward f7 and build a big centre. Black either keeps the pawn with …g5 or returns it with …d5 to develop; declining with 2…Bc5 or the Falkbeer 2…d5 avoids the open f-file.' },
  { name: 'Vienna Game', line: 'e4 e5 Nc3', source: W + 'Vienna_Game',
    ideas: 'A flexible move that prepares f4 (a delayed King\'s Gambit) or Bc4 aimed at f7. Against an early f4 Black usually strikes back with …d5.' },

  // ── 1.e4 c5 ──────────────────────────────────────────────────────────────
  { name: 'Sicilian Defence', line: 'e4 c5', source: W + 'Sicilian_Defence',
    ideas: 'Black fights for d4 from the side and unbalances the game. After the Open Sicilian (Nf3, d4 cxd4) Black gets the half-open c-file and an extra central pawn, while White gets development and space for a kingside attack.' },
  { name: 'Sicilian: Najdorf', line: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6', source: W + 'Sicilian_Defence,_Najdorf_Variation',
    ideas: '…a6 keeps White\'s pieces off b5 and prepares …e5 or …e6 with …b5. White picks between sharp 6.Bg5, the English Attack (Be3, f3, Qd2, g4, O-O-O) and calmer 6.Be2; Black\'s play comes on the queenside and the c-file.' },
  { name: 'Sicilian: Dragon', line: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6', source: W + 'Sicilian_Defence,_Dragon_Variation',
    ideas: 'Black\'s bishop on g7 rakes the long diagonal. In the Yugoslav Attack White plays Be3, Qd2, f3, O-O-O and storms with h4–h5 and g4, trading the dragon bishop with Bh6; Black races with …Rc8, …Ne5–c4 and the …Rxc3 exchange sacrifice.' },
  { name: 'Sicilian: Sveshnikov', line: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5', source: W + 'Sicilian_Defence,_Sveshnikov_Variation',
    ideas: 'Black kicks the knight with …e5, accepting a backward d6-pawn and a hole on d5 for space and active play. White plants a knight on d5 (often after Bxf6 gxf6); Black\'s counterplay is the …f5 break and the bishop pair.' },
  { name: 'Sicilian with 2…e6', line: 'e4 c5 Nf3 e6', source: W + 'Sicilian_Defence',
    ideas: '…e6 frees the dark bishop and keeps Black flexible: …a6 with …Qc7 and …b5 (Kan) or …Nc6 (Taimanov) after 3.d4 cxd4 4.Nxd4. Black often builds a compact set-up and waits for White to overextend.' },
  { name: 'Sicilian: Alapin', line: 'e4 c5 c3', source: W + 'Sicilian_Defence,_Alapin_Variation',
    ideas: 'White prepares d4 to recapture with a pawn and keep a classical centre, avoiding Open Sicilian theory. Black\'s simplest answers hit the centre at once with 2…d5 or 2…Nf6.' },
  { name: 'Closed Sicilian', line: 'e4 c5 Nc3', source: W + 'Sicilian_Defence',
    ideas: 'White avoids d4: g3, Bg2, d3, then Be3 with Qd2 or f4 with Nf3 and a kingside pawn push. Black mirrors with …g6, …Bg7, …d6 and usually expands on the queenside with …Rb8 and …b5.' },
  { name: 'Smith–Morra Gambit', line: 'e4 c5 d4 cxd4 c3', source: W + 'Smith%E2%80%93Morra_Gambit',
    ideas: 'White gives a pawn for a lead in development: Bc4 aims at f7, rooks come to the open c- and d-files and tactics like Nd5 appear. Black must develop carefully and castle quickly — the extra pawn counts later.' },

  // ── other 1.e4 defences ──────────────────────────────────────────────────
  { name: 'French Defence', line: 'e4 e6', source: W + 'French_Defence',
    ideas: 'Black prepares …d5 with a rock-solid pawn chain, at the cost of a passive light bishop on c8. Black\'s freeing breaks are …c5 and …f6; White uses extra kingside space for an attack (f4, g4, f5).' },
  { name: 'French: Winawer', line: 'e4 e6 d4 d5 Nc3 Bb4', source: W + 'French_Defence',
    ideas: 'Black pins the c3-knight and gives the dark bishop for it, doubling White\'s pawns after a3 Bxc3+. White gets the bishop pair and attacks the dark squares (Qg4 hitting g7); Black answers with …c5, …Qc7 and pressure on c2–c3.' },
  { name: 'French: Advance', line: 'e4 e6 d4 d5 e5', source: W + 'French_Defence',
    ideas: 'White grabs space with the d4–e5 chain. Black attacks its base at once with …c5, then …Nc6, …Qb6 and sometimes …Nh6–f5 to pile up on d4.' },
  { name: 'French: Tarrasch', line: 'e4 e6 d4 d5 Nd2', source: W + 'French_Defence',
    ideas: '3.Nd2 avoids the Winawer pin and keeps the c-pawn free to support d4. Black usually answers 3…c5 (often an isolated-pawn game) or 3…Nf6; the fight centres on d4 and e5.' },
  { name: 'Caro-Kann Defence', line: 'e4 c6', source: W + 'Caro%E2%80%93Kann_Defence',
    ideas: 'Black prepares …d5 with a sturdy structure, and unlike the French the light bishop develops outside the chain (…Bf5 or …Bg4). Solid and endgame-friendly; the main later break is …c5.' },
  { name: 'Caro-Kann: Classical', line: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5', source: W + 'Caro%E2%80%93Kann_Defence',
    ideas: 'Black develops the bishop with tempo on the knight. White often pushes h4–h5 to harass it and gain kingside space; Black finishes with …e6, …Nd7, …Ngf6 and castles or plays …c5.' },
  { name: 'Caro-Kann: Advance', line: 'e4 c6 d4 d5 e5', source: W + 'Caro%E2%80%93Kann_Defence',
    ideas: 'White gains space with e5. Black develops …Bf5 before …e6 and then hits the chain with …c5; White either chases the bishop with g4 and h4 or plays calmly with Nf3, Be2 and c3.' },
  { name: 'Pirc Defence', line: 'e4 d6 d4 Nf6 Nc3 g6', source: W + 'Pirc_Defence',
    ideas: 'Black lets White build the e4–d4 centre, fianchettoes on g7, castles and strikes at it later with …c5 or …e5. In the Austrian Attack (f4) White uses the f-pawn to support e5 and a kingside attack.' },
  { name: 'Modern Defence', line: 'e4 g6', source: W + 'Modern_Defense',
    ideas: 'Black fianchettoes first and delays …Nf6, keeping …d6, …c6 or …e5 in reserve against the centre. White can stay solid with c3 or go aggressive with Be3, Qd2 or Bc4 at f7.' },
  { name: 'Scandinavian Defence', line: 'e4 d5', source: W + 'Scandinavian_Defense',
    ideas: 'Black challenges e4 at once. After 2.exd5 Qxd5 3.Nc3 the queen moves again (…Qa5 or …Qd6) and Black develops soundly with …c6 and …Bf5 or …Bg4; 2…Nf6 recaptures later to avoid losing time.' },
  { name: 'Alekhine\'s Defence', line: 'e4 Nf6', source: W + 'Alekhine%27s_Defence',
    ideas: 'Black lures White\'s pawns forward (e5, c4, d4, even f4), then attacks the overextended centre, especially d4. The Modern Variation (Nf3) keeps a modest edge; the Four Pawns Attack is ambitious but double-edged.' },

  // ── 1.d4 d5 ──────────────────────────────────────────────────────────────
  { name: 'Queen\'s Gambit', line: 'd4 d5 c4', source: W + 'Queen%27s_Gambit',
    ideas: 'White offers the c-pawn to pull Black\'s d-pawn away from the centre. Black can\'t keep the pawn comfortably, so the real choice is holding d5 (QGD, Slav) or taking on c4 and fighting back.' },
  { name: 'Queen\'s Gambit Declined', line: 'd4 d5 c4 e6', source: W + 'Queen%27s_Gambit_Declined',
    ideas: '…e6 keeps d5 rock-solid but blocks the c8-bishop. Black frees the game with …c5 or exchanges like …Nd5; in the Exchange Variation White often runs the minority attack b4–b5 to leave Black a weak c-pawn.' },
  { name: 'Queen\'s Gambit Accepted', line: 'd4 d5 c4 dxc4', source: W + 'Queen%27s_Gambit_Accepted',
    ideas: 'Black gives up the centre for free development. White regains the pawn (e3, Bxc4) and Black hits back with …e6 and …c5; isolated d-pawn positions with attacking chances for White are common.' },
  { name: 'Slav Defence', line: 'd4 d5 c4 c6', source: W + 'Slav_Defense',
    ideas: 'The c-pawn supports d5 so the c8-bishop stays free for …Bf5 or …Bg4. After …dxc4 Black may hold the pawn with …b5, so White often plays a4 first; the Czech line …Bf5 is the classical main line.' },
  { name: 'Semi-Slav', line: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6', source: W + 'Semi-Slav_Defense',
    ideas: '…c6 and …e6 build a strong pawn triangle. In the Meran Black takes on c4 and expands with …b5, …Bb7 and …c5; against Bg5 Black chooses the solid Moscow (…h6) or the wild Botvinnik (…dxc4).' },
  { name: 'London System', line: 'd4 d5 Bf4', source: W + 'London_System',
    ideas: 'A set-up rather than a line: Bf4, e3, Nf3, c3, Bd3, Nbd2 and often h3. White aims for a knight on e5 and a slow kingside attack; Black\'s sharpest test is …c5 with …Qb6, hitting b2.' },
  { name: 'Colle System', line: 'd4 d5 Nf3 Nf6 e3', source: W + 'Colle_System',
    ideas: 'White builds d4, Nf3, e3, Bd3, c3, Nbd2, castles and then times the e4 break behind the d3-bishop. The Colle–Zukertort swaps c3 for b3 and Bb2, aiming at the kingside.' },

  // ── 1.d4 Nf6 ─────────────────────────────────────────────────────────────
  { name: 'King\'s Indian Defence', line: 'd4 Nf6 c4 g6 Nc3 Bg7', source: W + 'King%27s_Indian_Defence',
    ideas: 'Black allows a big centre, fianchettoes on g7 and strikes with …e5. Once the centre locks with d5, White attacks on the queenside with c4–c5 while Black storms the kingside with …Nd7 or …Ne8, …f5–f4 and …g5.' },
  { name: 'Grünfeld Defence', line: 'd4 Nf6 c4 g6 Nc3 d5', source: W + 'Gr%C3%BCnfeld_Defence',
    ideas: 'Black lets White build an e4–d4 centre (Exchange Variation) and then attacks it with …c5, the g7-bishop, …Nc6 and …Bg4. White tries to hold the centre and push d5, or attack with Be3, Qd2 and h4.' },
  { name: 'Nimzo-Indian Defence', line: 'd4 Nf6 c4 e6 Nc3 Bb4', source: W + 'Nimzo-Indian_Defence',
    ideas: 'Black pins the c3-knight to stop e4 and is happy to give the bishop for it, doubling White\'s pawns. White keeps the bishop pair and aims for a strong centre (often avoiding doubled pawns with Qc2 or e3); Black fights for e4 and the light squares.' },
  { name: 'Queen\'s Indian Defence', line: 'd4 Nf6 c4 e6 Nf3 b6', source: W + 'Queen%27s_Indian_Defense',
    ideas: '…b6 and …Bb7 control e4 from a distance instead of occupying the centre. White blunts the diagonal with g3 and Bg2, or plays the Petrosian a3 to prepare Nc3 and e4; …Ba6 hitting c4 is a modern idea.' },
  { name: 'Bogo-Indian Defence', line: 'd4 Nf6 c4 e6 Nf3 Bb4+', source: W + 'Bogo-Indian_Defence',
    ideas: 'A check that develops the bishop when Nc3 isn\'t there to pin. Against 4.Bd2 Black usually plays …Qe7; 4.Nbd2 aims to win the bishop pair. Solid, flexible play for Black.' },
  { name: 'Catalan Opening', line: 'd4 Nf6 c4 e6 g3', source: W + 'Catalan_Opening',
    ideas: 'White\'s g2-bishop presses down the long diagonal at b7 and the queenside. In the Open Catalan Black takes on c4 and may hold it with …a6 and …b5; in the Closed Catalan Black keeps d5 and contests the diagonal with …c6.' },
  { name: 'Modern Benoni', line: 'd4 Nf6 c4 c5 d5 e6', source: W + 'Benoni_Defense',
    ideas: 'An unbalanced fight: Black\'s queenside majority (…a6, …b5) backed by the g7-bishop against White\'s central majority with e4–e5 and f4. Sharp and dynamic for both sides.' },
  { name: 'Benko Gambit', line: 'd4 Nf6 c4 c5 d5 b5', source: W + 'Benko_Gambit',
    ideas: 'Black gives a queenside pawn for lasting pressure: half-open a- and b-files for the rooks and the g7-bishop on the long diagonal. White must consolidate the extra pawn and often struggles to develop the f1-bishop.' },
  { name: 'Trompowsky Attack', line: 'd4 Nf6 Bg5', source: W + 'Trompowsky_Attack',
    ideas: 'White threatens Bxf6 to double Black\'s pawns and sidesteps Indian theory. Black can hit the bishop with 2…Ne4, or play 2…e6 or 2…d5 and recapture away from the centre if White takes.' },
  { name: 'Dutch Defence', line: 'd4 f5', source: W + 'Dutch_Defence',
    ideas: '…f5 controls e4 and aims for kingside play, at the cost of a slightly weaker king (the e8–h5 diagonal). Main set-ups: Leningrad (…g6, …Bg7), Stonewall (…d5, …e6, …f5) and Classical (…e6, …Be7, …d6).' },

  // ── flank openings ───────────────────────────────────────────────────────
  { name: 'English Opening', line: 'c4', source: W + 'English_Opening',
    ideas: 'White fights for d5 from the flank, usually fianchettoes on g2 and keeps options open. Against 1…e5 it is a Reversed Sicilian with an extra tempo; many lines transpose to Queen\'s Gambit or Indian structures.' },
  { name: 'Réti Opening', line: 'Nf3 d5 c4', source: W + 'R%C3%A9ti_Opening',
    ideas: 'White attacks d5 from the side with c4 instead of occupying the centre, fianchettoes, castles and often expands with b4. Black chooses between holding d5 (…c6, …e6) and taking on c4.' },
  { name: 'King\'s Indian Attack', line: 'Nf3 d5 g3', source: W + 'King%27s_Indian_Attack',
    ideas: 'A set-up: Nf3, g3, Bg2, O-O, d3, Nbd2 and e4. Against French-style structures White pushes e5 and attacks with h4–h5 and Ng5, while Black counters on the queenside.' },
  { name: 'Bird\'s Opening', line: 'f4', source: W + 'Bird%27s_Opening',
    ideas: 'White controls e5 for kingside chances — a Dutch Defence with an extra tempo — at the cost of a slightly weaker king. From\'s Gambit 1…e5 challenges e5 at once.' },
]

function toUci(line: string): string | null {
  const c = new Chess()
  const out: string[] = []
  for (const san of line.split(' ')) {
    try { const m = c.move(san); out.push(m.from + m.to + (m.promotion ?? '')) } catch { return null }
  }
  return out.join(' ')
}

const BY_PATH: Map<string, OpeningIdea> = new Map()
for (const idea of OPENING_IDEAS) {
  const p = toUci(idea.line)
  if (p) BY_PATH.set(p, idea)
}

/** Curated notes for a tree path (space-separated UCI): exact line, or the nearest named ancestor. */
export function ideasForPath(path: string): { idea: OpeningIdea; exact: boolean } | null {
  const moves = path ? path.split(' ') : []
  for (let n = moves.length; n > 0; n--) {
    const idea = BY_PATH.get(moves.slice(0, n).join(' '))
    if (idea) return { idea, exact: n === moves.length }
  }
  return null
}

export const CURATED_OPENING_COUNT = BY_PATH.size
