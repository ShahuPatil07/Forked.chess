/**
 * Forked Coach API client — REST (questionnaire/profile/memory) + SSE chat.
 *
 * The chat stream emits: meta → (tool, tool_result)* → token* → done | error.
 * Tool results carrying board data (puzzle / mistake positions / analysis /
 * explanation) are surfaced so the chat can render inline boards.
 */

export type CoachMode = 'coach' | 'puzzle' | 'import' | 'theory' | 'audio'

export interface CoachQuestionnaire {
  rating_bucket: string
  play_style: string
  goal: string
  study_time: string
  struggle: string
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
}

export type ToolPayload =
  | PuzzlePayload | MistakePositionsPayload | AnalyzePayload | ExplainPayload

// ── Stream events ──────────────────────────────────────────────────────────────

export type CoachStreamEvent =
  | { type: 'meta'; mode: CoachMode }
  | { type: 'tool'; name: string; status: string }
  | { type: 'tool_result'; name: string; payload: ToolPayload }
  | { type: 'token'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface CoachChatMessage { role: 'user' | 'assistant'; content: string }

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

  chatStream: async (
    body: {
      username: string
      message: string
      mode: CoachMode
      conversation_history: CoachChatMessage[]
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
        try {
          const evt = JSON.parse(payload) as CoachStreamEvent
          onEvent(evt)
          if (evt.type === 'done' || evt.type === 'error') return
        } catch { /* ignore malformed lines */ }
      }
    }
  },
}
