<div align="center">

<img src="docs/assets/qentor-logo.svg" alt="Qentor logo" width="560">

**An interactive quantum-computing learning platform: build circuits, run them on real simulators, and see every result checked on the server.**

### [🚀 OPEN QENTOR LIVE →](https://qentor-production-52dc.up.railway.app/)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Python 3.12](https://img.shields.io/badge/python-3.12-blue)
![FastAPI](https://img.shields.io/badge/backend-FastAPI-009688)
![React + TypeScript](https://img.shields.io/badge/frontend-React%20%2B%20TypeScript-3178c6)
![Smart India Hackathon 2026](https://img.shields.io/badge/SIH-2026%20%C2%B7%20SIH26140-orange)

</div>

## What is Qentor?

Qentor is a web platform for learning quantum algorithms by doing. A learner follows guided lessons, builds a circuit on a canvas or in OpenQASM 3, runs it on a quantum simulator, inspects the result gate by gate, asks an AI tutor (Qubi) about it, and proves understanding with challenges that the server grades.

Every quantum number on screen (amplitudes, probabilities, counts, equivalence verdicts, pass/fail) is computed by the Python backend and shown with where it came from. The browser only draws what the server returns.

## Problem

Quantum computing is abstract. State vectors, phase, entanglement and interference are hard to picture from text alone, and a learner who only reads cannot try an idea, see what the circuit really does, and get honest feedback. Static explanations, separate simulators and separate quizzes leave the learner to connect the pieces alone.

## Solution

Qentor puts the whole loop in one place:

**Learn → Build → Run → Observe → Understand → Challenge**

1. **Learn** from guided lessons with server-graded concept checks.
2. **Build** the circuit with drag-and-drop, the keyboard, or OpenQASM 3.
3. **Run** it on Qiskit Aer, Cirq or PennyLane, as exact statevectors or sampled shots.
4. **Observe** probabilities, a gate-by-gate trace, per-qubit 3D Bloch spheres and amplitude/phase.
5. **Understand** with Qubi, the tutor, and with "Debug my circuit", optimisation, what-if and the Noise Lab.
6. **Challenge** yourself with problems whose verdicts and hints come from the server.

## Why Qentor?

- **The language model is not the quantum computer.** Results come from simulators on the server. The tutor explains recorded results by id and never produces a quantum number itself.
- **Every result carries provenance:** result id, circuit hash, backend and version, execution mode and a `SIMULATION` label.
- **Honest by design.** No real quantum hardware is used or implied. Noise is labelled "Simulated noise". When something is unavailable, the app says so instead of substituting data.
- **Safe with code.** Pasted OpenQASM 3, Qiskit, Cirq or PennyLane code is parsed against an allow-list and never executed.

Details: [`docs/VERIFICATION_ARCHITECTURE.md`](docs/VERIFICATION_ARCHITECTURE.md) and [`docs/AI_BOUNDARY.md`](docs/AI_BOUNDARY.md).

## Key Features

| Feature | What it does |
|---|---|
| **Interactive lessons** | 19 lessons with 38 server-graded concept checks; each algorithm lesson is one small, fixed example and says so |
| **Circuit editor** | Drag-and-drop or keyboard editing with insert, move, delete, undo and redo, kept in sync with an OpenQASM 3 editor |
| **Quantum simulation** | Qiskit Aer, Cirq and PennyLane backends in statevector or shots mode, with a cross-backend agreement check |
| **Probabilities and trace** | Sampled-versus-theoretical probability charts and a recorded state after every operation |
| **3D Bloch spheres** | An interactive sphere for each qubit, drawn from per-qubit states derived by the server |
| **Qubi, the AI tutor** | Explains results, trace steps and failed attempts from recorded facts; works without a language model (deterministic templates) and answers in English, Hindi or Kannada. An optional LLM layer is off by default |
| **Challenges** | 20 challenges graded on the server, with authored hints and counterexamples |
| **Debug my circuit** | A report built from backend runs: what was observed, what mismatched, and what to try next |
| **Verification** | Circuit equivalence up to global phase, multi-input testing with counterexamples, and an optimiser whose every proposal is equivalence-checked |
| **Reasoning flows** | Server-side probability questions, optimisation, what-if (the counterfactual circuit is shown before anything runs), trace-change and comparison |
| **Noise Lab** | Run one circuit ideally and under depolarizing, bit-flip, phase-flip, amplitude-damping or readout-error noise on Aer, then compare the two ([`docs/NOISE_LAB.md`](docs/NOISE_LAB.md)) |
| **Code views and import** | Read-only Qiskit, Cirq and PennyLane views; import from OpenQASM 3 or those SDKs through a safe parser |
| **Progress, sharing, classrooms** | Browser-local progress; read-only shared experiments with "Fork into my Lab"; anonymous classrooms with an instructor dashboard and no accounts |
| **Accessibility and responsiveness** | Keyboard operation, labelled controls, reduced-motion support (Qubi stays still), and layouts checked from phone to desktop widths; automated axe-core checks are part of the browser journeys |

What is not built is stated in [`docs/BUILD_STATE.md`](docs/BUILD_STATE.md) ("What is NOT built").

## Judge Quickstart

**[🚀 Open Qentor live →](https://qentor-production-52dc.up.railway.app/)**

The fastest route through the product (about five minutes):

1. Open the live demo. The welcome screen offers **Start learning**.
2. Open **Learn** and start a lesson, for example *Qubits & Measurement*, and answer its concept check.
3. At the lesson's lab step choose **Open in Lab**. The lesson's circuit appears on the canvas.
4. Edit it: add or move gates, or switch the backend.
5. **Run** it, then read the probabilities, open the **Trace** and select a step to see the per-qubit Bloch spheres.
6. Ask **Qubi** for an explanation ("What changed?" on a trace step, or a question about the result).
7. Open **Challenges**, pick one and **Submit for checking**. The verdict comes from the server.
8. Open **Noise Lab**, load the *Bell pair* example, choose a noise model and press **Run ideal vs noisy**.
9. Open **Progress** to see the record of what you did.

These steps follow the scripted journeys in [`docs/DEMO_JOURNEY.md`](docs/DEMO_JOURNEY.md) and [`docs/NOISE_LAB.md`](docs/NOISE_LAB.md).

## Curriculum

All 19 lessons are open from the start; prerequisites only suggest an order.

**Foundations**

| Lesson | Level |
|---|---|
| Qubits & Measurement | Beginner |
| Bloch Sphere | Beginner |
| Superposition | Beginner |
| Phase | Beginner |
| Interference | Intermediate |

**Entanglement and communication**

| Lesson | Level |
|---|---|
| Entanglement | Intermediate |
| Bell State | Intermediate |
| Superdense Coding | Intermediate |
| Quantum Teleportation | Advanced |

**Core algorithms**

| Lesson | Level |
|---|---|
| Phase Kickback | Advanced |
| Deutsch–Jozsa | Advanced |
| Bernstein–Vazirani | Advanced |
| Grover's Search | Advanced |

**Advanced topics**

| Lesson | Level |
|---|---|
| Quantum Fourier Transform | Advanced |
| Quantum Phase Estimation | Advanced |
| Quantum Error Correction | Advanced |
| Variational Circuits: a VQE-Style Demonstration | Advanced |
| Shor's Algorithm — Order Finding Intuition | Advanced |

**Noise**

| Lesson | Level |
|---|---|
| Understanding Quantum Noise | Intermediate |

## Architecture

```
Browser
   │   canonical circuit JSON  ▲  results with provenance
   ▼                           │
React + TypeScript frontend (Vite)       renders only what the server returns
   │
   ▼
FastAPI backend                          api → tutor → verification → execution → circuit
   │
   ▼
Quantum execution and verification       Qiskit Aer · Cirq · PennyLane
   │
   ▼
SQLite                                   provenance log, sharing, classroom events
```

- **One service.** A single FastAPI process serves the JSON API and the built React app. There is no queue, cache, or external database.
- **One circuit model.** The canonical circuit (`qentor.circuit/1`) is the source of truth; OpenQASM 3 is its canonical text and the circuit hash is the SHA-256 of that text.
- **One-way dependencies.** `api → tutor → verification → execution → circuit`. Tests enforce that the tutor cannot reach the code that writes provenance records.
- **Deployment.** The app is packaged as one Docker image and deployed to Railway as a single service, with persistent storage mounted for the SQLite database.

Full description: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React, TypeScript, Vite | The application UI and build |
| Frontend | Zustand, Zod | Per-feature state; runtime validation of every server response |
| Frontend | Tailwind CSS | Styling |
| Frontend | CodeMirror 6 | OpenQASM 3 editor |
| Frontend | Plotly (`plotly.js-basic-dist-min`) | Probability and comparison charts |
| Frontend | three.js, React Three Fiber, drei | Interactive 3D Bloch spheres |
| Backend | Python 3.12, FastAPI, Uvicorn, Pydantic | API and request validation |
| Quantum | Qiskit, Qiskit Aer, qiskit-qasm3-import | Primary simulator, noise simulation, OpenQASM 3 import |
| Quantum | Cirq, PennyLane | Additional simulator backends |
| Quantum | NumPy | Numerical support |
| Storage | SQLite | Provenance log, shared experiments, classroom events |
| Tutor | Deterministic answer engine; optional Anthropic adapter | Grounded explanations; the LLM layer is off by default |
| Testing | `unittest`; Vitest, jsdom; axe-core; oxlint | Backend and frontend tests, accessibility checks, linting |
| Packaging | Docker | Single-image deployment |
| Hosting | Railway | Current production deployment |

## Repository Structure

```
.
├── backend/
│   ├── qentor/
│   │   ├── api/            HTTP routes, request validation, static serving of the web build
│   │   ├── circuit/        canonical circuit model, OpenQASM 3 emitter and parser, hashing, code views
│   │   ├── execution/      Aer, Cirq and PennyLane adapters, traces, Bloch vectors, noise simulation
│   │   ├── verification/   equivalence, cross-backend agreement, optimiser, comparison, noise comparison
│   │   ├── reasoning/      probability, what-if, optimisation and debug analyses
│   │   ├── tutor/          grounded tutor, claim guard, deterministic answers, optional LLM adapter
│   │   ├── lessons/        lesson content and concept-check grading
│   │   ├── challenges/     challenge definitions and the server-side evaluator
│   │   ├── content/        cross-checks of lesson and challenge content
│   │   ├── provenance/     provenance records and challenge attempt log
│   │   ├── classroom/      anonymous classes and learner events
│   │   ├── sharing/        read-only shared experiments
│   │   └── storage/        SQLite connection and schema
│   ├── tests/              backend unit tests
│   ├── scripts/            content validation, mutation checks, fixtures, smoke tests, production start
│   └── requirements.txt    pinned Python dependencies
├── web/
│   ├── src/features/       build (Lab), learn, challenges, noise, tutor, guide (Qubi), bloch3d, compare, debug, share, classroom, progress, generate, shell
│   ├── src/api/            typed client for the backend
│   ├── src/circuit/        circuit types, editing, and the browser's OpenQASM 3 emitter and parser
│   ├── src/provenance/     provenance schema and the components that display it
│   └── src/a11y/           accessibility, contrast and layout tests
├── fixtures/               golden circuit and OpenQASM fixtures, the public lesson catalog, optimiser examples
├── scripts/                real-Chrome journey scripts (demo, visualisation, Noise Lab)
├── docs/                   architecture, verification, Noise Lab and other documentation (start at docs/README.md)
├── Dockerfile              one-image build: web build stage, then the Python backend
├── render.yaml             alternative single-service blueprint for Render
└── LICENSE                 MIT
```

## Local Development

**Prerequisites:** Python 3.12 and Node.js 22. Development is done on Linux or WSL2.

```bash
# Backend: a dedicated virtual environment
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
backend/.venv/bin/python backend/scripts/check_versions.py

# Frontend dependencies
(cd web && npm ci)
```

**Development mode** (two terminals; the Vite dev server proxies `/api` to port 8000):

```bash
backend/.venv/bin/python -m uvicorn qentor.api.app:app --app-dir backend --port 8000
(cd web && npm run dev)
```

**Production-style** (one process serves the web build and the API):

```bash
backend/scripts/serve_production.sh 8000     # builds web/, then serves http://localhost:8000
```

Run exactly one `uvicorn` process (no `--workers`, no `--reload`); the reason is in [`docs/BUILD_STATE.md`](docs/BUILD_STATE.md) ("Process stability").

The tutor needs no configuration. To enable the optional LLM layer, copy `backend/.env.example` to a git-ignored `backend/.env` and fill in the values there; never commit a key.

## Testing

```bash
# Backend
backend/.venv/bin/python -m unittest discover -s backend/tests -t backend

# Frontend: tests, typecheck, lint, production build
(cd web && npx vitest run)          # add --maxWorkers=4 on a small machine
(cd web && npx tsc -b)
(cd web && npm run lint)
(cd web && npm run build)

# Content and trust checks
backend/.venv/bin/python backend/scripts/validate_content.py        # lesson and challenge content validator
backend/.venv/bin/python backend/scripts/mutation_check.py [backend|web]
```

**Real-browser journeys** drive Chrome against the production process and run axe-core accessibility checks (they need Node 22, Chrome and `npm ci` in `web/`):

```bash
node scripts/demo_journey.mjs <outdir> <baseUrl>     # the canonical demo path
node scripts/viz_journey.mjs <outdir> <baseUrl>      # lessons, 3D Bloch spheres, editor visuals
node scripts/noise_journey.mjs <outdir> <baseUrl>    # the Noise Lab
```

Each script's header and [`docs/DEMO_JOURNEY.md`](docs/DEMO_JOURNEY.md) describe how to start the server first. The most recent recorded results, and what was not verified, are in [`docs/BUILD_STATE.md`](docs/BUILD_STATE.md).

## Deployment

Current deployment: **Railway** at <https://qentor-production-52dc.up.railway.app/>

The [`Dockerfile`](Dockerfile) builds the web app in a Node 22 stage, then runs the backend as a non-root user with `uvicorn` serving both the API and the built app on `$PORT`. The SQLite database path is set by `QENTOR_DB_PATH` (`/data/qentor.db` in the image), and the deployment attaches persistent storage for it so the data is not tied to a single container. The deployment is one service with one process.

Secrets such as `QENTOR_TUTOR_LLM_API_KEY` are set in the host's environment, never in the repository. [`render.yaml`](render.yaml) is an equivalent single-service blueprint for Render.

## Team & Responsibilities

### Divyansh Mehndiratta
**Team Lead — Quantum Computing & Core System Architecture**

Owns the quantum-computing/core technical direction and overall system architecture.

### Delisha Das
**Frontend & UI/UX**

Responsible for frontend experience, interface organization, visual consistency, and usability-focused project support.

### Pranjal Sadegaonkar
**Backend/API Integration**

Responsible for backend integration, API-facing project work, and service-level coordination.

### Khushi
**Documentation & Design Support**

Responsible for documentation support, presentation/design assistance, and project communication materials.

### Anubhav
**Testing & Quality Assurance**

Responsible for testing coordination, validation, bug reporting, and quality checks.

### Aayush
**Deployment, DevOps & Project Integration**

Responsible for deployment support, environment/integration coordination, and project-level integration.

## Smart India Hackathon 2026

- **Problem Statement ID:** SIH26140
- **Team Name:** Qentor
- **Team ID:** 186790
- **Institution:** IIIT Dharwad

## Roadmap

Possible next steps, none of them built today:

- Recorded and live hardware results, clearly separated from simulations (the UI already shows them as unavailable).
- Voice interaction with Qubi (speech input and output) on top of the existing tutor.
- Richer noise models and larger registers, always labelled as simulated.
- A screen-reader review with assistive technology (automated accessibility checks are in place; a manual pass has not been done).

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Divyansh Mehndiratta.
