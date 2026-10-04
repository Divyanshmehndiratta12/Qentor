# Qentor web app

The React + TypeScript + Vite frontend. It renders results that the backend computes and computes no quantum value itself; see the repository [README](../README.md) and [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §3.

Run from this directory (Node 22):

```bash
npm ci
npm run dev        # Vite dev server; proxies /api to http://127.0.0.1:8000 (start the backend first)
npm run build      # tsc -b && vite build, output in dist/ (served by the backend in production)
npm test           # vitest run (use --maxWorkers=4 on a small machine)
npm run lint       # oxlint
```

`.env.example` documents the one frontend variable (`VITE_USE_MOCK_API`, never for a production build).
