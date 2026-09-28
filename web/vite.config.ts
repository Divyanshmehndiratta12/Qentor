import { fileURLToPath, URL } from 'node:url'
// `defineConfig` from 'vitest/config' re-exports Vite's own defineConfig with
// the `test` option merged in — `vite build`/`vite dev` ignore that option
// entirely, so this is a drop-in replacement, not a behaviour change.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // The FastAPI backend serves the API under /api. In dev, Vite proxies
      // to it directly so the browser never needs a hardcoded absolute URL.
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
