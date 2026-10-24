import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Account, UserState } from '../types'

interface UserStore extends UserState {
  setUser: (u: Partial<UserState>) => void
  /** Sign in: keep the session token and point every per-user feature at the linked chess account. */
  signIn: (token: string, account: Account) => void
  clearUser: () => void
}

const defaults: UserState = {
  username: '',
  platform: 'lichess',
  elo: 1500,
  activeJobId: null,
  token: null,
  account: null,
}

export const useUserStore = create<UserStore>()(
  persist(
    (set) => ({
      ...defaults,
      setUser: (u) => set((s) => ({ ...s, ...u })),
      signIn: (token, account) => set((s) => ({
        ...s, token, account,
        // data files are keyed by the chess username — unchanged from before accounts existed
        username: account.chess_username,
        platform: account.platform,
      })),
      clearUser: () => set(defaults),
    }),
    {
      name: 'forked-user', version: 2,
      // pre-account sessions keep their chess username but must sign in once
      migrate: (persisted) => ({ ...defaults, ...(persisted as Partial<UserState>), token: null, account: null }),
    }
  )
)

/** Read the session token outside React (fetch wrapper, SSE helpers). */
export const authToken = () => useUserStore.getState().token
