/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FORKED_APP_URL?: string
  readonly VITE_FORKED_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
