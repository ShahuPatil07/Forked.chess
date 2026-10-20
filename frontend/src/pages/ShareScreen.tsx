import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, Headphones, Mic, MicOff, MonitorUp, PhoneOff, Play, RotateCcw, Sparkles, Square, Volume2, X } from 'lucide-react'
import { Chessboard } from 'react-chessboard'
import { useShareSession } from '../features/share-screen/useShareSession'
import { CoachWorkspaceBoard, useCoachBoard, applyCoachEvent, boardInfo, loadMaiaElo, START_FEN } from '../components/coach/CoachWorkspaceBoard'
import { PositionEditor } from '../components/coach/PositionEditor'
import { loadCoachProfile } from '../components/coach/LevelQuestionnaire'
import type { ConfiguratorEvent } from '../api/coach'
import { Chess } from 'chess.js'

function VoiceOrb({ speaking = false, listening = false }: { speaking?: boolean; listening?: boolean }) {
  return <div className="relative flex items-center justify-center w-36 h-36 mx-auto" aria-hidden="true">
    <div className={`absolute inset-0 rounded-full border border-accent/20 ${speaking ? 'animate-ping' : ''}`} />
    <div className={`absolute inset-3 rounded-full bg-accent/10 border border-accent/20 ${listening ? 'animate-pulse' : ''}`} />
    <div className="w-24 h-24 rounded-full flex items-center justify-center bg-gradient-to-br from-lime-200 via-accent to-neutral-900 shadow-[0_0_60px_rgba(200,255,42,0.3)]">
      <Sparkles size={34} className="text-white" />
    </div>
  </div>
}

function CallClock({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - since) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [since])
  return <span className="font-mono text-xs tabular-nums">{Math.floor(elapsed / 60).toString().padStart(2, '0')}:{(elapsed % 60).toString().padStart(2, '0')}</span>
}

