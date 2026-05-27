import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Save, RefreshCw, AlertCircle, Check, LogOut } from 'lucide-react'
import { useUserStore } from '../store/userStore'
import { api } from '../api'

type Platform = 'lichess' | 'chesscom'

export default function Settings() {
  const { username, platform: storedPlatform, elo: storedElo, setUser, clearUser } = useUserStore()
  const navigate   = useNavigate()
  const queryClient = useQueryClient()

  const [platform, setPlatform] = useState<Platform>(storedPlatform ?? 'lichess')
  const [elo,      setElo]      = useState<number>(storedElo ?? 1200)
  const [saved,    setSaved]    = useState(false)

  const { data } = useQuery({
    queryKey: ['settings', username],
    queryFn:  () => api.getSettings(username),
    enabled:  !!username,
  })

  // Sync server values once loaded
  useEffect(() => {
    if (data) {
      setPlatform(data.platform)
      setElo(data.elo)
    }
  }, [data])

  const mutation = useMutation({
    mutationFn: () => api.updateSettings(username, { elo, platform }),
    onSuccess: (updated) => {
      setUser({ platform: updated.platform, elo: updated.elo })
      queryClient.invalidateQueries({ queryKey: ['settings', username] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  async function handleReanalyse() {
    try {
      const { job_id } = await api.startIngest(username, platform, 80)
      setUser({ activeJobId: job_id })
      queryClient.clear()
      navigate(`/loading/${job_id}`)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to start re-analysis')
    }
  }

  return (
    <div className="p-8 max-w-xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-0">Settings</h1>
        <p className="text-text-2 text-sm mt-1">{username}</p>
      </div>

      <div className="space-y-6">
        {/* Platform */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-text-0 mb-4">Platform</h2>
          <div className="grid grid-cols-2 gap-2">
            {(['lichess', 'chesscom'] as Platform[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatform(p)}
                className={`py-2.5 rounded-md text-sm font-medium transition-all duration-150 border
                  ${platform === p
                    ? 'bg-accent/15 border-accent/40 text-accent'
                    : 'bg-bg-2 border-border text-text-1 hover:text-text-0 hover:border-border-hover'}`}
              >
                {p === 'lichess' ? 'Lichess' : 'Chess.com'}
              </button>
            ))}
          </div>
        </div>

        {/* ELO */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-text-0 mb-1">Estimated ELO</h2>
          <p className="text-xs text-text-2 mb-4">Used to match puzzle difficulty to your level.</p>
          <input
            type="number"
            min={400}
            max={3000}
            step={50}
            value={elo}
            onChange={(e) => setElo(Number(e.target.value))}
            className="input w-full"
          />
          <p className="text-xs text-text-2 mt-2">Puzzles will be served at ±200 ELO of this value.</p>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="btn-primary flex items-center gap-2 flex-1 justify-center"
          >
            {saved
              ? <><Check size={14} /> Saved!</>
              : mutation.isPending
              ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving...</>
              : <><Save size={14} /> Save changes</>
            }
          </motion.button>
        </div>

        {mutation.isError && (
          <div className="flex items-center gap-2 text-sm text-danger bg-danger/10 border border-danger/20 rounded-md px-3 py-2">
            <AlertCircle size={13} />
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to save.'}
          </div>
        )}

        {/* Danger zone */}
        <div className="card p-5 border-danger/20">
          <h2 className="text-sm font-semibold text-text-0 mb-1">Re-analyse games</h2>
          <p className="text-xs text-text-2 mb-4">
            Pull your latest games and rebuild your blindspot profile from scratch.
            This replaces your current profile.
          </p>
          <button
            onClick={handleReanalyse}
            className="btn-ghost flex items-center gap-2 text-sm w-full justify-center border-danger/30 text-danger hover:bg-danger/10"
          >
            <RefreshCw size={13} /> Re-analyse my games
          </button>
        </div>

        {/* Switch account */}
        <div className="card p-5">
          <h2 className="text-sm font-semibold text-text-0 mb-1">Switch account</h2>
          <p className="text-xs text-text-2 mb-4">
            Analyse a different Chess.com or Lichess username.
          </p>
          <button
            onClick={() => { clearUser(); navigate('/') }}
            className="btn-ghost flex items-center gap-2 text-sm w-full justify-center"
          >
            <LogOut size={13} /> Switch user
          </button>
        </div>
      </div>
    </div>
  )
}
