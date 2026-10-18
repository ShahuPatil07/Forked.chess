import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import { ArrowDown, ArrowRight, AudioLines, BookOpen, ChevronRight, Crown, Github, Loader2, Microscope, ScanLine, ScanSearch, Sparkles, Target } from 'lucide-react'
import { api } from '../api'
import { useUserStore } from '../store/userStore'
import './Home.css'

const DEMO_FEN = '8/3q3k/8/3N4/8/8/8/6K1 w - - 0 1'
const DEMO_LINE = ['Nf6+', 'Kg6', 'Nxd7']
const NOTES = [
  ['A check. A fork. A subtle ending.', 'White can attack the king and queen together. But does winning the queen win the game?'],
  ['Nf6+ forces the king to respond.', 'The knight checks on h7 and attacks the queen on d7. Every legal reply moves the king.'],
  ['The queen is still under attack.', 'Kg6 is one legal defense. White can now capture the queen, just as after every other king reply.'],
  ['You win the queen. You save a draw.', 'After Nxd7, king and knight cannot checkmate a lone king. Understanding the ending changes the story.'],
]
const FEATURES = [
  { path: '/game-review', icon: ScanSearch, number: '01 / REVIEW', title: <>The whole game.<br />The moments that matter.</>, body: 'Bring a PGN. Walk through classifications, accuracy, candidate lines and turning points for both sides.', action: 'Open Game Review' },
  { path: '/coach', icon: Sparkles, number: '02 / UNDERSTAND', title: <>Ask why.<br />Then ask “what if?”</>, body: 'A focused coach that compares moves, checks the defense, and follows the line far enough to explain the point.', action: 'Meet your coach' },
  { path: '/share-screen', icon: AudioLines, number: '03 / TALK IT THROUGH', title: <>A board beside you.<br />A coach in your ear.</>, body: 'Play and speak in one workspace. Ask about your last move and hear an explanation with the exact position in context.', action: 'Start a voice session' },
]

