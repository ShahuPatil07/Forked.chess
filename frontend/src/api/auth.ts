/**
 * Accounts (backend/auth.py) + the session-aware fetch.
 *
 * `installAuthFetch()` wraps window.fetch once at startup: every same-origin
 * /api request carries `Authorization: Bearer <token>` when signed in, so the
 * many existing API clients need no changes.
 */
import type { Account, Platform } from '../types'
import { authToken, useUserStore } from '../store/userStore'

export interface AuthResponse { token: string; user: Account }

export interface RegisterInput {
  name: string
  user_id: string
  email: string
  phone?: string
  password: string
  platform: Platform
  chess_username: string
}

/** Readable message from a FastAPI error body (string detail or pydantic list). */
export async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.clone().json()
    const d = body?.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d) && d.length) {
      const first = d[0]
      const field = Array.isArray(first?.loc) ? String(first.loc[first.loc.length - 1]).replace(/_/g, ' ') : ''
      return field ? `${field}: ${first.msg}` : first.msg
    }
  } catch { /* not json */ }
  return (await res.text().catch(() => '')) || `Request failed (${res.status})`
}

async function post<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

export const authApi = {
  config: () => fetch('/api/auth/config').then(r => r.json()) as Promise<{ dev_login: boolean; dev_user: string | null }>,
  register: (input: RegisterInput) => post<AuthResponse>('/api/auth/register', input),
  login: (identifier: string, password: string) => post<AuthResponse>('/api/auth/login', { identifier, password }),
  devLogin: () => post<AuthResponse>('/api/auth/dev-login'),
  me: () => fetch('/api/auth/me').then(async r => { if (!r.ok) throw new Error(await errorMessage(r)); return r.json() as Promise<{ user: Account }> }),
  update: (patch: Partial<Pick<Account, 'name' | 'email' | 'phone' | 'platform' | 'chess_username'>>) =>
    post<{ user: Account }>('/api/auth/me', patch, 'PATCH'),
  changePassword: (current_password: string, new_password: string) =>
    post<{ ok: boolean }>('/api/auth/change-password', { current_password, new_password }),
  logout: () => post<{ ok: boolean }>('/api/auth/logout').catch(() => ({ ok: false })),
}

let installed = false

export function installAuthFetch(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const native = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const token = authToken()
    const sameOrigin = url.startsWith('/api') || url.startsWith(`${window.location.origin}/api`)
    if (!token || !sameOrigin) return native(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
    return native(input, { ...init, headers }).then(res => {
      // an expired / revoked session: sign out locally so the app returns to the start page
      if (res.status === 401 && url.includes('/api/auth/me')) useUserStore.getState().clearUser()
      return res
    })
  }
}
