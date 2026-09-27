# Qentor Architecture

Goal: the smallest system that makes every promise in `PPT_REQUIREMENTS_MATRIX.md` real, and that
two or three people can build in 48 hours.

## 1. Shape of the system

One deployable unit: a Python FastAPI process that serves the built React app and a JSON API.
The quantum SDKs are Python libraries, so they run in the same process. There is no separate
service, no queue, no cache server and no external database.

```
Browser (React + TypeScript)
  │  canonical circuit JSON  (never numbers the server should compute)
  ▼
FastAPI  ──────────────────────────────────────────────────────────────
  api/            HTTP routes, request validation (pydantic)
  circuit/        canonical model, OpenQASM 3 emitter/importer, hashing
  execution/      backend adapters: Aer, Cirq, PennyLane, recorded hardware, (P1) IBM live
  verification/   test harness, equivalence checker, optimiser, misconception rules
  tutor/          fact sheet builder, LLM adapter, output guard, claim re-simulation, templates
  learning/       content loader, mastery, next-challenge recommender
  storage/        SQLite: result/provenance log, progress; read-only recorded hardware files
────────────────────────────────────────────────────────────────────────
```

Dependency direction is one way: `api → tutor → verification → execution → circuit`.
`learning` depends on `verification` reports. **Nothing in `execution` or `verification` imports
`tutor`.** The LLM sits at the top of the stack and can only read results.

## 2. Repository layout

```
Qentor/
  CLAUDE.md
  docs/                      contract, architecture, plans
  web/                       React + TypeScript + Vite
    src/circuit/             IR types (zod), QASM emit/parse for live editing
    src/provenance/          VerifiedValue, ProvenanceBadge, result store
    src/features/learn|build|test|optimize|reality|reflect|tutor/
    src/i18n/                string catalogue (en; hi is P1)
  server/
    qentor/                  python package (modules listed in §1)
    content/                 lessons and challenges as JSON (data, not code)
    data/hardware_runs/      recorded IBM runs + MANIFEST.sha256 (read-only at runtime)
    scripts/record_hardware.py   run by a team member with their IBM token
    scripts/crosscheck.py        cross-backend agreement report
    tests/
  fixtures/circuits/         golden IR ↔ QASM fixtures shared by web and server tests
```

## 3. Frontend

- **Stack:** React 18, TypeScript, Vite, Zustand for state, CodeMirror 6 for the OpenQASM editor, Plotly (`plotly.js-basic-dist-min`) for charts, Three.js for the Bloch sphere. All from the deck (p3).
- **Screens:** Learn, Build (canvas + code + results), Test, Optimize, Reality-check, Reflect, with a tutor side panel available everywhere. These mirror the deck's six steps.
- **Canvas:** grid of qubit wires by time columns. Click-to-place gates from a palette (P0). Drag and drop is P1. Controls and targets are chosen by clicking wires.
- **Numbers:** the frontend never computes a probability, amplitude, fidelity or verdict. It renders values that arrive with a provenance object through one component, `VerifiedValue`. See `VERIFICATION_ARCHITECTURE.md` §5.
- **Latency:** circuit edits are debounced (250 ms) before an execute call. Results are cached by circuit hash in the client.

## 4. Canonical circuit model

The canonical model is a versioned JSON document. The canvas, the code editor, every adapter, the
verifier, the optimiser and the tutor all read and write this one shape.

```json
{
  "schema": "qentor.circuit/1",
  "num_qubits": 4,
  "num_clbits": 3,
  "ops": [
    {"gate": "h",  "targets": [0]},
    {"gate": "cx", "controls": [0], "targets": [3]},
    {"gate": "rz", "targets": [1], "params": [1.5707963267948966]},
    {"gate": "oracle", "slot": "f", "targets": [0, 1, 2, 3]},
    {"gate": "measure", "targets": [0], "clbits": [0]}
  ]
}
```

