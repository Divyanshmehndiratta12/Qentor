# Qentor — Engineering Rules

Qentor is an SIH 2026 entry for problem statement SIH26140: an AI-based interactive quantum
algorithm learning platform. Read `docs/PRODUCT_CONTRACT.md` before changing scope.

## The invariant (non-negotiable)

**The LLM is not the quantum computer.**

- Statevectors, amplitudes, probabilities, counts, expectation values, fidelities, equivalence verdicts, pass/fail, counterexamples, hardware results and optimisation results come only from `backend/qentor/execution/` or `backend/qentor/verification/`.
- Every displayed quantum number carries provenance: result id, circuit hash, backend and version, execution mode, provenance class (SIMULATION, REAL_HARDWARE, RECORDED_HARDWARE), verification status.
- The tutor receives result ids and reads facts from the provenance log. It never receives numbers from the client and never writes results.
- AI candidate circuits, code and optimisations are shown as VERIFIED only after the verification layer passes them.
- Details: `docs/VERIFICATION_ARCHITECTURE.md`, `docs/AI_BOUNDARY.md`.

## Never do these

- Never hard-code, mock or approximate a quantum result in shipped code. Test fixtures stay in tests.
- Never fabricate, simulate or "fill in" hardware results. Only `backend/scripts/record_hardware.py` (not built yet), run with a real IBM token, may write to `backend/data/hardware_runs/`. A noise-model simulation is labelled SIMULATION.
- Never label a simulation as hardware, or a recorded run as live.
- Never execute learner- or AI-supplied Python. Code enters only as OpenQASM 3 parsed into the canonical model.
- Never copy code from third-party research checkouts kept under `research/` (local only, git-ignored). They are read-only research. Do not import from them or paste from them.
- Never put API keys or IBM tokens in the frontend, in git, or in logs. Use a git-ignored `.env`.
- Never reproduce the deck's illustrative numbers ("71 of 72", the concept-mockup table) as if they were results.

## Architecture in one breath

One FastAPI process serves the React build and the API. Python 3.12. SQLite for the provenance
log and progress. Recorded hardware runs (not built yet) are read-only JSON with a SHA-256 manifest. No
microservices, Redis, queues, PostgreSQL, WebSockets or accounts. See `docs/ARCHITECTURE.md`.

- Dependency direction: `api → tutor → verification → execution → circuit`. Execution and verification never import tutor.
- The canonical circuit model (`qentor.circuit/1`) is the single source of truth. OpenQASM 3 is its canonical text and the circuit hash is SHA-256 of that text.
- The server emitter is authoritative. The web emitter must match it on `fixtures/circuits/`.
- Adapters build native circuits from the canonical model, not from generated source code.
- All verification runs on Qiskit Aer with exact statevectors. Tolerance 1e-9. Cross-backend agreement threshold 1e-6.
- Displayed bitstrings are `q[n-1] … q[0]`. State this beside every chart.
- Frontend numbers render only through `VerifiedValue` with a provenance object.

## Priorities

Work in P0 order from `docs/48_HOUR_PLAN.md`. Do not start P1 until the P0 hero path
(`docs/PRODUCT_CONTRACT.md` §7) runs cleanly. Requirements not traceable to
`docs/source/PPT_SOURCES.md` are labelled "not in PPT" and never displace P0 work.

## Definition of done for any feature

- Numbers it shows carry provenance.
- It has tests, including a failure case.
- It degrades honestly: an unavailable backend says "unavailable", it never substitutes data.
- The relevant doc in `docs/` still matches the code.

## Required tests

- Golden model ↔ QASM fixtures on server and web.
- Cross-backend agreement on fixture circuits.
- Every challenge reference solution passes its own test spec.
- DJ family size is exactly 72 for n=3.
- Equivalence checker: equal, global-phase, relative-phase-only and unequal pairs.
- Adversarial tutor tests with a fake LLM that invents numbers, verdicts and wrong circuits.
- Import-graph test: tutor cannot reach the provenance writer.

## Commands

Development happens inside WSL2 (Ubuntu) with a dedicated Python 3.12 venv, never the system interpreter — see
`docs/BUILD_STATE.md`. Run from the repo root:

```
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python backend/scripts/check_versions.py

backend/.venv/bin/python -m unittest discover -s backend/tests -t backend          # backend (one module: -p test_x.py)
(cd web && npm ci && npx vitest run && npx tsc -b && npm run build)               # frontend tests, typecheck, build
backend/.venv/bin/python backend/scripts/mutation_check.py [backend|web]           # trust mutation check
backend/scripts/serve_production.sh 8000                                           # web build + API from one process
```

Challenge verdicts, debugger reports and experiment comparisons are computed on the server (`backend/qentor/challenges/`,
`tutor/debugger.py`, `verification/experiment_compare.py`); the frontend only sends ids and circuits and renders what returns.
Test counts and what is not built live in `docs/BUILD_STATE.md`, not here.

## Document index

- `docs/PRODUCT_CONTRACT.md` — what we promised and the hero demo path
- `docs/PPT_REQUIREMENTS_MATRIX.md` — every PPT promise with priority
- `docs/ARCHITECTURE.md` — modules, model, adapters, storage, deployment, API surface
- `docs/VERIFICATION_ARCHITECTURE.md` — how results are trusted
- `docs/AI_BOUNDARY.md` — what the AI may and may not do
- `docs/REASONING_ENGINE.md` — the server-side analysis layer (probability, optimise, what-if, trace change) and its trust rules
- `docs/VARIATIONAL.md` — lesson 17, the one-parameter VQE-style demonstration, where its numbers come from and what it is not
- `docs/48_HOUR_PLAN.md` — milestones and cut conditions
- `docs/BUILD_STATE.md` — what is actually built and verified right now, and current blockers
- `docs/source/PPT_SOURCES.md` — extracted text of the submitted deck and drafts
