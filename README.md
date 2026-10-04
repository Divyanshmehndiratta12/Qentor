# Qentor

An interactive platform for learning quantum algorithms by building circuits, running them on real simulators and having every result checked on the server. Smart India Hackathon 2026, problem statement SIH26140.

## What Qentor does

Qentor closes the loop between reading about a quantum algorithm and seeing it behave:

**Learn → Build → Simulate → Visualize → Ask → Assess**

1. **Learn** from guided lessons with concept checks.
2. **Build** the circuit on a canvas or in OpenQASM 3.
3. **Simulate** it on a chosen backend, as exact statevectors or sampled shots.
4. **Visualize** the result: probabilities, a gate-by-gate trace, per-qubit 3D Bloch spheres, amplitude and phase.
5. **Ask** the tutor (Qubi) about the result, a trace step or a failed attempt.
6. **Assess** with challenges whose verdicts, hints and counterexamples come from the server.

## The one rule

**The language model is not the quantum computer.** Every statevector, probability, count, fidelity, equivalence verdict and pass/fail is computed by the Python backend (`backend/qentor/execution/` and `backend/qentor/verification/`) and carries provenance: result id, circuit hash, backend and version, execution mode and provenance class. The browser draws what the server returns and computes no quantum value. The tutor reads recorded facts by result id and never writes results. Details: [`docs/VERIFICATION_ARCHITECTURE.md`](docs/VERIFICATION_ARCHITECTURE.md), [`docs/AI_BOUNDARY.md`](docs/AI_BOUNDARY.md).

## Key capabilities

Everything below is built; what is not built is listed in [`docs/BUILD_STATE.md`](docs/BUILD_STATE.md) ("What is NOT built").

**Deterministic, backend-computed (no AI involved)**

- **Lessons:** 18 interactive lessons, from qubits and measurement through Bell states, phase kickback, Deutsch-Jozsa, Bernstein-Vazirani, Grover, teleportation, superdense coding, QFT, phase estimation, error correction, a one-parameter variational (VQE-style) demonstration and an order-finding intuition for Shor's algorithm. Each algorithm lesson is one small, fixed educational example, and says so. 36 concept checks are graded by the server.
- **Circuit editor:** drag-and-drop or keyboard editing with undo/redo, synchronised with an OpenQASM 3 editor.
- **Simulator backends:** Qiskit Aer, Cirq and PennyLane, in statevector or shots mode, with cross-backend agreement checks.
- **Visualization:** probability charts (sampled vs theoretical, labelled), a per-operation trace, an interactive 3D Bloch sphere for every qubit (drawn from states the server derives), and an amplitude/phase view. See [`docs/VISUALIZATION.md`](docs/VISUALIZATION.md).
- **Verification:** circuit equivalence (up to global phase), multi-input testing with counterexamples, an optimiser whose every proposal is equivalence-checked, and a 72-oracle Deutsch-Jozsa family check.
- **Challenges:** 19 server-judged challenges with authored hints, and a "Debug my circuit" report built from backend runs.
- **Reasoning flows:** server-side probability questions, optimisation, what-if (the counterfactual circuit is shown before anything runs), trace-change and comparison. See [`docs/REASONING_ENGINE.md`](docs/REASONING_ENGINE.md).
- **Code views and import:** read-only Qiskit, Cirq and PennyLane views of the circuit; paste OpenQASM 3, Qiskit, Cirq or PennyLane code to import it. Python is parsed against an allow-list and **never executed**.
- **Sharing and progress:** read-only shared experiment pages and "Fork into my Lab"; browser-local progress; anonymous classrooms (a class code, an instructor dashboard) with no accounts.

**Optional AI (off unless configured)**

- **Qubi, the AI tutor:** its answers are grounded in facts from the provenance log and pass a claim guard. With no language model configured it answers from deterministic templates ("Explanation generated without AI"), in English, Hindi and Kannada. The LLM layer is disabled by default (`QENTOR_TUTOR_LLM_ENABLED`), has an Anthropic adapter, and **the real provider has not been called in this build** because no key was available; the path is tested with stand-ins.
- **AI code generation:** a model may *propose* OpenQASM 3, which the server parses, limits and labels "not yet verified". With no model configured it says it is unavailable and generates nothing.

**Not claimed**

- **No real quantum hardware.** No hardware adapter is built; the UI shows recorded and live hardware as unavailable. Every result is a simulation and is labelled `SIMULATION`.
- No noisy simulation, no real-time co-editing, no accounts.
- No public deployment has been made.

## Architecture

One FastAPI process serves the JSON API and the built React app. There is no other service: no queue, cache or external database (SQLite holds the provenance log, sharing and classroom data).

```
Browser (React + TypeScript + Vite)  ──  canonical circuit JSON  ──▶  FastAPI
                                                                       api → tutor → verification → execution → circuit
                                     ◀──  results with provenance  ──   (SQLite provenance log)
```