- **Gate set (P0):** `id x y z h s sdg t tdg rx ry rz p cx cy cz swap ccx measure barrier`, plus `oracle` (a named slot the test harness fills). Nothing else is accepted.
- **Limits:** 1–8 qubits interactive; hard cap 10 for equivalence checks (operator size 1024×1024).
- **OpenQASM 3** is the canonical *text* form and the wire format between stages, as the deck promises. The server's emitter is authoritative. The frontend has its own emitter and parser for instant editor sync. Both must produce byte-identical text on the shared golden fixtures, which a test enforces.
- **Independent parse check:** the server also parses canonical QASM with Qiskit's `qasm3` importer and checks operator equivalence against the model in tests. That catches emitter bugs with a second, independent parser.
- **Circuit hash:** SHA-256 of the canonical QASM text with `oracle` slots rendered by name. Displayed as `qc_` plus the first 12 hex characters. The hash keys result caching, provenance and recorded-hardware lookup.
- **Bit order:** displayed bitstrings are `q[n-1] … q[0]` (Qiskit order). Adapters convert. Cirq and PennyLane use the opposite order internally, so conversion is covered by cross-backend tests. The UI states the convention next to every histogram.
- **Code input safety:** the learner or the AI can only supply OpenQASM 3 text or the JSON model. Python is never executed. The Qiskit, Cirq and PennyLane code views are generated, read-only text.

## 5. Execution layer

One adapter interface; one normalised result shape.

```python
class ExecutionAdapter(Protocol):
    name: str                      # "qiskit-aer" | "cirq" | "pennylane" | "ibm-recorded" | "ibm-live"
    def capabilities(self) -> Capabilities: ...
    def run(self, circuit: Circuit, request: RunRequest) -> ExecutionResult: ...
```

`RunRequest.mode` is one of `statevector`, `shots`, `steps` (statevector after each op), or
`unitary`. Every `ExecutionResult` is written to the provenance log before it is returned.

## 6. Backend adapters

| Adapter | Priority | Implementation | Used for |
|---|---|---|---|
| Qiskit Aer | P0 | Build `QuantumCircuit` from the model. `AerSimulator(method="statevector")` with `save_statevector` (and per-op saves for `steps`). Shots with a fixed, recorded seed. | Primary executor. **All verification runs on Aer.** |
| Cirq | P0 | Build `cirq.Circuit` from the model. `cirq.Simulator(dtype=np.complex128)`. | Run-on-Cirq and cross-backend agreement |
| PennyLane | P0, drops to P1 if install fails | `qml.device("default.qubit")` with a QNode built from the model. | Run-on-PennyLane and cross-backend agreement |
| IBM recorded | P0 | Read-only lookup in `server/data/hardware_runs/` by circuit hash. Files come from `scripts/record_hardware.py`. | Reality-check |
| IBM live | P1 | `qiskit-ibm-runtime` SamplerV2 submit, then poll by job id over plain HTTP. No queue infrastructure. | Optional live run |
| Aer noise model | P1 | Aer with a noise model from a fake IBM backend. Labelled SIMULATION · NOISE MODEL. | Circuits without a recorded run |
| qBraid | P2 | — | — |
| Aer stabilizer | P2 | `method="stabilizer"` for Clifford-only circuits. | Deck p4 "can use" |

Adapters build their native circuit **from the canonical model**, not from generated source code.
The cross-backend agreement view runs the same circuit on all three simulators and reports the
largest probability difference and pairwise state fidelity.

## 7. Verification layer

Details in `VERIFICATION_ARCHITECTURE.md`. Summary:

- **Test harness:** a challenge declares a test spec. Kinds: `basis-sweep` (every input bitstring), `oracle-slot` (substitute every oracle in a family, such as the 72 DJ oracles), `state-prep` (fidelity with target), `unitary-match` (equivalence with a reference). Exact statevector probabilities, tolerance 1e-9. Returns pass counts, the first counterexample, and a result id for each case.
- **Equivalence checker:** operator equivalence up to global phase. If not equivalent, it returns a concrete distinguishing input state. Circuits with mid-circuit measurement or reset return UNVERIFIABLE rather than a guess.
- **Optimiser:** deterministic rewrite rules. Every proposal passes through the equivalence checker before the UI can call it verified.
- **Misconception rules:** deterministic tags computed from the test report and simple structural checks.

