/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Explicit opt-in to the FIXTURE-labelled mock API adapter. See src/api/index.ts. */
  readonly VITE_USE_MOCK_API?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
