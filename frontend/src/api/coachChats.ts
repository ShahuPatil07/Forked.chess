/** Saved Coach conversations (backend/coach_chats.py). */
import { errorMessage } from './auth'
import type { BoardTab } from '../components/coach/CoachWorkspaceBoard'

export interface ChatSummary { id: string; title: string; created_at: number; updated_at: number; messages: number; preview: string }
export interface ChatDoc {
  id: string
  title: string
  messages: Record<string, unknown>[]
  board: { tabs: BoardTab[]; activeId: string } | null
  created_at: number
  updated_at: number
}

const enc = encodeURIComponent
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export const newChatId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export const coachChatsApi = {
  list: (username: string) => fetch(`/api/coach-chats/${enc(username)}`).then(r => json<{ chats: ChatSummary[] }>(r)),
  get: (username: string, id: string) => fetch(`/api/coach-chats/${enc(username)}/${enc(id)}`).then(r => json<ChatDoc>(r)),
  save: (username: string, id: string, body: { messages: unknown[]; board: ChatDoc['board']; title?: string }) =>
    fetch(`/api/coach-chats/${enc(username)}/${enc(id)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(r => json<{ ok: boolean; title: string }>(r)),
  rename: (username: string, id: string, title: string) =>
    fetch(`/api/coach-chats/${enc(username)}/${enc(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    }).then(r => json<{ ok: boolean }>(r)),
  remove: (username: string, id: string) =>
    fetch(`/api/coach-chats/${enc(username)}/${enc(id)}`, { method: 'DELETE' }).then(r => json<{ ok: boolean }>(r)),
}