export default function Home() {
  const navigate = useNavigate(), { username: stored, setUser } = useUserStore()
  const [demo, setDemo] = useState(0), [username, setUsername] = useState(stored === 'Guest' ? '' : stored)
  const [platform, setPlatform] = useState('lichess'), [minGames, setMinGames] = useState(80)
  const [busy, setBusy] = useState(false), [exists, setExists] = useState(false), [error, setError] = useState('')
  const chess = new Chess(DEMO_FEN)
  for (const san of DEMO_LINE.slice(0, demo)) chess.move(san)
  function enter(path: string) { if (!stored) setUser({ username: 'Guest', platform: 'lichess', elo: 1500 }); navigate(path) }
  async function ingest() {
    const { job_id } = await api.startIngest(username.trim(), platform, minGames)
    setUser({ username: username.trim(), platform: platform as 'lichess' | 'chesscom', activeJobId: job_id }); navigate(`/loading/${job_id}`)
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!username.trim() || busy) return
    setBusy(true); setError(''); setExists(false)
    try {
      const result = await api.check(username.trim())
      setUser({ username: username.trim(), platform: platform as 'lichess' | 'chesscom' })
      if (result.has_profile) setExists(true)
      else await ingest()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not import games. Please try again.') }
    finally { setBusy(false) }
  }
  return <div className="forked-home">
    <header className="home-nav"><a href="/" className="home-brand" aria-label="Forked home"><img src="/logo.png" alt="" /><span>Forked<span className="home-brand-dot">.</span></span></a><nav aria-label="Homepage navigation"><a href="#workbench">The workbench</a><a href="#how-it-works">The approach</a><a href="#your-games">Your games</a></nav><button className="home-button home-button-small" onClick={() => enter('/coach')}>{stored && stored !== 'Guest' ? 'Enter workspace' : 'Start exploring'}<ArrowRight size={15} /></button></header>
    <main>
      <section className="home-hero"><div className="home-hero-copy"><p className="home-eyebrow"><span />A CHESS WORKBENCH FOR CURIOUS MINDS</p><h1>Every move<br />has a <em>reason.</em></h1><p className="home-intro">Find yours. Review a game, talk through a position, and see the idea behind the engine’s answer.</p><div className="home-actions"><button className="home-button" onClick={() => enter('/game-review')}>Review a game<ArrowRight size={18} /></button><button className="home-secondary" onClick={() => enter('/share-screen')}><AudioLines size={18} />Talk to your coach</button></div><p className="home-fine">Local game review. Free tools. No daily review limit.</p><a href="#workbench" className="home-scroll"><ArrowDown size={15} />Make your next move mean something</a></div>
        <div className="home-demo"><div className="home-demo-top"><span><span className="home-live-dot" />THE IDEA LAB</span><span>Try a position</span></div><div className="home-demo-board"><Chessboard id="homepage-demo" position={chess.fen()} arePiecesDraggable={false} animationDuration={200} customDarkSquareStyle={{ backgroundColor: '#57506d' }} customLightSquareStyle={{ backgroundColor: '#d2c9db' }} customSquareStyles={demo === 1 ? { f6: { backgroundColor: '#b6a8e6' } } : {}} /></div><div className="home-demo-note" aria-live="polite"><span className="home-note-icon"><Sparkles size={17} /></span><div><h2>{NOTES[demo][0]}</h2><p>{NOTES[demo][1]}</p></div></div><div className="home-demo-controls"><span>0{demo + 1} / 04</span><div><button onClick={() => setDemo(0)} disabled={!demo}>Reset</button><button onClick={() => setDemo(d => Math.min(3, d + 1))} disabled={demo === 3}>Follow the idea<ChevronRight size={15} /></button></div></div></div>
      </section>
      <div className="home-principles"><span>CALCULATE WITH STOCKFISH</span><span>QUESTION THE POSITION</span><span>UNDERSTAND THE CONSEQUENCE</span></div>
      <section id="workbench" className="home-section"><div className="home-section-heading"><div><p className="home-eyebrow">YOUR NEXT SESSION STARTS HERE</p><h2>One board.<br /><span>More ways to get better.</span></h2></div><p>From the first “why?” to the final move. A connected set of tools for studying the game.</p></div><div className="home-feature-grid">{FEATURES.map(({ path, icon: Icon, number, title, body, action }, i) => <button key={path} className={`home-feature ${i === 0 ? 'home-feature-review' : ''}`} onClick={() => enter(path)}><div className="home-feature-icon"><Icon size={23} /></div><span className="home-feature-number">{number}</span><h3>{title}</h3><p>{body}</p>{i === 0 ? <div className="home-move-strip"><span>★ Best</span><span>!! Brilliant</span><span>? Mistake</span></div> : i === 1 ? <span className="home-question">“Why not take the pawn first?”</span> : <div className="home-wave" aria-hidden="true">{[9,22,34,18,42,29,15,32,19,9].map((h,j) => <i key={j} style={{height:h}} />)}</div>}<span className="home-feature-link">{action}<ArrowRight size={17} /></span></button>)}</div>
        <div className="home-tools">{[
          { path: '/analysis', icon: Microscope, label: 'Analysis Board', detail: 'Explore without limits' }, { path: '/openings', icon: BookOpen, label: 'Openings', detail: 'Find your way into the game' }, { path: '/endgames', icon: Crown, label: 'Endgames', detail: 'Practice the final chapter' }, { path: '/session', icon: Target, label: 'Drills', detail: 'Put understanding to work' }, { path: '/otb-scan', icon: ScanLine, label: 'OTB Scan', detail: 'Bring the physical board along' },
        ].map(({path,icon:Icon,label,detail}) => <button key={path} onClick={() => enter(path)}><Icon size={19} /><strong>{label}</strong><small>{detail}</small></button>)}</div>
      </section>
      <section id="how-it-works" className="home-approach home-section"><p className="home-eyebrow">THE ENGINE CALCULATES. UNDERSTANDING COMES NEXT.</p><div className="home-approach-grid"><h2>Don’t just memorize<br /><em>the answer.</em></h2><div><p>A number can tell you a position is better. It takes a continuation, a defense, and a comparison to understand what changed.</p>{[['Start with the actual board','Legal moves and exact position context, before any explanation.'],['Test another idea','Compare candidate moves and investigate the opponent’s replies.'],['Keep the useful part','A concise explanation, with a concrete line when the position needs it.']].map(([title,body],i) => <div className="home-method" key={title}><span>0{i+1}</span><div><h3>{title}</h3><p>{body}</p></div></div>)}</div></div></section>
      <section id="your-games" className="home-section home-import"><div><p className="home-eyebrow">YOUR TRAINING HISTORY STILL BELONGS HERE</p><h2>Bring your games.<br /><span>Find your patterns.</span></h2><p>Keep using Forked’s blindspot dashboard and targeted drills. Import public games, or pick up an existing local profile.</p><p className="home-fine">Coach and Game Review work immediately, without this import. Their explanations use the position you supply, not your profile.</p></div><form onSubmit={submit} className="home-import-form"><label>Chess username<input value={username} onChange={e => { setUsername(e.target.value); setExists(false) }} placeholder="Your username" required maxLength={80} /></label><div className="home-form-row"><label>Platform<select value={platform} onChange={e => setPlatform(e.target.value)}><option value="lichess">Lichess</option><option value="chesscom">Chess.com</option></select></label><label>Games<select value={minGames} onChange={e => setMinGames(Number(e.target.value))}><option value={80}>80 games</option><option value={150}>150 games</option><option value={200}>200 games</option></select></label></div>{error && <p role="alert" className="home-error">{error}</p>}{exists ? <div><p className="home-fine">Your local profile is ready.</p><button type="button" className="home-button" onClick={() => navigate('/dashboard')}>Continue to dashboard<ArrowRight size={16} /></button><button type="button" disabled={busy} className="home-secondary" onClick={async () => { setBusy(true); try { await ingest() } catch(e) { setError(e instanceof Error ? e.message : 'Import failed') } finally { setBusy(false) } }}>Refresh games</button></div> : <button className="home-button" disabled={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}Import public games</button>}</form></section>
    </main><footer className="home-footer"><span className="home-brand">Forked<span className="home-brand-dot">.</span></span><p>Stay curious. Make your next move.</p><a href="https://github.com/ShahuPatil07/Zugzwang" target="_blank" rel="noreferrer"><Github size={17} />Source code</a></footer>
  </div>
}
