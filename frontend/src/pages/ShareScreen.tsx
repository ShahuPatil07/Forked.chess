import { useEffect, useState } from 'react'
import { ArrowUpRight, Check, Headphones, Mic, MicOff, MonitorUp, PhoneOff, Play, RotateCcw, Sparkles, Square, Volume2 } from 'lucide-react'
import { Chessboard } from 'react-chessboard'
import { useShareSession } from '../features/share-screen/useShareSession'
import AnalysisBoard from './AnalysisBoard'
import { Chess } from 'chess.js'

function VoiceOrb({ speaking = false, listening = false }: { speaking?: boolean; listening?: boolean }) {
  return <div className="relative flex items-center justify-center w-36 h-36 mx-auto" aria-hidden="true">
    <div className={`absolute inset-0 rounded-full border border-violet-400/20 ${speaking ? 'animate-ping' : ''}`} />
    <div className={`absolute inset-3 rounded-full bg-accent/10 border border-violet-300/20 ${listening ? 'animate-pulse' : ''}`} />
    <div className="w-24 h-24 rounded-full flex items-center justify-center bg-gradient-to-br from-violet-300 via-accent to-indigo-800 shadow-[0_0_60px_rgba(123,97,255,0.3)]">
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
  const call = useShareSession()
  const [boardOpened, setBoardOpened] = useState(false)
  const [startingFen, setStartingFen] = useState('')
  let validPosition = true
  try { if (startingFen) new Chess(startingFen) } catch { validPosition = false }
  const openBoard = () => setBoardOpened(true)
  const state = call.speaking ? 'Coach speaking' : call.busy ? 'Thinking through your move' : !call.ready
    ? call.boardState : call.muted ? 'Microphone muted' : call.listening ? 'Listening to you' : 'Ready when you are'

  return <div className="p-5 xl:p-8 max-w-[1440px] mx-auto min-w-0" data-testid="share-screen">
    <div className="flex items-center justify-between gap-4 mb-7">
      <div className="flex items-center gap-3">
        <div className="rounded-xl p-2.5 bg-accent/10 border border-accent/20 text-accent"><MonitorUp size={22} /></div>
        <div><h1 className="text-xl font-semibold tracking-tight">Share Screen</h1>
          <p className="text-text-2 text-sm mt-0.5">Your board. Your voice. Your chess coach.</p></div>
      </div>
      <span className="text-[10px] uppercase tracking-[.16em] px-3 py-1.5 rounded-full border border-accent/30 text-violet-300">{call.stream ? 'Live session' : 'Preview · Forked boards'}</span>
    </div>

    {call.error && <div role="alert" className="mb-5 rounded-xl bg-amber-400/10 border border-amber-400/25 p-4 text-sm text-amber-100 flex items-center justify-between gap-4">
      <span>{call.error}</span>{call.stream && <button onClick={call.retryVoice} className="btn-ghost whitespace-nowrap">Retry voice</button>}
    </div>}

    {!boardOpened ? <>
      <div className="grid grid-cols-1 xl:grid-cols-[1.05fr_1fr] gap-6 items-stretch">
        <section className="rounded-2xl border border-border bg-bg-1/90 p-7 lg:p-9">
          <div className="text-xs uppercase tracking-[.2em] text-violet-300 mb-5 flex items-center gap-2"><Headphones size={14} /> A seat beside your coach</div>
          <h2 className="text-3xl lg:text-4xl font-semibold leading-tight tracking-tight max-w-lg">Play a move.<br />Talk it through.</h2>
          <p className="text-text-1 leading-relaxed text-sm mt-5 max-w-lg">Share your Forked Analysis Board and have a spoken conversation about the position. Understand your move, the opponent’s reply, and what you could try instead.</p>
          <ol className="space-y-5 mt-8">
            {[
              ['Open your board', 'Choose a position and open your board right here in the call.'],
              ['Share this workspace', 'Start sharing and choose this tab, named “Forked • Board for live coach” under browser tabs.'],
              ['Pause, then speak', 'Hold a position for 2–3 seconds. Allow the microphone, play a move, and ask your question.'],
            ].map(([title, detail], i) => <li key={title} className="flex gap-3">
              <span className="rounded-full w-6 h-6 flex-shrink-0 flex items-center justify-center border border-accent/30 bg-accent/10 text-xs text-violet-300">{i + 1}</span>
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
          <div className="px-5 py-4 border-b border-white/5 flex justify-between text-xs text-text-2"><span className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-violet-400" /> A look inside your session</span><span>Demo</span></div>
          <div className="flex-1 grid grid-cols-[1.1fr_1fr] items-center gap-4 p-6">
            <div className="max-w-[280px] w-full mx-auto pointer-events-none" aria-hidden="true">
              <Chessboard position="8/3q3k/8/3N4/8/8/8/6K1 w - - 0 1" arePiecesDraggable={false}
                customDarkSquareStyle={{ backgroundColor: '#323052' }} customLightSquareStyle={{ backgroundColor: '#a7a0c8' }}
                customBoardStyle={{ borderRadius: '8px' }} />
            </div>
            <div className="text-center"><VoiceOrb /><p className="text-sm font-medium mt-4">Forked Coach</p><p className="text-xs text-text-2 mt-1">English voice · no chat feed</p></div>
          </div>
          <div className="mx-6 mb-6 p-4 rounded-xl bg-black/20 border border-white/5">
            <p className="text-[10px] uppercase tracking-widest text-violet-300 mb-3">Try asking aloud</p>
            <p className="text-sm text-text-1 leading-loose">“Was that a good move?”<br />“Why is the alternative better?”<br />“What should I play now?”</p>
          </div>
          <div className="border-t border-white/5 p-4 flex items-center justify-center gap-4" aria-hidden="true">
            <div className="p-3 rounded-full bg-white/5"><Mic size={16} /></div><div className="p-3 rounded-full bg-accent/20 text-violet-300"><MonitorUp size={16} /></div><div className="p-3 rounded-full bg-red-500/15 text-red-300"><PhoneOff size={16} /></div>
          </div>
        </section>
      </div>
      <div className="grid md:grid-cols-3 gap-5 mt-6 text-xs text-text-2 leading-relaxed">
        <div className="card p-5"><h3 className="text-text-0 font-medium mb-2 flex gap-2 items-center"><Volume2 size={15} /> Check your sound</h3>
          <p>Headphones help keep your voice clear. Listening pauses while the coach speaks; use Interrupt to take your turn.</p>
          <button onClick={call.testSpeaker} disabled={!call.supported} className="mt-3 text-violet-300 flex gap-1.5 items-center disabled:opacity-40"><Play size={12} /> Test English voice</button></div>
        <div className="card p-5"><h3 className="text-text-0 font-medium mb-2">Free to start</h3>
          <p>The same evidence-based Coach explains your moves aloud using the configured Groq free tier. If its quota is unavailable, a local explanation takes over.</p>
          <label className="flex items-center gap-2 mt-3 text-text-1"><input type="checkbox" className="accent-violet-500" checked={call.useLlm} onChange={e => call.setUseLlm(e.target.checked)} /> Coach explanations (Groq free tier)</label></div>
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
          <AnalysisBoard key={startingFen} embedded liveSession={call.session} startingFen={startingFen} />
        </div>
        <div className="rounded-2xl border border-accent/20 bg-gradient-to-b from-accent/10 to-bg-1 p-6 flex flex-col items-center justify-center min-h-[300px] text-center">
          <VoiceOrb speaking={call.speaking} listening={call.listening} />
          <h2 className="text-lg font-semibold mt-6">Forked Coach</h2>
          <p className="text-sm text-violet-300 mt-2" role="status">{call.stream ? state : 'Start sharing to begin'}</p>
          <div className="h-8 flex items-center justify-center gap-1 mt-4" aria-hidden="true">
            {[12, 22, 32, 18, 26, 14, 22].map((h, i) => <span key={i} className={`w-1 rounded-full bg-violet-400/60 ${call.speaking || call.listening ? 'animate-pulse' : ''}`} style={{ height: call.speaking || call.listening ? h : 4, animationDelay: `${i * 110}ms` }} />)}
          </div>
          <span className="text-[11px] text-text-2 mt-5">{call.ready ? 'Exact board position connected' : 'Waiting for a stable position'}</span>
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
      <p className="text-center text-xs text-text-2">Play on this board while you talk. Say “what should I play now” to discuss the current position.</p>
    </div>}
  </div>
}
