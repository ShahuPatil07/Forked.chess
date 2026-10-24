import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server: /api (HTTP + SSE) and /ws (WebSockets) go to the FastAPI backend,
// so the browser always talks to one origin — exactly like the production build.
const target = process.env.VITE_API_TARGET || 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        timeout: 0,          // no timeout — needed for long SSE streams
        proxyTimeout: 0,
      },
      '/ws': {
        target: target.replace(/^http/, 'ws'),
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
