/**
 * Developer auth skip.
 *
 * In `npm run dev` the sign-in screen is skipped: opening any app page without a
 * session signs straight into the developer account (backend `POST
 * /api/auth/dev-login`, i.e. ShahuPatil27). Production builds never do this
 * unless built with VITE_DEV_AUTH_SKIP=1. VITE_DEV_AUTH_SKIP=0 turns it off in dev.
 *
 * The backend stays the gatekeeper: with FORKED_DEV_LOGIN=0 the dev-login call is
 * refused and the app falls back to the normal sign-in page.
 *
 * Signing out explicitly pauses the skip for the rest of that browser tab, so the
 * sign-in and registration screens can still be tested.
 */
const PAUSE_KEY = 'forked-dev-skip-paused'

const flag = import.meta.env.VITE_DEV_AUTH_SKIP
export const DEV_AUTH_SKIP: boolean = flag === '1' ? true : flag === '0' ? false : import.meta.env.DEV

export function devSkipActive(): boolean {
  if (!DEV_AUTH_SKIP) return false
  try {
    return sessionStorage.getItem(PAUSE_KEY) !== '1'
  } catch {
    return true
  }
}

/** Call on an explicit sign-out. */
export function pauseDevSkip(): void {
  try { sessionStorage.setItem(PAUSE_KEY, '1') } catch { /* private mode: the skip just stays on */ }
}

/** Call when the developer signs in on purpose (the /dev link). */
export function resumeDevSkip(): void {
  try { sessionStorage.removeItem(PAUSE_KEY) } catch { /* ignore */ }
}
