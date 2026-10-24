import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle, ArrowRight, Camera, Check, ChevronLeft, ImageUp, Lightbulb, Loader2, Plus, X,
} from 'lucide-react'

interface Props {
  onAnalyse: (files: File[]) => void
  onBack: () => void
  processing: boolean
  error: string | null
}

const MAX_PAGES = 4
const STEPS = ['Reading the handwriting', 'Matching every cell to a legal move', 'Checking the whole game']

export function ScoresheetUpload({ onAnalyse, onBack, processing, error }: Props) {
  const [pages, setPages] = useState<{ file: File; url: string }[]>([])
  const [step, setStep] = useState(0)
  const pagesRef = useRef(pages)
  pagesRef.current = pages

  useEffect(() => () => pagesRef.current.forEach(p => URL.revokeObjectURL(p.url)), [])

  // Staged progress while the request runs (reading dominates; decoding is ~1 s).
  useEffect(() => {
    if (!processing) { setStep(0); return }
    const timers = [window.setTimeout(() => setStep(1), 5200), window.setTimeout(() => setStep(2), 8200)]
    return () => timers.forEach(clearTimeout)
  }, [processing])

  const add = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    setPages(prev => [...prev, ...files.map(file => ({ file, url: URL.createObjectURL(file) }))].slice(0, MAX_PAGES))
  }
  const remove = (i: number) => setPages(prev => {
    URL.revokeObjectURL(prev[i].url)
    return prev.filter((_, k) => k !== i)
  })

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <button onClick={onBack} className="btn-ghost flex items-center gap-1 mb-3" disabled={processing}>
        <ChevronLeft size={15} /> Back
      </button>
      <h1 className="font-display text-2xl font-semibold text-text-0">Upload scoresheet</h1>
      <p className="text-sm text-text-2 mt-1">
        One photo per page, in order. Most games fit on one page; add the second page for longer games.
      </p>

      {!pages.length ? (
        <div className="mt-5 grid sm:grid-cols-2 gap-3">
          <PickButton icon={Camera} label="Take a photo" hint="Opens your camera" accept="image/*" capture onChange={add} />
          <PickButton icon={ImageUp} label="Choose from gallery" hint="Photos or scans, several pages at once" accept="image/*" multiple onChange={add} />
        </div>
      ) : (
        <div className="mt-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {pages.map((p, i) => (
              <div key={p.url} className="relative rounded-xl overflow-hidden border border-border bg-black aspect-[3/4]">
                <img src={p.url} alt={`Page ${i + 1}`} className="w-full h-full object-contain" />
                <span className="absolute top-1.5 left-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-bg-0/80 text-text-0">Page {i + 1}</span>
                {!processing && (
                  <button onClick={() => remove(i)} aria-label={`Remove page ${i + 1}`}
                    className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-bg-0/80 text-text-1 hover:text-danger grid place-items-center">
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
            {pages.length < MAX_PAGES && !processing && (
              <label className="rounded-xl border border-dashed border-border hover:border-accent/50 aspect-[3/4] grid place-items-center cursor-pointer text-center p-3 transition-colors">
                <input type="file" hidden accept="image/*" multiple onChange={add} />
                <span className="text-xs text-text-2"><Plus size={18} className="mx-auto mb-1 text-accent" />Add next page</span>
              </label>
            )}
          </div>

          <AnimatePresence>
            {processing && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="card p-4 mt-4 space-y-2.5">
                {STEPS.map((s, i) => (
                  <div key={s} className={`flex items-center gap-2.5 text-sm ${i <= step ? 'text-text-0' : 'text-text-2'}`}>
                    {i < step ? <Check size={15} className="text-success" />
                      : i === step ? <Loader2 size={15} className="text-accent animate-spin" />
                        : <span className="w-[15px] h-[15px] rounded-full border border-border" />}
                    {s}…
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {error && !processing && (
            <div className="card p-3 mt-4 flex items-start gap-2 border-danger/30">
              <AlertTriangle size={15} className="text-danger flex-shrink-0 mt-0.5" />
              <p className="text-sm text-danger">{error}</p>
            </div>
          )}

          <motion.button whileTap={{ scale: 0.98 }} onClick={() => onAnalyse(pages.map(p => p.file))}
            disabled={processing || !pages.length}
            className="btn-primary w-full mt-4 py-3 text-base flex items-center justify-center gap-2">
            {processing ? <Loader2 size={17} className="animate-spin" /> : <ArrowRight size={17} />}
            {processing ? 'Reading your scoresheet' : `Read ${pages.length > 1 ? `${pages.length} pages` : 'scoresheet'}`}
          </motion.button>
        </div>
      )}

      <div className="card p-4 mt-5 flex items-start gap-3">
        <Lightbulb size={16} className="text-warn flex-shrink-0 mt-0.5" />
        <ul className="text-xs text-text-2 leading-relaxed space-y-1">
          <li>Shoot from straight above, with the whole move table in frame. Both columns matter.</li>
          <li>Good light, no shadow across the moves. Flatten folded sheets.</li>
          <li>Messy handwriting is fine. Every cell is checked against the legal moves, so most slips get fixed.</li>
        </ul>
      </div>
    </div>
  )
}

function PickButton({ icon: Icon, label, hint, accept, capture, multiple, onChange }: {
  icon: typeof Camera; label: string; hint: string; accept: string; capture?: boolean; multiple?: boolean
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="card p-5 flex items-center gap-4 cursor-pointer hover:border-accent/40 hover:bg-bg-2 transition-colors">
      <input type="file" hidden accept={accept} multiple={multiple} onChange={onChange}
        {...(capture ? { capture: 'environment' as const } : {})} />
      <span className="flex-shrink-0 w-11 h-11 rounded-xl bg-accent/15 border border-accent/30 grid place-items-center">
        <Icon size={20} className="text-accent" />
      </span>
      <span>
        <span className="block text-sm font-semibold text-text-0">{label}</span>
        <span className="block text-xs text-text-2 mt-0.5">{hint}</span>
      </span>
    </label>
  )
}
