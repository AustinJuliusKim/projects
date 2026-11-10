/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the leads API (no trailing slash needed). Empty = no request is sent. */
  readonly VITE_LEADS_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
