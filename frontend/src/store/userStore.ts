import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { UserState } from '../types'

interface UserStore extends UserState {
  setUser: (u: Partial<UserState>) => void
  clearUser: () => void
}

const defaults: UserState = {
  username: '',
  platform: 'lichess',
  elo: 1500,
  activeJobId: null,
}

export const useUserStore = create<UserStore>()(
  persist(
    (set) => ({
      ...defaults,
      setUser: (u) => set((s) => ({ ...s, ...u })),
      clearUser: () => set(defaults),
    }),
    { name: 'forked-user' }
  )
)
