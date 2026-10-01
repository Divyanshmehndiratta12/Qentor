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
  api/            HTTP routes, request validation (pydantic), static serving of web/dist
  circuit/        canonical model, OpenQASM 3 emitter, hashing, Qiskit/Cirq/PennyLane code views
  execution/      backend adapters (Aer, Cirq, PennyLane), trace, Bloch vectors, per-qubit reduced states, amplitude view, limits, sanity checks
  verification/   equivalence, cross-backend agreement, multi-input harness, optimiser, experiment comparison
  challenges/     challenge definitions, the fifteen challenges, the deterministic evaluator
  lessons/        lesson models (a server-side Lesson with the answer key, a PublicLesson without it), content, registry, concept-check grading
  content/        cross-catalog content validation (lessons, challenges, gate support, routes, the simulator); run by tests and a script, never at request time
  tutor/          fact sheets, LLM adapter, claim guard, deterministic answers, debugger, comparison facts
  provenance/     provenance records and store, challenge attempt log (writers: only api/ calls them)
  storage/        SQLite connection and schema (QENTOR_DB_PATH)
  (not built: recorded/live hardware adapters, learning/ on the server: learner state is browser-local)
────────────────────────────────────────────────────────────────────────
```

Dependency direction is one way: `api → tutor → verification / challenges → execution → circuit`
(`content` sits beside `api`: it reads `lessons`, `challenges` and `execution`, and nothing imports it at runtime).
**Nothing in `execution`, `verification` or `challenges` imports `tutor`, and `tutor` never imports a
provenance writer** (`provenance.store`, `provenance.attempts`); both are enforced by import-graph tests.
The LLM sits at the top of the stack and can only read results.

## 2. Repository layout

```
Qentor/
  CLAUDE.md
  Dockerfile, .dockerignore, render.yaml   one image serving web/dist and the API
  docs/                      contract, architecture, build state, plans
  backend/
    qentor/                  python package (modules listed in §1)
    tests/                   unittest suites (run with unittest discover)
    scripts/                 check_versions.py, regen_fixtures.py, mutation_check.py, serve_production.sh
    data/                    runtime SQLite database (git-ignored)
  web/                       React + TypeScript + Vite
    src/circuit/             IR types (zod), QASM emit/parse for live editing
    src/provenance/          VerifiedValue, ProvenanceBadge, response schemas
    src/api/                 ApiClient interface, real client, FIXTURE mock (refuses to fake anything quantum)
    src/features/            build, learn, challenges, debug, compare, share, progress, tutor, guide, shell
  fixtures/circuits/         golden IR <-> QASM fixtures shared by web and backend tests