- The **canonical circuit model** (`qentor.circuit/1`) is the single source of truth; OpenQASM 3 is its canonical text and the circuit hash is the SHA-256 of that text.
- The **backend is authoritative** for all quantum computation and verification. The **frontend only renders** values that arrive with a provenance object.
- Dependency direction is one way, and import-graph tests enforce that the tutor cannot reach the provenance writer.

Full description: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Project structure

| Path | Contents |
|---|---|
| `backend/` | Python 3.12 FastAPI app (`qentor/`), unit tests (`tests/`), and scripts for content validation, mutation checks, fixtures and smoke tests (`scripts/`) |
| `web/` | React + TypeScript + Vite frontend, with its own tests |
| `docs/` | Product contract, architecture, verification and AI-boundary rules, build state, demo journey; `docs/source/` holds the extracted text of the submission sources |
| `fixtures/` | Golden circuit ↔ OpenQASM fixtures shared by the backend and web tests, the public lesson catalog fixture and the Optimize examples |
| `scripts/` | Real-Chrome journey scripts (`demo_journey.mjs`, `viz_journey.mjs`) |
| `Dockerfile`, `render.yaml` | One-image deployment (see below) |
| `CLAUDE.md` | Engineering rules for contributors |

## Running locally

Development is done in Linux or WSL2 with Python 3.12 and Node 22 (see [`docs/BUILD_STATE.md`](docs/BUILD_STATE.md), "Environment").

```bash
# Backend: a dedicated virtual environment
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python backend/scripts/check_versions.py

# Frontend dependencies
(cd web && npm ci)
```

**Development** (two terminals; the Vite dev server proxies `/api` to port 8000):

```bash
backend/.venv/bin/python -m uvicorn qentor.api.app:app --app-dir backend --port 8000
(cd web && npm run dev)
```

**Production-style** (one process serves the web build and the API):

```bash
backend/scripts/serve_production.sh 8000     # builds web/ then serves http://localhost:8000
```

The tutor needs no configuration. To enable the optional LLM layer, copy `backend/.env.example` to a git-ignored `backend/.env` and set the values there; never commit a key.

## Testing

```bash
backend/.venv/bin/python -m unittest discover -s backend/tests -t backend     # backend
(cd web && npx vitest run && npx tsc -b && npm run build)                       # frontend tests, typecheck, build
backend/.venv/bin/python backend/scripts/mutation_check.py [backend|web]        # trust mutation check
backend/.venv/bin/python backend/scripts/validate_content.py                    # lesson and challenge content validator
```

The last full verification recorded in [`docs/BUILD_STATE.md`](docs/BUILD_STATE.md) was 2065 backend tests and 2549 frontend tests (123 files, run with `--maxWorkers=4`), all passing, plus real-Chrome journeys with axe-core accessibility checks. Those figures are copied from that file and were not re-run for this README. The same file lists what was not verified (for example, no screen-reader pass).

## Deployment

The [`Dockerfile`](Dockerfile) builds the web app in a Node 22 stage, then runs the backend as a non-root user with `uvicorn` serving both the API and `web/dist`. The SQLite database lives at `/data/qentor.db`; mount a volume at `/data` to keep it. [`render.yaml`](render.yaml) is a Render blueprint for one Docker web service with a 1 GB disk, a health check on `/api/health` and the LLM disabled by default; secrets such as `QENTOR_TUTOR_LLM_API_KEY` are set in the host's dashboard, never in the repository.

Status, stated plainly: the production process was verified locally, but the Docker image has **not** been built and nothing has been deployed to a public host. Run exactly one `uvicorn` process (no `--workers`, no `--reload`); the reason is in `docs/BUILD_STATE.md` ("Process stability").

## Demo

- [`docs/DEMO_JOURNEY.md`](docs/DEMO_JOURNEY.md): the canonical demo path from the welcome screen to a forked shared experiment, what each step asserts, and how to re-run it (`scripts/demo_journey.mjs`) against the production build.
- [`docs/PRODUCT_CONTRACT.md`](docs/PRODUCT_CONTRACT.md): what was promised and the hero demo path.

## Documentation

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/VERIFICATION_ARCHITECTURE.md`](docs/VERIFICATION_ARCHITECTURE.md) · [`docs/AI_BOUNDARY.md`](docs/AI_BOUNDARY.md) · [`docs/REASONING_ENGINE.md`](docs/REASONING_ENGINE.md) · [`docs/VISUALIZATION.md`](docs/VISUALIZATION.md) · [`docs/VARIATIONAL.md`](docs/VARIATIONAL.md) · [`docs/SHOR_LESSON.md`](docs/SHOR_LESSON.md) · [`docs/BUILD_STATE.md`](docs/BUILD_STATE.md)

## Team

Team Qentor, SIH 2026 (SIH26140). *Team member names to be added by the team.*

## License

No license has been chosen yet. Until one is added, all rights are reserved by the authors.
