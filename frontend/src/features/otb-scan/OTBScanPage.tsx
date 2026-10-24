import { useState } from 'react'
import { useOCR } from './hooks/useOCR'
import { Home } from './screens/Home'
import { ScoresheetUpload } from './screens/ScoresheetUpload'
import { MoveReview } from './screens/MoveReview'
import { ScanHistory } from './screens/ScanHistory'

type Mode = 'choose' | 'scoresheet' | 'history'

/**
 * OTB Scan: digitise an over-the-board game from its paper scoresheet.
 *
 *   upload photo(s) -> read every cell (vision model) -> decode the legal game
 *   (backend/scoresheet_decoder.py) -> review flagged moves -> Game Review / Analysis Board.
 *
 * Live camera tracking and video upload are shown as "beta / coming soon" on the
 * home screen. Their screens and CV pipeline (screens/Setup, Calibration, LiveGame,
 * hooks/useGameTracker, cv/) stay in this folder for when they ship, but aren't
 * mounted, so this page no longer loads the TFJS board/piece models.
 */
export default function OTBScanPage() {
  const ocr = useOCR()
  const [mode, setMode] = useState<Mode>('choose')

  const goHome = () => { ocr.reset(); setMode('choose') }

  return (
    <div className="px-2 py-4 sm:px-6">
      {mode === 'choose' && <Home onPickScoresheet={() => setMode('scoresheet')} onHistory={() => setMode('history')} />}
      {mode === 'history' && <ScanHistory onBack={() => setMode('choose')} />}

      {mode === 'scoresheet' && (
        ocr.state === 'review' && ocr.result ? (
          <MoveReview result={ocr.result} pages={ocr.pages} onPin={ocr.pin} onBack={ocr.reset} onHistory={() => { ocr.reset(); setMode('history') }} />
        ) : (
          <ScoresheetUpload onAnalyse={files => void ocr.analyseScoresheet(files)} onBack={goHome}
            processing={ocr.state === 'processing'} error={ocr.error} />
        )
      )}
    </div>
  )
}
