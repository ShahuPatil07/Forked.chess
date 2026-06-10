/**
 * Build a WebSocket URL that works in both dev and the single-origin prod build.
 *
 * Dev: the Vite dev server (5173) and the API (8000) are separate origins, so we
 * talk to the backend directly on :8000.
 * Prod: the app is served from the same origin as the API, so derive host +
 * protocol from the page (wss:// under HTTPS).
 */
export function wsUrl(path: string): string {
  const { protocol, hostname, host, port } = window.location
  if (port === '5173') return `ws://${hostname}:8000${path}`   // Vite dev
  const proto = protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${host}${path}`
}
