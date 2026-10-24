/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FORKED_APP_URL?: string
  readonly VITE_FORKED_API_URL?: string
  /** '1' = sign straight into the developer account, '0' = never; default: on in `npm run dev` only */
  readonly VITE_DEV_AUTH_SKIP?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