export default function ShareScreen() {
  // The call uses the Coach's tabbed board: puzzles and positions the coach sets up open in their own tab.
  const board = useCoachBoard(START_FEN)
  const boardRef = useRef(board); boardRef.current = board
  const seenPuzzles = useRef<string[]>([])
  const [editor, setEditor] = useState<ConfiguratorEvent | null>(null)
  const call = useShareSession({
    context: () => ({ profile: loadCoachProfile(), board_info: boardInfo(boardRef.current),
                      seen_puzzles: seenPuzzles.current, maia_elo: loadMaiaElo() }),
    onEvents: events => events.forEach(e => {
      if (e.type === 'configurator') { setEditor(e); return }
      applyCoachEvent(boardRef.current, e)
      if (e.type === 'puzzle' && e.payload.puzzle_id) seenPuzzles.current = [...seenPuzzles.current, e.payload.puzzle_id].slice(-150)
    }),
  })
  const [boardOpened, setBoardOpened] = useState(false)
  const [startingFen, setStartingFen] = useState('')
  let validPosition = true
  try { if (startingFen) new Chess(startingFen) } catch { validPosition = false }
  const openBoard = () => {
    board.switchTab('main')
    board.setPosition(startingFen ? new Chess(startingFen).fen() : START_FEN, 'Your board')
    setBoardOpened(true)
  }
  const state = call.speaking ? 'Coach speaking' : call.busy ? 'Thinking through your move' : !call.ready
    ? call.boardState : call.muted ? 'Microphone muted' : call.listening ? 'Listening to you' : 'Ready when you are'

  return <div className="p-5 xl:p-8 max-w-[1440px] mx-auto min-w-0" data-testid="share-screen">
    <div className="flex items-center justify-between gap-4 mb-7">
      <div className="flex items-center gap-3">
        <div className="rounded-xl p-2.5 bg-accent/10 border border-accent/20 text-accent"><MonitorUp size={22} /></div>
        <div><h1 className="text-xl font-semibold tracking-tight">Share Screen</h1>
          <p className="text-text-2 text-sm mt-0.5">Your board. Your voice. Your chess coach.</p></div>
      </div>
      <span className="text-[10px] uppercase tracking-[.16em] px-3 py-1.5 rounded-full border border-accent/30 text-accent">{call.stream ? 'Live session' : 'Preview · Forked boards'}</span>
    </div>

    {call.error && <div role="alert" className="mb-5 rounded-xl bg-amber-400/10 border border-amber-400/25 p-4 text-sm text-amber-100 flex items-center justify-between gap-4">
      <span>{call.error}</span>{call.stream && <button onClick={call.retryVoice} className="btn-ghost whitespace-nowrap">Retry voice</button>}
    </div>}

    {!boardOpened ? <>
      <div className="grid grid-cols-1 xl:grid-cols-[1.05fr_1fr] gap-6 items-stretch">
        <section className="rounded-2xl border border-border bg-bg-1/90 p-7 lg:p-9">
          <div className="text-xs uppercase tracking-[.2em] text-accent mb-5 flex items-center gap-2"><Headphones size={14} /> A seat beside your coach</div>
          <h2 className="text-3xl lg:text-4xl font-semibold leading-tight tracking-tight max-w-lg">Play a move.<br />Talk it through.</h2>
          <p className="text-text-1 leading-relaxed text-sm mt-5 max-w-lg">Share your Forked Analysis Board and have a spoken conversation about the position. Understand your move, the opponent’s reply, and what you could try instead.</p>
          <ol className="space-y-5 mt-8">
            {[
              ['Open your board', 'Choose a position and open your board right here in the call.'],
              ['Share this workspace', 'Start sharing and choose this tab, named “Forked • Board for live coach” under browser tabs.'],
              ['Pause, then speak', 'Hold a position for 2–3 seconds. Allow the microphone, play a move, and ask your question.'],
            ].map(([title, detail], i) => <li key={title} className="flex gap-3">
              <span className="rounded-full w-6 h-6 flex-shrink-0 flex items-center justify-center border border-accent/30 bg-accent/10 text-xs text-accent">{i + 1}</span>
              <div><h3 className="text-sm font-medium">{title}</h3><p className="text-xs text-text-2 leading-relaxed mt-1">{detail}</p></div>
            </li>)}
          </ol>
          <label className="block text-xs text-text-2 mt-6">Starting position
            <select className="input mt-2 max-w-xs" value={startingFen} onChange={e => { setStartingFen(e.target.value); setBoardOpened(false) }}>
              <option value="">New game</option>
              <option value="7k/6pp/8/8/8/8/R7/K7 w - - 0 1">Try a checkmate</option>
              <option value="8/3q3k/8/3N4/8/8/8/6K1 w - - 0 1">Try a knight fork</option>
            </select>
          </label>
          <label className="block text-xs text-text-2 mt-4">Or paste a starting FEN
            <input aria-label="Starting FEN" className="input mt-2 font-mono text-xs" value={startingFen} onChange={e => setStartingFen(e.target.value)} placeholder="Leave blank for a new game" />
          </label>
          {!validPosition && <p className="text-xs text-amber-200 mt-2">Enter a valid chess position before opening the board.</p>}
          <div className="flex flex-wrap gap-3 mt-5">
            <button className="btn-primary flex items-center gap-2" disabled={!validPosition} onClick={openBoard}>
              {boardOpened ? <Check size={15} /> : <ArrowUpRight size={15} />} {boardOpened ? 'Board ready' : 'Open Analysis Board'}
            </button>
          </div>
          {!call.supported && <p className="text-xs text-amber-200 mt-4">This preview needs desktop Chrome or Edge with tab capture and speech recognition, on localhost or HTTPS.</p>}
        </section>

        <section className="rounded-2xl border border-border overflow-hidden bg-gradient-to-b from-[#19152c] to-bg-1 flex flex-col" aria-label="Static session preview">
          <div className="px-5 py-4 border-b border-white/5 flex justify-between text-xs text-text-2"><span className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-accent" /> A look inside your session</span><span>Demo</span></div>
          <div className="flex-1 grid grid-cols-[1.1fr_1fr] items-center gap-4 p-6">
            <div className="max-w-[280px] w-full mx-auto pointer-events-none" aria-hidden="true">
              <Chessboard position="8/3q3k/8/3N4/8/8/8/6K1 w - - 0 1" arePiecesDraggable={false}
                customDarkSquareStyle={{ backgroundColor: '#323052' }} customLightSquareStyle={{ backgroundColor: '#a7a0c8' }}
                customBoardStyle={{ borderRadius: '8px' }} />
            </div>
            <div className="text-center"><VoiceOrb /><p className="text-sm font-medium mt-4">Forked Coach</p><p className="text-xs text-text-2 mt-1">English voice · no chat feed</p></div>
          </div>
          <div className="mx-6 mb-6 p-4 rounded-xl bg-black/20 border border-white/5">
            <p className="text-[10px] uppercase tracking-widest text-accent mb-3">Try asking aloud</p>
            <p className="text-sm text-text-1 leading-loose">“Was that a good move?”<br />“What should I play now?”<br />“Give me a fork puzzle.”<br />“Set up the Lucena position.”</p>
          </div>
          <div className="border-t border-white/5 p-4 flex items-center justify-center gap-4" aria-hidden="true">
            <div className="p-3 rounded-full bg-white/5"><Mic size={16} /></div><div className="p-3 rounded-full bg-accent/20 text-accent"><MonitorUp size={16} /></div><div className="p-3 rounded-full bg-red-500/15 text-red-300"><PhoneOff size={16} /></div>
          </div>
        </section>
      </div>
      <div className="grid md:grid-cols-3 gap-5 mt-6 text-xs text-text-2 leading-relaxed">
        <div className="card p-5"><h3 className="text-text-0 font-medium mb-2 flex gap-2 items-center"><Volume2 size={15} /> Check your sound</h3>
          <p>Headphones help keep your voice clear. Listening pauses while the coach speaks; use Interrupt to take your turn.</p>
          <button onClick={call.testSpeaker} disabled={!call.supported} className="mt-3 text-accent flex gap-1.5 items-center disabled:opacity-40"><Play size={12} /> Test English voice</button></div>
        <div className="card p-5"><h3 className="text-text-0 font-medium mb-2">The same Coach, out loud</h3>
          <p>The same evidence-based Coach as the chat answers aloud: it analyses your board, and can put a puzzle or a position on it in a new tab. If the AI model is unavailable, a local engine explanation takes over.</p>
          <label className="flex items-center gap-2 mt-3 text-text-1"><input type="checkbox" className="accent-lime-300" checked={call.useLlm} onChange={e => call.setUseLlm(e.target.checked)} /> AI coach explanations</label></div>
        <div className="card p-5"><h3 className="text-text-0 font-medium mb-2">A connected board, a private preview</h3>
          <p>Play and talk in this tab. The board supplies the exact position and last move. Screen video stays in your browser. Speech recognition may send audio to your browser’s speech service. Calls aren’t recorded by Forked.</p></div>
      </div>
    </> : <div className="space-y-4" data-testid="live-call">
      <div className="flex justify-between items-center text-xs text-text-2 px-1 gap-4">
        <span className="flex gap-2 items-center"><span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />{call.stream ? 'Sharing this workspace ' : 'Board ready '}{call.stream && <CallClock since={call.startedAt} />}</span>
        <label className="flex items-center gap-2"><input type="checkbox" checked={call.useLlm} onChange={e => call.setUseLlm(e.target.checked)} />Coach explanations</label>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_270px] gap-4">
        <div className="rounded-2xl border border-border bg-bg-1 p-4">
          <CoachWorkspaceBoard board={board} busy={call.busy} liveSession={call.session} />
        </div>
        <div className="rounded-2xl border border-accent/20 bg-gradient-to-b from-accent/10 to-bg-1 p-6 flex flex-col items-center justify-center min-h-[300px] text-center">
          <VoiceOrb speaking={call.speaking} listening={call.listening} />
          <h2 className="text-lg font-semibold mt-6">Forked Coach</h2>
          <p className="text-sm text-accent mt-2" role="status">{call.stream ? state : 'Start sharing to begin'}</p>
          <div className="h-8 flex items-center justify-center gap-1 mt-4" aria-hidden="true">
            {[12, 22, 32, 18, 26, 14, 22].map((h, i) => <span key={i} className={`w-1 rounded-full bg-accent/60 ${call.speaking || call.listening ? 'animate-pulse' : ''}`} style={{ height: call.speaking || call.listening ? h : 4, animationDelay: `${i * 110}ms` }} />)}
          </div>
          <span className="text-[11px] text-text-2 mt-5">{call.ready ? 'Exact board position connected' : 'Waiting for a stable position'}</span>
          {editor && (
            <div className="mt-5 w-full text-left">
              <div className="flex justify-end mb-1">
                <button onClick={() => setEditor(null)} className="text-text-2 hover:text-text-0" aria-label="Close the position editor"><X size={13} /></button>
              </div>
              <PositionEditor initial={editor} onGenerated={pos => board.openPosition(pos.fen, pos.material, null, ['play'])} />
            </div>
          )}
        </div>
      </div>
      <div className="rounded-2xl border border-border bg-bg-1 p-4 flex flex-wrap justify-center gap-3">
        {!call.stream && <button className="btn-primary flex gap-2 items-center" disabled={!call.supported || call.starting} onClick={call.start}><MonitorUp size={17} />{call.starting ? 'Choose this browser tab...' : 'Start sharing'}</button>}
        {!call.stream && <button className="btn-ghost" onClick={() => setBoardOpened(false)}>Back to setup</button>}

        <button className={`btn-ghost border flex items-center gap-2 ${call.muted ? 'border-red-400/30 text-red-300' : 'border-border'}`} aria-pressed={call.muted} onClick={call.toggleMic}>{call.muted ? <MicOff size={17} /> : <Mic size={17} />}{call.muted ? 'Unmute' : 'Mute'}</button>
        <button className="btn-ghost border border-border flex items-center gap-2" onClick={call.interrupt}><Square size={15} />Interrupt</button>
        <button className="btn-ghost border border-border flex items-center gap-2 disabled:opacity-30" disabled={!call.hasAnswer || call.busy} onClick={call.repeat}><RotateCcw size={15} />Repeat answer</button>
        <button className="btn-danger flex items-center gap-2" onClick={() => { call.end(); setBoardOpened(false) }}><PhoneOff size={17} />End call</button>
      </div>
      <p className="text-center text-xs text-text-2">Play on this board while you talk. Ask “what should I play now”, or for a puzzle or position — it opens in a new tab above the board.</p>
    </div>}
  </div>
}
