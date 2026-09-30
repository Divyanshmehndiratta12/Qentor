# Build State

What is built and verified right now, what is not, and how to run it. Numbers below were measured at the last full
verification (see "Verification" for the commands). If this file and the code disagree, the code wins: fix this file.

## What exists

| Area | State |
|---|---|
| Canonical circuit model, OpenQASM 3 emitter, SHA-256 hash | Built. Gates: h x y z s sdg t tdg rx ry rz cx cz swap ccx measure. Golden fixtures in `fixtures/circuits/` are shared by backend and web tests. |
| Execution | Qiskit Aer, Cirq, PennyLane; statevector and shots; per-step trace; single-qubit Bloch vectors; size/gate limits; state sanity check before a result is stored |
| Verification | Equivalence (operator, up to global phase), cross-backend agreement (threshold 1e-6), Bell-state verifier, multi-input basis sweep, optimiser (each proposal equivalence-checked), experiment comparison |
| Challenges | Nine backend-owned challenges, deterministic server verdicts, authored hints and coaching, attempt log. DJ and BV use one fixed oracle each. |
| Tutor and debugger | Result-, lesson-, trace-step-, comparison-grounded answers; "Debug my circuit"; one claim guard; LLM off unless configured |
| Learn | 10 lessons with concept checks; progress, mastery and misconception signals; browser-local persistence (versioned, recoverable) |
| Frontend | Lab, Learn, Challenges, Progress; URL routing with deep links; sampled vs theoretical labelling; Compare experiments; Share and export; welcome entry; keyboard/ARIA/focus work from the shell pass |
| Serving | One FastAPI process serves `/api/*` and `web/dist` with SPA fallback; `GET /api/health` |
| Packaging | `Dockerfile`, `.dockerignore`, `render.yaml`, `backend/scripts/serve_production.sh` |

## What is NOT built

- **Hardware.** No recorded or live hardware adapter, no `record_hardware.py` run, no `server/data/hardware_runs/`. The UI shows Recorded and Live QPU as unavailable. Nothing in this build is, or is labelled as, a hardware result.
- The Aer noise model, qBraid, stabilizer simulation, Grover/QFT lessons, retrieval over docs.
- The 72-oracle Deutsch-Jozsa family sweep (`CLAUDE.md` lists "DJ family size is exactly 72" as a required test; it does not exist). The two oracle challenges use one fixed oracle each.
- Accounts and any server-side learner data. Progress is browser-local; the learner report is one learner's record, with no cohort data.
- A public deployment. The production process was verified locally; the Docker image has not been built (no Docker on the build machine) and nothing has been hosted.

## Verification (last full run)

| Check | Result |
|---|---|
| Backend `unittest` | 1003 tests, all passed |
| Frontend `vitest` | 1422 tests in 63 files, all passed |
| `tsc -b` | clean |
| `npm run build` | succeeds (one chunk over 500 kB; Plotly and Three.js) |
| Mutation check (`backend/scripts/mutation_check.py`) | 29 backend and 24 frontend trust-breaking mutants, all killed |
| Real Chrome journey against the production build (FastAPI serving `web/dist`, no Vite) | 45 checks, all passed: direct `/learn`, `/progress`, `/challenges/<id>`; Learn -> concept check -> Open in Lab -> run -> trace -> select step -> tutor; Hindi answer; Aer vs Cirq comparison and tutor about it; Debug my circuit; share link round trip; a wrong then a right challenge; the fixed Deutsch-Jozsa example built through the UI and solved by the backend; Progress and reload persistence; phone-width layout of four screens; no console errors, no failed API responses |

The browser journey is a throwaway CDP script (Windows Chrome, headless), not committed. Web fonts are requested from Google Fonts;
that is the only third-party request the journey observed.

## Known limitations

- The browser journey ran on one machine and one Chrome version; Firefox and Safari were not tried.
- The debugger's template text is English only. Tutor answer wrappers support English, Hindi and Kannada.
- Starting a challenge replaces the Lab's circuit with its starter (they share one workspace); the screen says so.
- Sampled frequencies from shots are compared with theoretical probabilities only with a label; no significance test is offered.
- The provenance database is one SQLite file with no retention policy; a hosted deployment should mount a volume (`QENTOR_DB_PATH`).

## Environment

Development is inside WSL2 (Ubuntu) with a dedicated Python 3.12 venv, because Windows Smart App Control blocked
qiskit's unsigned native extension on the original host (a reputation policy, not a dependency problem; turning Smart App
Control off is irreversible, so it was not touched). Node 22 via nvm in WSL.

## Commands (from the repo root, inside WSL)

```
py -3.12 -m venv backend/.venv                       # once; on Linux: python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python backend/scripts/check_versions.py

backend/.venv/bin/python -m unittest discover -s backend/tests -t backend        # backend tests
(cd web && npm ci && npx vitest run && npx tsc -b && npm run build)             # frontend tests, typecheck, build
backend/.venv/bin/python backend/scripts/mutation_check.py                       # trust mutation check (backend + web)

backend/scripts/serve_production.sh 8000           # build web, serve it and the API from one process
```

A single backend test module needs `-p test_x.py`, not a dotted name.
