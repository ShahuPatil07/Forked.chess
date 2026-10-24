/**
 * WebSocket URL for a backend path. Always the page's own origin: in dev the
 * Vite server proxies /ws to the API (vite.config.ts), in production the API
 * serves the app itself — so this works on any host or port, behind HTTPS too.
 */
export function wsUrl(path: string): string {
  const { protocol, host } = window.location
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${path}`
}