```

## 3. Frontend

- **Stack:** React 18, TypeScript, Vite, Zustand (one store per feature), CodeMirror 6 for the OpenQASM editor, Plotly (`plotly.js-basic-dist-min`) for charts, Three.js for the Bloch sphere. No router dependency: the screen is state and `features/shell/routes.ts` keeps the URL in step.
- **Screens and paths:** Lab `/`, Learn `/learn`, Challenges `/challenges` and `/challenges/<id>`, Progress `/progress`. Direct loads, Back/Forward and reloads work because the server answers every page path with the same shell.
- **Lab:** canvas + palette (click or drag), code pane (OpenQASM, Qiskit, Cirq, PennyLane views), Results (run on a chosen backend in statevector or shots mode, sampled vs theoretical labelled, trace, Debug my circuit, Compare experiments, Share and export), and the Tutor.
- **Editing the circuit:** every change goes through `web/src/circuit/edit.ts` (insert, delete, move in time, move across wires, drag-drop as one edit) and the build store's single `commit`, so the canonical circuit stays the only circuit: the QASM text is always its emission (or, while the learner types, text that parses back to exactly it), a refused edit (a wire that does not exist, a gate that would leave the register) changes nothing and says why, and every change drops everything derived from the old circuit (result, trace, verification, tutor turns, in-flight answers). Undo and Redo keep up to 100 earlier circuits as immutable snapshots of the canonical model; typing in the code editor makes one step per burst, and an optimisation, a loaded lesson or an inserted AI proposal is one step too. A gate is picked by click (or Enter), then moved or deleted with the toolbar or Alt+arrows and Delete; the ▾ handles choose where the next gate is inserted; every drag has a button or key equivalent.
- **Tutor modes (Lab):** Explain (a question about the result), What changed? (the selected trace step), Debug, and Generate code, kept apart. Explain and What changed? share the Lab's one conversation, so the tutor's context-scoping rules are unchanged; a lesson's conversation and the Guide's embedded tutor keep their single mode.
- **Challenges:** the same canvas and results, with a palette restricted to the challenge's gates, the server's verdict per check, hints revealed one at a time, the debugger, and "what next".
- **Numbers:** the frontend never computes a probability, amplitude, fidelity, difference or verdict. It renders values that arrive with a provenance object through `VerifiedValue`. See `VERIFICATION_ARCHITECTURE.md` §5.
- **Latency:** circuit edits are debounced (250 ms) before an execute call (`useAutoRun`).
- **Persistence:** lesson progress and challenge outcomes are saved in this browser only, under versioned keys, with shape checks, migration chains and set-aside recovery. There are no accounts.

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

- **Gate set (built):** `h x y z s sdg t tdg rx ry rz cx cz cp swap ccx measure`. `cp(theta) control, target` is the controlled phase, `diag(1, 1, 1, e^{i*theta})`, theta in radians; it is the only controlled gate that takes an angle. A gate is added only together with its QASM emission, all three backends, the equivalence checker, the frontend model and a shared golden fixture. Nothing else is accepted. Planned, not built: `id`, `p`, `cy`, `barrier`, and `oracle` (a named slot the test harness fills).
- **Limits:** 1–8 qubits interactive; hard cap 10 for equivalence checks (operator size 1024×1024).
- **OpenQASM 3** is the canonical *text* form and the wire format between stages, as the deck promises. The server's emitter is authoritative. The frontend has its own emitter and parser for instant editor sync. Both must produce byte-identical text on the shared golden fixtures, which a test enforces.
- **Independent parse check:** the server also parses canonical QASM with Qiskit's `qasm3` importer and checks operator equivalence against the model in tests. That catches emitter bugs with a second, independent parser.
- **Circuit hash:** SHA-256 of the canonical QASM text with `oracle` slots rendered by name. Displayed as `qc_` plus the first 12 hex characters. The hash keys result caching, provenance and recorded-hardware lookup.
- **Bit order:** displayed bitstrings are `q[n-1] … q[0]` (Qiskit order). Adapters convert. Cirq and PennyLane use the opposite order internally, so conversion is covered by cross-backend tests. The UI states the convention next to every histogram.
- **Code input safety:** the learner or the AI can only supply OpenQASM 3 text or the JSON model. Python is never executed. The Qiskit, Cirq and PennyLane code views are generated, read-only text.

## 5. Execution layer

> **As built:** the adapter contract is `run(circuit, mode, shots)` with modes `statevector` and `shots`, returning a normalised `ExecutionResult`; the API layer persists it (after a state sanity check) before it leaves the server. Per-step states come from `execution/trace.py` (one statevector run per prefix), not a `steps` mode. `capabilities.py` and `limits.py` refuse unsupported gates and oversize requests before any backend runs. The snippet below is the original plan.

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

> **As built:** Qiskit Aer, Cirq and PennyLane are built and selectable in the Lab; the same circuit is compared across them on the server. **Not built:** IBM recorded and live adapters, the Aer noise model, qBraid, the stabilizer method. The UI shows Recorded and Live QPU as unavailable ("soon"); no hardware result of any kind exists in this build.

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

> **As built:** equivalence checker, cross-backend agreement, Bell-state verifier, the multi-input basis-sweep harness (explicit cases, with counterexamples), the optimiser (each proposal equivalence-checked), challenge evaluation and experiment comparison. **Not built:** an `oracle-slot` sweep over the whole 72-oracle Deutsch-Jozsa family (the two oracle challenges use one fixed oracle each).

Details in `VERIFICATION_ARCHITECTURE.md`. Summary:

- **Test harness:** a challenge declares a test spec. Kinds: `basis-sweep` (every input bitstring), `oracle-slot` (substitute every oracle in a family, such as the 72 DJ oracles), `state-prep` (fidelity with target), `unitary-match` (equivalence with a reference). Exact statevector probabilities, tolerance 1e-9. Returns pass counts, the first counterexample, and a result id for each case.
- **Equivalence checker:** operator equivalence up to global phase. If not equivalent, it returns a concrete distinguishing input state. Circuits with mid-circuit measurement or reset return UNVERIFIABLE rather than a guess.
- **Optimiser:** deterministic rewrite rules. Every proposal passes through the equivalence checker before the UI can call it verified.
- **Misconception rules:** deterministic tags computed from the test report and simple structural checks.

## 8. AI tutor

> **As built:** result-, lesson- and trace-step-grounded answers, the debugger and comparison answers, all through one claim guard (`tutor/claims.py`, `guard.py`). The guard checks every number, ket, bitstring and verdict in a draft against the facts it was given; it does not re-simulate typed claims, and the LLM does not return candidate circuits. The LLM is off unless configured, and every answer says whether AI wrote it. Answer language: English, Hindi or Kannada (wrapper text only; numbers and gate names are never translated).

Details in `AI_BOUNDARY.md`.

- The client sends a question plus **result ids**, never numbers.
- The server builds a fact sheet from its own provenance log.
- The LLM returns structured output: text segments, fact references, typed claims, and an optional candidate circuit.
- The guard strips any quantum number the LLM wrote itself, re-simulates typed claims, and sends candidate circuits through the verification layer.
- With no key, a timeout, or a failed guard, a deterministic template explanation is used and labelled as such.
- **Model:** provider-agnostic adapter, as the draft slide says. The default adapter uses the Anthropic API with `claude-opus-5` and structured outputs (`output_config.format` with a JSON schema). Use low effort for tutor turns to keep latency acceptable on stage. The model id is an environment setting. The API key lives only in the server environment.

## 9. Learning engine

- **Lessons** are backend-owned data (`backend/qentor/lessons/`), validated at startup: unique ids, prerequisites that exist, a lab section only with a linked circuit.
- **Challenges** are backend-owned data (`backend/qentor/challenges/`): goal, constraints (qubits, allowed gates, size, required gates, a locked "anchor" (the fixed oracle, decoder or corrections, named by `anchor_name`), gates limited to certain qubits, required measurements), checks, authored hints and coaching, and a reference solution that must pass its own spec (tested). Fourteen exist: create |1>, |+>, |->, a Bell state, a phase change, interference, phase kickback, ONE fixed Deutsch-Jozsa and ONE fixed Bernstein-Vazirani oracle, and (Sprint 2) create |+> and verify its Bloch direction, a Bell state shown through each qubit's own reduced state, superdense coding of message 10 (fixed decoder; the encoding gates may only act on Alice's qubit), teleportation of the fixed ry(1.0) state (fixed deferred corrections) and Grover's search for the item 01 (fixed oracle). There is no oracle synthesis.
- **Evaluation is deterministic and on the server** (`challenges/evaluate.py`): structure rules on the canonical model, then the learner's circuit is traced on Aer (every step a provenance record) and each check compares backend statevectors with states the same adapter produced for reference circuits. No LLM is involved in any verdict. Reference solutions and target circuits are never sent to the browser. Besides whole-state and probability checks there is a per-qubit check (the backend compares one qubit's own Bloch vector, from its reduced density matrix, with that qubit in a reference run) and a substitution option: a check can run the learner's circuit AGAIN with the locked part swapped (Grover with an oracle marking |10> instead) and judge that second backend run, which is recorded as its own provenance step. A circuit that hard-codes the answer passes the plain check and fails the substituted one. The locked part is matched exactly, except that a CZ with its two qubits named the other way round is the same gate.
- **Mastery, misconceptions and recommendation** are pure functions of what the browser saved (`web/src/features/learn/`): completion, concept-check accuracy (mastered at 80%), misconception signals, prerequisites and challenge outcomes. The recommendation (`recommendation.ts`) is a fixed rule order, carries its evidence, and says no AI is involved.
- **Learner report:** Progress shows one learner's record from this browser. There is no cohort or instructor data because there are no accounts, and none is invented.

## 10. Internationalisation

- All UI strings go through an i18n catalogue from day one (P0, cheap).
- As built: the interface and lessons are English. Tutor answer wrappers can be English, Hindi or Kannada; the debugger's template text is English only.
- Numbers, kets and bitstrings are never translated or regenerated by the LLM. They are rendered from facts in every language.
- Template explanations are catalogue entries, so the no-AI fallback is also translatable.

## 11. Storage

| Data | Where | Why |
|---|---|---|
| Provenance log (every execution, trace step, agreement and comparison) | SQLite table `results` | Tutor and debugger fact lookup; audit trail |
| Challenge attempt log (server verdicts, per-check outcomes, result ids) | SQLite table `challenge_attempts` | The debugger reads a judged attempt by id; no user column, so it is not a learner profile |
| Lesson progress, challenge outcomes, activity streak, welcome dismissal | Browser `localStorage`, versioned keys | No accounts; each is shape-checked and reconciled on load |
| Content | Python data modules (lessons, challenges) | Reviewable, testable |

The database path is `backend/data/qentor.db` (git-ignored) or `QENTOR_DB_PATH`. SQLite is enough for one
server process. Recorded hardware runs are not built.

## 12. Deployment

- **One process:** `uvicorn qentor.api.app:app` serves `/api/*` and the built web app. `api/static_site.py` mounts `web/dist` last, so API routes are never shadowed: page paths get the SPA shell (`no-cache`), a missing file with an extension and an unknown `/api/...` path are JSON 404s, `/assets/*` is cached immutable, and nothing outside the build directory (symlinks, dotfiles, traversal) is served.
- **Image:** the `Dockerfile` builds the web app in a Node stage and runs the backend as a non-root user with the database on a mountable volume (`/data`). `render.yaml` is a blueprint with a health check on `GET /api/health`. `backend/scripts/serve_production.sh` does the same without Docker.
- **Secrets:** the LLM is off unless the host sets `QENTOR_TUTOR_LLM_ENABLED` and `QENTOR_TUTOR_LLM_API_KEY`. No key or database is in git or the image (tested).
- **Status:** the production process was verified locally in real Chrome (see `BUILD_STATE.md`). The Docker image has not been built here (no Docker on the build machine), and nothing has been deployed to a public host.
- **Python version:** 3.12 in `backend/.venv` (WSL2 for development, per `BUILD_STATE.md`).
- **Web fonts** are loaded from Google Fonts; the app otherwise makes no third-party request.

## 13. Failure handling

| Failure | Behaviour |
|---|---|
| An adapter is not installed or crashes | Backend chip shows "unavailable" with the error. Other backends still work. No substitute numbers. |
| Circuit too large | Refused with the limit stated. No truncated result. |
| Equivalence not decidable (measurement mid-circuit) | UNVERIFIABLE with the reason. The optimiser proposal is not offered as verified. |
| No recorded hardware run for this hash | "No recorded hardware run for this exact circuit." Library circuits are listed. |
| LLM unavailable, slow (8 s) or guard rejects twice | Template explanation, labelled "Explanation generated without AI". |
| IBM live job queued too long (P1) | Job id shown with status. Never replaced by a simulated result. |

## 14. API surface (what exists)

| Route | Purpose |
|---|---|
| `POST /api/execute` | Run a canonical circuit on a chosen backend (statevector or shots); writes a provenance record |
| `POST /api/execute/trace` | The backend's state after each operation, one record per step |
| `POST /api/compare/backends` | Statevectors of one circuit on several backends, compared on the server |
| `POST /api/verify/equivalence`, `/bell-state`, `POST /api/test/multi-input`, `POST /api/optimize` | Verification layer. Optimize also returns the server's operation diff, a sentence per rewrite rule, the removed count and the candidate's provenance (VERIFICATION_ARCHITECTURE §4.4) |
| `POST /api/circuit/code`, `POST /api/export/circuit` | Read-only code views; a shareable bundle (circuit, QASM, code, run metadata, no results) |
| `GET /api/challenges[/{id}]`, `POST /api/challenges/{id}/submit` | The challenge catalog (no answers) and the server's verdict |
| `GET /api/generate/status`, `POST /api/generate/circuit` | AI code generation: whether a model is configured; a model PROPOSES OpenQASM 3 that the server parses, limits and labels "not yet verified" (503 with no model, 502 on a provider failure; see `AI_BOUNDARY.md` §9) |
| `POST /api/debug` | "Debug my circuit": observed / evidence / mismatch / next experiment / hint from server-held facts |
| `POST /api/compare/experiments`, `POST /api/tutor/comparison` | Compare two real runs; ask the tutor about the recorded comparison |
| `POST /api/tutor`, `GET /api/lessons`, `GET /api/health` | Tutor (result, lesson, trace-step context), lesson catalog (a concept check is served as its question and options only: no answer key, no explanation), liveness |
| `POST /api/lessons/{lesson_id}/concept-checks/{check_id}/grade`, `POST /api/assessments/regrade` | The server grades a concept-check selection against the lesson's own key and returns correctness and the explanation; the batch form grades saved selections again after a reload (each on its own, so one stale entry cannot sink the rest). A malformed body is `422 GRADE_REQUEST_INVALID`, structured like every other refusal |

Every request schema forbids extra fields, so a client has no field through which to send a result, a state or a verdict.