## 8. AI tutor

Details in `AI_BOUNDARY.md`.

- The client sends a question plus **result ids**, never numbers.
- The server builds a fact sheet from its own provenance log.
- The LLM returns structured output: text segments, fact references, typed claims, and an optional candidate circuit.
- The guard strips any quantum number the LLM wrote itself, re-simulates typed claims, and sends candidate circuits through the verification layer.
- With no key, a timeout, or a failed guard, a deterministic template explanation is used and labelled as such.
- **Model:** provider-agnostic adapter, as the draft slide says. The default adapter uses the Anthropic API with `claude-opus-5` and structured outputs (`output_config.format` with a JSON schema). Use low effort for tutor turns to keep latency acceptable on stage. The model id is an environment setting. The API key lives only in the server environment.

## 9. Learning engine

- **Content as data:** lessons and challenges are JSON files validated by a schema at startup. A lesson has steps (explain, example circuit, predict-then-run). A challenge has a starter circuit, a reference solution, a test spec, concept tags and misconception rules.
- **Content test:** CI loads every lesson and challenge, runs each reference solution against its own test spec, and fails if any does not pass.
- **Mastery:** per-concept score updated only by verified test events (pass, fail, hint used). Displayed as mastered/total concepts ("6/8", as Deck p3 shows). A Bayesian knowledge tracing variant is P1.
- **Next challenge:** the lowest-mastery concept whose prerequisites are mastered. Deterministic and unit-tested.

## 10. Internationalisation

- All UI strings go through an i18n catalogue from day one (P0, cheap).
- English is the only P0 language. Hindi UI and Hindi tutor answers are P1 and not a PPT promise.
- Numbers, kets and bitstrings are never translated or regenerated by the LLM. They are rendered from facts in every language.
- Template explanations are catalogue entries, so the no-AI fallback is also translatable.

## 11. Storage

| Data | Where | Why |
|---|---|---|
| Provenance log (every execution and verification result) | SQLite table `results` | Tutor fact lookup; audit trail for judges |
| Learner progress, mastery, attempts | SQLite keyed by anonymous learner id, mirrored in browser local storage | No accounts needed |
| Recorded hardware runs | JSON files in `server/data/hardware_runs/` with a SHA-256 manifest, loaded read-only | Tamper-evident and reviewable in git |
| Content | JSON files in `server/content/` | Reviewable, testable, translatable |

PostgreSQL appears only in a draft slide. SQLite is enough for one server process. The schema is
plain SQL and could move later.

## 12. Deployment

- **Primary demo:** the team laptop runs `uvicorn` serving the built frontend. Everything except the optional LLM call works with the network off.
- **P1:** a Dockerfile (Python 3.12 slim + built frontend) deployed to one container host for the deck's demo link.
- **Python version:** use Python **3.12** in a virtual environment. The machine has 3.14, for which Qiskit Aer, Cirq and PennyLane wheels may not exist yet. This is checked in hour 0.
- **Backup:** a recorded screen capture of the hero path in case the laptop or network fails.

## 13. Failure handling

| Failure | Behaviour |
|---|---|
| An adapter is not installed or crashes | Backend chip shows "unavailable" with the error. Other backends still work. No substitute numbers. |
| Circuit too large | Refused with the limit stated. No truncated result. |
| Equivalence not decidable (measurement mid-circuit) | UNVERIFIABLE with the reason. The optimiser proposal is not offered as verified. |
| No recorded hardware run for this hash | "No recorded hardware run for this exact circuit." Library circuits are listed. |
| LLM unavailable, slow (8 s) or guard rejects twice | Template explanation, labelled "Explanation generated without AI". |
| IBM live job queued too long (P1) | Job id shown with status. Never replaced by a simulated result. |
