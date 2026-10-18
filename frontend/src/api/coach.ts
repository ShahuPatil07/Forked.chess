/**
 * Forked Coach API client — REST (questionnaire/profile/memory) + SSE chat.
 *
 * The chat stream emits: meta → (tool, tool_result)* → token* → done | error.
 * Tool results carrying board data (puzzle / mistake positions / analysis /
 * explanation) are surfaced so the chat can render inline boards.
 */

export type CoachMode = 'coach' | 'puzzle' | 'import' | 'theory' | 'audio' | 'position' | 'agent'

export interface CoachQuestionnaire {
  rating_bucket: string
  play_style: string
  goal: string
  study_time: string
  struggle: string
  explanation_style?: string
}

export interface CoachProfileResponse {
  username: string
  questionnaire_complete: boolean
  profile: (CoachQuestionnaire & { username: string }) | null
  memory: {
    session_count: number
    summary: string
    communication_style: string
    preferred_depth: string
  }
}

// ── Tool payloads (mirror backend/coach/tools.py) ──────────────────────────────

export interface PuzzlePayload {
  found: boolean
  puzzle_id?: string
  fen?: string
  side_to_move?: 'white' | 'black'
  solution_uci?: string
  full_line_uci?: string[]
  rating?: number
  themes?: string
  game_url?: string
  message?: string
}

export interface MistakePosition {
  fen: string
  move_played: string
  best_move: string
  eval_drop_cp: number
  threat_type: string
  game_phase: string
  move_number: number
}

export interface MistakePositionsPayload {
  cluster_id: string
  count: number
  positions: MistakePosition[]
}

export interface AnalyzePayload {
  ok: boolean
  kind?: 'fen' | 'pgn'
  fen?: string
  explanation?: ExplainPayload
  plies_analysed?: number
  mistakes_found?: number
  top_mistakes?: {
    move_number: number
    side: string
    move_played: string
    best_move_uci: string
    eval_drop_cp: number
    fen_before: string
  }[]
  message?: string
}

export interface ExplainPayload {
  explanation: string
  best_move_san: string | null
  eval: string | null
  source: 'c1' | 'stockfish' | 'error'
  fen?: string
  side_to_move?: 'white' | 'black'
  question?: string
  status?: 'complete' | 'partial' | 'terminal' | 'error'
  terminal?: string | null
  narration_source?: 'groq' | 'c1' | 'template'
  narration_warnings?: string[]
  candidates?: InvestigationCandidate[]
  claims?: InvestigationClaim[]
  warnings?: string[]
  engine?: { name?: string; scan_depth?: number; deep_depth?: number }
  budget?: { requested_seconds: number; elapsed_seconds: number; exhausted: boolean; engine_calls: unknown[] }
}

export interface InvestigationScore {
  white_cp: number | null
  white_mate: number | null
  mover_cp: number | null
  mover_mate: number | null
}

export interface InvestigationLine {
  uci: string[]
  san: string[]
  fens: string[]
  material_change: number
  captures: string[]
  ends_in_mate: boolean
  terminal?: string | null
}

export interface InvestigationCandidate {
  id: string
  move_uci: string
  move_san: string
  roles: string[]
  score: InvestigationScore
  depth: number
  refined: boolean
  legal_replies: string[]
  line: InvestigationLine
  replies: { move_uci: string; move_san: string; score: InvestigationScore; depth: number; line: InvestigationLine }[]
}

export interface InvestigationClaim {
  id: string
  candidate_id: string
  hypothesis: string
  status: 'verified' | 'likely' | 'uncertain' | 'rejected'
  test: string
  supporting_evidence: string[]
  contradicting_evidence: string[]
  scope: string
}

export type ToolPayload =
  | PuzzlePayload | MistakePositionsPayload | AnalyzePayload | ExplainPayload

// ── Agent (board-aware coach) payloads ────────────────────────────────────────

export interface AgentLine {
  label: string
  start_fen: string
  san: string[]
  uci: string[]
  fens: string[]
}

export interface AgentBoardEvent {
  type: 'board'
  fen: string
  label: string
  line: { san: string[]; uci: string[]; fens: string[] }
  game?: { pgn: string; headers: Record<string, string> }
}

export type PlayStrength = 'beginner' | 'intermediate' | 'advanced' | 'strong' | 'engine'

export interface GameMoment { ply: number; type: string; move: string }

/** Game Review hand-off: the move being explained. */
export interface ReviewContext {
  move: string
  classification?: string
  best?: string
  move_number?: number
  color?: string
}

// ── Stream events ──────────────────────────────────────────────────────────────

export type CoachStreamEvent =
  | { type: 'meta'; mode: CoachMode; narration_source?: 'groq' | 'c1' | 'template'; narration_warnings?: string[] }
  | { type: 'tool'; name: string; status: string; label?: string }
  | { type: 'tool_done'; name: string; label: string; summary: string }
  | { type: 'tool_result'; name: string; payload: ToolPayload }
  | AgentBoardEvent
  | { type: 'lines'; lines: AgentLine[] }
  | { type: 'puzzle'; payload: PuzzlePayload }
  | { type: 'play'; fen: string; user_color: 'white' | 'black'; strength: PlayStrength }
  | { type: 'moments'; moments: GameMoment[] }
  | { type: 'token'; text: string }
  | { type: 'done'; notes?: string; fen?: string; provider?: string }
  | { type: 'error'; message: string }

export interface CoachChatMessage { role: 'user' | 'assistant'; content: string; notes?: string; fen?: string }

export const coachApi = {
  getProfile: async (username: string): Promise<CoachProfileResponse> => {
    const res = await fetch(`/api/coach/profile/${encodeURIComponent(username)}`)
    if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
    return res.json()
  },

  saveQuestionnaire: async (username: string, q: CoachQuestionnaire) => {
    const res = await fetch('/api/coach/save-questionnaire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, ...q }),
    })
    if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
    return res.json()
  },

  updateMemory: async (username: string, messages: CoachChatMessage[]) => {
    try {
      await fetch(`/api/coach/update-memory/${encodeURIComponent(username)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      })
    } catch { /* best-effort — memory update never blocks the UI */ }
  },

  engineMove: async (fen: string, strength: PlayStrength): Promise<{ move_uci: string; move_san: string; eval: string; best_san: string }> => {
    const res = await fetch('/api/coach/engine-move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen, strength }),
    })
    if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
    return res.json()
  },

  chatStream: async (
    body: {
      username: string
      message: string
      mode: CoachMode
      conversation_history: CoachChatMessage[]
      position_fen?: string
      focus_move?: string
      alternative_move?: string
      budget_seconds?: number
      use_llm?: boolean
      board_moves?: string[]
      game_pgn?: string
      level?: string
      style?: string
      review?: ReviewContext
    },
    onEvent: (evt: CoachStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    const res = await fetch('/api/coach/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(await res.text().catch(() => res.statusText) || `HTTP ${res.status}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload) continue
        let evt: CoachStreamEvent
        try { evt = JSON.parse(payload) as CoachStreamEvent }
        catch { continue }
        // A callback error (including a provider error event) must propagate.
        onEvent(evt)
        if (evt.type === 'done' || evt.type === 'error') return
      }
    }
  },
}
