import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Chessboard } from 'react-chessboard'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, X, Zap, Microscope, RefreshCw, ChevronRight } from 'lucide-react'
import type { Square } from 'chess.js'
import type { Arrow } from 'react-chessboard/dist/chessboard/types'
import { useUserStore } from '../../store/userStore'
import { api } from '../../api'
import { liveApi, type BlindspotAlert } from '../../api/live'
import { lossPts } from '../../lib/format'
import { useElementWidth } from '../../hooks/useElementWidth'
import { BOARD_DARK, BOARD_LIGHT } from '../../theme'
import { Chess } from 'chess.js'

function sanOf(fen: string, uci: string | null | undefined): string {
  if (!uci) return '—'
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san
  } catch {
    return `${uci.slice(0, 2)}→${uci.slice(2, 4)}`
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime()
  const secs = Math.max(0, (Date.now() - then) / 1000)
  if (secs < 90)      return 'just now'
  if (secs < 3600)    return `${Math.round(secs / 60)} min ago`
  if (secs < 86400)   return `${Math.round(secs / 3600)} h ago`
  return `${Math.round(secs / 86400)} d ago`
}

function moveArrows(played: string, best: string): Arrow[] {
  const out: Arrow[] = []
  if (best?.length >= 4)   out.push([best.slice(0, 2) as Square, best.slice(2, 4) as Square, '#0DC97F'])
  if (played?.length >= 4) out.push([played.slice(0, 2) as Square, played.slice(2, 4) as Square, '#FF4D4D'])
  return out
}

export function BlindspotAlerts() {
  const { username, platform } = useUserStore()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [openAlert, setOpenAlert] = useState<BlindspotAlert | null>(null)
  const [modalRef, modalW] = useElementWidth<HTMLDivElement>(360)
  const modalBoard = Math.max(220, Math.min(360, modalW))

  // Fire a sync on mount (login / dashboard visit)
  useEffect(() => {
    if (username) liveApi.triggerSync(username, platform || 'lichess').catch(() => {})
  }, [username, platform])

  const { data: alertsData } = useQuery({
    queryKey: ['alerts', username],
    queryFn:  () => liveApi.getAlerts(username),
    enabled:  !!username,
    refetchInterval: 60_000,
  })
  const { data: profile } = useQuery({
    queryKey: ['profile', username],
    queryFn:  () => api.getProfile(username),
    enabled:  !!username,
  })
  const { data: sync } = useQuery({
    queryKey: ['sync', username],
    queryFn:  () => liveApi.getSyncStatus(username),
    enabled:  !!username,
    refetchInterval: 30_000,
  })

  const alerts = alertsData?.alerts ?? []
  const top = alerts[0]

  function labelFor(a: BlindspotAlert): string {
    const c = profile?.clusters?.find((c: any) => String(c.cluster_id) === String(a.cluster_id))
    return c?.label ?? `Cluster #${a.cluster_rank}`
  }

  async function dismiss(ids: string[]) {
    if (username) await liveApi.markAlertsSeen(username, ids).catch(() => {})
    qc.invalidateQueries({ queryKey: ['alerts', username] })
  }

  function startDrill(a: BlindspotAlert) {
    dismiss([a.id])
    setOpenAlert(null)
    navigate('/session', { state: { clusterId: String(a.cluster_id) } })
  }

  function manualSync() {
    if (!username) return
    liveApi.triggerSync(username, platform || 'lichess').catch(() => {})
    qc.invalidateQueries({ queryKey: ['sync', username] })
  }

  return (
    <div className="mb-5">
      {/* Sync status line */}
      <div className="flex items-center justify-end mb-2">
        <button onClick={manualSync}
          className="flex items-center gap-1.5 text-[11px] text-text-2 hover:text-text-1 transition-colors"
          title="Sync now">
          <RefreshCw size={11} className={sync?.is_syncing ? 'animate-spin text-accent' : ''} />
          {sync?.is_syncing
            ? 'Syncing…'
            : sync?.last_synced_at
              ? `Last synced ${relativeTime(sync.last_synced_at)}`
              : 'Sync now'}
        </button>
      </div>

      {/* Banner */}
      <AnimatePresence>
        {top && (
          <motion.div
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2"
          >
            <AlertTriangle size={18} className="text-danger flex-shrink-0" />
            <div className="flex-1 min-w-[12rem]">
              <p className="text-sm text-text-0">
                You repeated a known weakness on move {top.move_number}
                {top.opponent ? ` vs ${top.opponent}` : ''}
                <span className="text-text-2"> · {relativeTime(top.timestamp)}</span>
              </p>
              <p className="text-xs text-text-2 mt-0.5">
                {labelFor(top)} · one of your costliest patterns
                {alerts.length > 1 && (
                  <button onClick={() => setOpenAlert(alerts[1])} className="text-accent hover:underline ml-1">
                    and {alerts.length - 1} more
                  </button>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2 ml-auto">
            <button onClick={() => setOpenAlert(top)} className="btn-ghost text-xs flex items-center gap-1 flex-shrink-0">
              <Microscope size={12} /> View
            </button>
            <button onClick={() => startDrill(top)} className="btn-primary text-xs flex items-center gap-1 flex-shrink-0">
              <Zap size={12} /> Drill
            </button>
            <button onClick={() => dismiss([top.id])}
              className="p-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-2 flex-shrink-0" title="Dismiss">
              <X size={14} />
            </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Detail modal */}
      <AnimatePresence>
        {openAlert && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setOpenAlert(null)}
            className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-bg-1 border border-border rounded-2xl p-5 max-w-md w-full shadow-2xl space-y-4">
              <div className="flex items-start gap-2">
                <AlertTriangle size={18} className="text-danger mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-text-0">{labelFor(openAlert)}</p>
                  <p className="text-xs text-text-2">
                    Your #{openAlert.cluster_rank} family by cost
                    {openAlert.opponent ? ` · vs ${openAlert.opponent}` : ''} · move {openAlert.move_number}
                  </p>
                </div>
                <button onClick={() => setOpenAlert(null)} className="p-1 rounded text-text-2 hover:text-text-0 hover:bg-bg-2">
                  <X size={16} />
                </button>
              </div>

              <div ref={modalRef} className="w-full">
              <Chessboard
                position={openAlert.fen}
                arePiecesDraggable={false}
                customArrows={moveArrows(openAlert.played_move, openAlert.best_move)}
                boardWidth={modalBoard}
                customDarkSquareStyle={{ backgroundColor: BOARD_DARK }}
                customLightSquareStyle={{ backgroundColor: BOARD_LIGHT }}
                customBoardStyle={{ borderRadius: '6px', boxShadow: '0 0 0 1px rgba(200,255,42,0.18)' }}
              />
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="font-mono text-danger">
                  you played {sanOf(openAlert.fen, openAlert.played_move)} ({lossPts(openAlert.eval_drop)})
                </span>
                <span className="font-mono text-success">
                  best {sanOf(openAlert.fen, openAlert.best_move)}
                </span>
              </div>



              <button onClick={() => startDrill(openAlert)}
                className="btn-primary w-full flex items-center justify-center gap-1.5 text-sm">
                <Zap size={13} /> Start drill <ChevronRight size={13} />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
