/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'local' selects the in-browser SQLite worker; anything else means Flask. */
  readonly VITE_BACKEND?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
