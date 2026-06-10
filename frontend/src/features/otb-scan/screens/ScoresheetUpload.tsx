import { type ChangeEvent, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Camera, ImageUp, ChevronLeft, Loader2, RotateCcw, ArrowRight, AlertTriangle, Lightbulb } from 'lucide-react'

interface Props {
  onAnalyse: (file: File) => void
  onBack: () => void
  processing: boolean
  error: string | null
  onLoadSample?: () => void
}

export function ScoresheetUpload({ onAnalyse, onBack, processing, error, onLoadSample }: Props) {
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  // Revoke the object URL when it changes / unmounts.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  const handleCapture = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImage(file)
    setPreview(URL.createObjectURL(file))
    e.target.value = '' // allow re-selecting the same file
  }

  const retake = () => {
    setImage(null)
    setPreview(null)
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-6">
      <button onClick={onBack} className="btn-ghost flex items-center gap-1 mb-3">
        <ChevronLeft size={15} /> Back
      </button>

      <h1 className="text-lg font-bold text-text-0 mb-1">Upload scoresheet</h1>
      <p className="text-xs text-text-2 mb-4">
        A clear photo of your handwritten or printed moves.
      </p>

      {!preview ? (
        <div className="space-y-3">
          <UploadButton
            icon={Camera}
            label="Take photo"
            hint="Use your camera in photo mode"
            inputProps={{ accept: 'image/*', capture: 'environment' }}
            onChange={handleCapture}
          />
          <UploadButton
            icon={ImageUp}
            label="Upload from gallery"
            hint="Pick an existing photo or scan"
            inputProps={{ accept: 'image/*' }}
            onChange={handleCapture}
          />

          <div className="card p-3 flex items-start gap-2.5 mt-2">
            <Lightbulb size={15} className="text-warn flex-shrink-0 mt-0.5" />
            <p className="text-xs text-text-2 leading-relaxed">
              Make sure all moves are visible and the image is well-lit. Flatten the sheet and
              avoid shadows for the best read.
            </p>
          </div>

          {onLoadSample && (
            <button onClick={onLoadSample} className="btn-ghost w-full mt-1 text-xs border border-border border-dashed">
              Load sample review (dev — no backend needed)
            </button>
          )}
        </div>
      ) : (
        <div>
          <div className="relative rounded-lg overflow-hidden border border-border mb-3">
            <img src={preview} alt="Scoresheet preview" className="w-full max-h-[50vh] object-contain bg-black" />
            {processing && (
              <div className="absolute inset-0 bg-bg-0/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
                <Loader2 size={28} className="text-accent animate-spin" />
                <p className="text-sm text-text-0">Reading your scoresheet…</p>
                <p className="text-xs text-text-2">this takes about 5 seconds</p>
              </div>
            )}
          </div>

          {error && (
            <div className="card p-3 mb-3 flex items-center gap-2 border-danger/30">
              <AlertTriangle size={15} className="text-danger flex-shrink-0" />
              <p className="text-xs text-danger">{error}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={retake}
              disabled={processing}
              className="btn-ghost flex items-center justify-center gap-1.5 border border-border"
            >
              <RotateCcw size={14} /> Retake
            </button>
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => image && onAnalyse(image)}
              disabled={processing || !image}
              className="btn-primary flex items-center justify-center gap-1.5"
            >
              {processing ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
              Analyse scoresheet
            </motion.button>
          </div>
        </div>
      )}
    </div>
  )
}

function UploadButton({
  icon: Icon,
  label,
  hint,
  inputProps,
  onChange,
}: {
  icon: typeof Camera
  label: string
  hint: string
  inputProps: { accept: string; capture?: 'environment' | 'user' }
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
}) {
  return (
    <label className="card w-full p-4 flex items-center gap-4 cursor-pointer hover:border-border-hover hover:bg-bg-2 transition-colors">
      <input type="file" hidden onChange={onChange} {...inputProps} />
      <span className="flex-shrink-0 w-11 h-11 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center">
        <Icon size={20} className="text-accent" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-text-0">{label}</span>
        <span className="block text-xs text-text-2 mt-0.5">{hint}</span>
      </span>
    </label>
  )
}
