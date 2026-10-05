# Qentor Architecture

Goal: the smallest system that makes the promises in `PRODUCT_CONTRACT.md` real, and that a small
student team can build in a hackathon.

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
  circuit/        canonical model, OpenQASM 3 emitter and parser, hashing, Qiskit/Cirq/PennyLane code views, the safe SDK-code reader (parses, never executes; see §17)
  execution/      backend adapters (Aer, Cirq, PennyLane), noise.py (Aer noise models and noisy shots, density matrix, 8 qubits), trace, Bloch vectors, per-qubit reduced states, amplitude view, limits, sanity checks
  verification/   equivalence, cross-backend agreement, multi-input harness, optimiser, experiment comparison, noise_compare (ideal vs noisy metrics and sentences)
  challenges/     challenge definitions, the twenty challenges, the deterministic evaluator
  lessons/        lesson models (a server-side Lesson with the answer key, a PublicLesson without it), content, registry, concept-check grading
  content/        cross-catalog content validation (lessons, challenges, gate support, routes, the simulator); run by tests and a script, never at request time
  tutor/          fact sheets, LLM adapter, claim guard, deterministic answers, debugger, comparison facts
  provenance/     provenance records and store, challenge attempt log (writers: only api/ calls them)
  classroom/      anonymous classes: capability tokens, learner events, the instructor's aggregate (a writer: only api/ calls it; see §15)
  sharing/        read-only shared experiments: an immutable snapshot of a circuit and, optionally, one stored run of it (a writer: only api/ calls it; see §16)
  storage/        SQLite connection and schema (QENTOR_DB_PATH)
  (not built: recorded/live hardware adapters; lesson progress itself is browser-local, the server holds only the classroom events of a learner who joined a class)
────────────────────────────────────────────────────────────────────────
```

Dependency direction is one way: `api → tutor → verification / challenges → execution → circuit`
(`content` sits beside `api`: it reads `lessons`, `challenges` and `execution`, and nothing imports it at runtime).
**Nothing in `execution`, `verification` or `challenges` imports `tutor`, and `tutor` never imports a
provenance writer** (`provenance.store`, `provenance.attempts`) **or the classroom and share writers** (`classroom`, `sharing`); all are enforced by import-graph tests.
`classroom` imports only `lessons`, `challenges` and `storage`, and `sharing` only `circuit` and `storage`: neither computes a quantum value and nothing below `api` imports either.
The LLM sits at the top of the stack and can only read results.

## 2. Repository layout

```
Qentor/
  README.md                  public overview
  CLAUDE.md                  engineering rules
  Dockerfile, .dockerignore, render.yaml   one image serving web/dist and the API
  docs/                      contract, architecture, build state, plans
  backend/
    qentor/                  python package (modules listed in §1)
    tests/                   unittest suites (run with unittest discover)
    scripts/                 check_versions.py, validate_content.py, mutation_check.py, regen_fixtures.py, regen_catalog_fixture.py,
                             resource_smoke.py, stability_smoke.py, viz_http_smoke.py, serve_production.sh
    data/                    runtime SQLite database (git-ignored)
  web/                       React + TypeScript + Vite
    src/circuit/             IR types (zod), QASM emit/parse for live editing
    src/provenance/          VerifiedValue, ProvenanceBadge, response schemas
    src/api/                 ApiClient interface, real client, FIXTURE mock (refuses to fake anything quantum)
    src/features/            build, learn, challenges, debug, compare, share, progress, tutor, guide, shell (and more; see the directory)
  fixtures/
    circuits/                golden IR <-> QASM fixtures shared by web and backend tests
    catalog/, optimizer_examples.json   the public lesson catalog fixture and the Optimize examples
  scripts/                   demo_journey.mjs and viz_journey.mjs: real-Chrome journeys (see DEMO_JOURNEY.md)
```

## 3. Frontend

- **Stack:** React 19, TypeScript, Vite, Zustand (one store per feature), CodeMirror 6 for the OpenQASM editor, Plotly (`plotly.js-basic-dist-min`) for charts, Three.js (through `@react-three/fiber` and `drei`, in a lazily loaded chunk) for the 3D Bloch spheres (`docs/VISUALIZATION.md`). No router dependency: the screen is state and `features/shell/routes.ts` keeps the URL in step.
- **Screens and paths:** Lab `/`, Learn `/learn`, Challenges `/challenges` and `/challenges/<id>`, Progress `/progress`. Direct loads, Back/Forward and reloads work because the server answers every page path with the same shell.
- **Lab:** canvas + palette (click or drag), code pane (OpenQASM, Qiskit, Cirq, PennyLane views), Results (run on a chosen backend in statevector or shots mode, sampled vs theoretical labelled, trace, Debug my circuit, Compare experiments, Share and export), and the Tutor.
- **Editing the circuit:** every change goes through `web/src/circuit/edit.ts` (insert, delete, move in time, move across wires, drag-drop as one edit) and the build store's single `commit`, so the canonical circuit stays the only circuit: the QASM text is always its emission (or, while the learner types, text that parses back to exactly it), a refused edit (a wire that does not exist, a gate that would leave the register) changes nothing and says why, and every change drops everything derived from the old circuit (result, trace, verification, tutor turns, in-flight answers). Undo and Redo keep up to 100 earlier circuits as immutable snapshots of the canonical model; typing in the code editor makes one step per burst, and an optimisation, a loaded lesson or an inserted AI proposal is one step too. A gate is picked by click (or Enter), then moved or deleted with the toolbar or Alt+arrows and Delete; the ▾ handles choose where the next gate is inserted; every drag has a button or key equivalent.
- **Accessibility (Sprint 3):** muted text is the `void-200` token (#8590a0, 5.9:1 on the page, 4.6:1 on the lightest surface) and `contrast.test.ts` fails if a weaker text colour returns; the top bar is one row from `md` and two below it (destinations on their own row) so Run never covers a destination; the Lab has one visually hidden `h1`, the OpenQASM editor and the scrollable regions are named and keyboard-focusable, and `a11y/axe.test.tsx` runs axe-core over each screen (colour contrast and layout rules need a real browser and were run there).
- **Angles (Sprint 4):** the palette's angle box and the QASM editor read angle expressions (`pi/4`, `-3*pi/4`, `0.5`) with the same grammar as the server's `read_angle` (`circuit/angle.ts`), so a learner builds the QFT and phase-estimation circuits without typing sixteen digits; text that is not an angle changes nothing. The canvas labels an angle that is a simple fraction of pi as such (`π/4`); the stored angle is the exact double.
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

> **As built:** Qiskit Aer, Cirq and PennyLane are built and selectable in the Lab; the same circuit is compared across them on the server. The Noise Lab (`NOISE_LAB.md`) runs a circuit ideally and under a simple noise model on Aer only. **Not built:** IBM recorded and live adapters, qBraid, the stabilizer method, noisy modes for Cirq and PennyLane. The UI shows Recorded and Live QPU as unavailable ("soon"); no hardware result of any kind exists in this build.

| Adapter | Priority | Implementation | Used for |
|---|---|---|---|
| Qiskit Aer | P0 | Build `QuantumCircuit` from the model. `AerSimulator(method="statevector")` with `save_statevector` (and per-op saves for `steps`). Shots with a fixed, recorded seed. | Primary executor. **All verification runs on Aer.** |
| Cirq | P0 | Build `cirq.Circuit` from the model. `cirq.Simulator(dtype=np.complex128)`. | Run-on-Cirq and cross-backend agreement |
| PennyLane | P0, drops to P1 if install fails | `qml.device("default.qubit")` with a QNode built from the model. | Run-on-PennyLane and cross-backend agreement |
| IBM recorded | P0 | Read-only lookup in `backend/data/hardware_runs/` by circuit hash. Files come from `backend/scripts/record_hardware.py` (not built). | Reality-check |
| IBM live | P1 | `qiskit-ibm-runtime` SamplerV2 submit, then poll by job id over plain HTTP. No queue infrastructure. | Optional live run |
| Aer noise model | P1, built as the Noise Lab | Aer with a simple, named, bounded noise model (not a fake IBM backend; no device calibration). Labelled "Simulated noise", SIMULATION, mode `noisy_shots`. | Seeing what noise does to a circuit's outcomes |
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

- **Lessons** are backend-owned data (`backend/qentor/lessons/`), validated at startup: unique ids, prerequisites that exist, a lab section only with a linked circuit. Prerequisites describe the recommended path ("Builds on", the suggested next lesson, the recommendation); they never lock a lesson: every lesson opens directly.
- **Challenges** are backend-owned data (`backend/qentor/challenges/`): goal, constraints (qubits, allowed gates, size, required gates, a locked "anchor" (the fixed oracle, decoder or corrections, named by `anchor_name`), gates limited to certain qubits, required measurements), checks, authored hints and coaching, and a reference solution that must pass its own spec (tested). Fourteen exist: create |1>, |+>, |->, a Bell state, a phase change, interference, phase kickback, ONE fixed Deutsch-Jozsa and ONE fixed Bernstein-Vazirani oracle, and (Sprint 2) create |+> and verify its Bloch direction, a Bell state shown through each qubit's own reduced state, superdense coding of message 10 (fixed decoder; the encoding gates may only act on Alice's qubit), teleportation of the fixed ry(1.0) state (fixed deferred corrections) and Grover's search for the item 01 (fixed oracle). There is no oracle synthesis.
- **Evaluation is deterministic and on the server** (`challenges/evaluate.py`): structure rules on the canonical model, then the learner's circuit is traced on Aer (every step a provenance record) and each check compares backend statevectors with states the same adapter produced for reference circuits. No LLM is involved in any verdict. Reference solutions and target circuits are never sent to the browser. Besides whole-state and probability checks there is a per-qubit check (the backend compares one qubit's own Bloch vector, from its reduced density matrix, with that qubit in a reference run) and a substitution option: a check can run the learner's circuit AGAIN with the locked part swapped (Grover with an oracle marking |10> instead) and judge that second backend run, which is recorded as its own provenance step. A circuit that hard-codes the answer passes the plain check and fails the substituted one. The locked part is matched exactly, except that a CZ with its two qubits named the other way round is the same gate.
- **Mastery, misconceptions and recommendation** are pure functions of what the browser saved (`web/src/features/learn/`): completion, concept-check accuracy (mastered at 80%), misconception signals, prerequisites and challenge outcomes. The recommendation (`recommendation.ts`) is a fixed rule order, carries its evidence, and says no AI is involved.
- **Learner report:** Progress shows one learner's record from this browser. A learner who joins a class (§15) is also counted, anonymously, in that class's instructor view; there are still no accounts, and no cohort figure is ever invented: with nobody in a class the dashboard says so.

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
| Classroom: classes (code, hash of the instructor key), anonymous learners (hash of the token), memberships, learner events | SQLite tables `classes`, `learners`, `memberships`, `learner_events` | Only for a learner who joined a class; no name, email or address column exists. Events older than `QENTOR_CLASSROOM_RETENTION_DAYS` (default 180) are purged at start; deleting a class deletes its events |
| Shared experiments (the circuit, its hash, backend and mode, an optional lesson/challenge and result id, an optional plain-text title) | SQLite table `shared_experiments` | An immutable snapshot with no owner column: nothing about the sharer, a class or the server is stored. The result itself is not copied: the share names one provenance record |
| Class code, learner token, instructor keys of classes this browser created | Browser `localStorage` key `qentor.classroom.v1` | The token is this browser's anonymous identity; the instructor key is the only way back into a dashboard |
| Content | Python data modules (lessons, challenges) | Reviewable, testable |

The database path is `backend/data/qentor.db` (git-ignored) or `QENTOR_DB_PATH`. SQLite is enough for one
server process. Recorded hardware runs are not built.

## 12. Deployment

- **One process:** `uvicorn qentor.api.app:app` serves `/api/*` and the built web app. `api/static_site.py` mounts `web/dist` last, so API routes are never shadowed: page paths get the SPA shell (`no-cache`), a missing file with an extension and an unknown `/api/...` path are JSON 404s, `/assets/*` is cached immutable, and nothing outside the build directory (symlinks, dotfiles, traversal) is served.
- **Process model and stability:** exactly one uvicorn process (no `--workers`, no `--reload`). Importing `qentor.api.app` calls `qentor.execution.runtime.preload_backends()`, which imports the native-extension backends on the main thread before any request; without it a Qiskit Rust-extension segfault was observed on fresh AnyIO worker threads. It is a mitigation of an observed trigger, not a fix of the dependency (evidence and limits in `BUILD_STATE.md` "Process stability").
- **Resource guards:** `api/guards.py` refuses a request body over 1 MB (413) and lets only 4 heavy requests run at once (the rest wait up to 30 s, then 503 `SERVER_BUSY`); the provenance log prunes its oldest unreferenced records past 20,000 rows or 512 MiB. Measurements and the numbers behind them are in `BUILD_STATE.md` "Resource limits".
- **Image:** the `Dockerfile` builds the web app in a Node stage and runs the backend as a non-root user with the database on a mountable volume (`/data`). `render.yaml` is a blueprint with a health check on `GET /api/health`. `backend/scripts/serve_production.sh` does the same without Docker.
- **Secrets:** the LLM is off unless the host sets `QENTOR_TUTOR_LLM_ENABLED` and `QENTOR_TUTOR_LLM_API_KEY`. No key or database is in git or the image (tested).
- **Status:** the production process was verified locally in real Chrome (see `BUILD_STATE.md`). The same image is deployed as a single service on Railway (<https://qentor-production-52dc.up.railway.app/>). The `Dockerfile` has no `VOLUME` instruction because Railway rejects it; persistent storage is attached through the platform instead, for the database path. The image is not built on the development machine (no Docker there).
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
| `POST /api/execute` | Run a canonical circuit on a chosen backend (statevector or shots); writes a provenance record. A statevector run's response also carries `qubit_states`: each qubit's own reduced state (Bloch vector, purity, entangled-with-the-rest, or an explicit `UNUSABLE` with a reason), derived by the server from the stored statevector (`api/state_view.py`) and tagged with the run's result id; empty for a shots run. The same field appears in a shared experiment's stored result |
| `POST /api/execute/trace` | The backend's state after each operation, one record per step |
| `POST /api/compare/backends` | Statevectors of one circuit on several backends, compared on the server |
| `POST /api/verify/equivalence`, `/bell-state`, `POST /api/test/multi-input`, `POST /api/optimize` | Verification layer. Optimize also returns the server's operation diff, a sentence per rewrite rule, the removed count and the candidate's provenance (VERIFICATION_ARCHITECTURE §4.4) |
| `POST /api/circuit/code`, `POST /api/export/circuit` | Read-only code views; a shareable bundle (circuit, QASM, code, run metadata, no results) |
| `GET /api/challenges[/{id}]`, `POST /api/challenges/{id}/submit` | The challenge catalog (no answers) and the server's verdict |
| `GET /api/generate/status`, `POST /api/generate/circuit` | AI code generation: whether a model is configured; a model PROPOSES OpenQASM 3 that the server parses, limits and labels "not yet verified" (503 with no model, 502 on a provider failure; see `AI_BOUNDARY.md` §9) |
| `POST /api/debug` | "Debug my circuit": observed / evidence / mismatch / next experiment / hint from server-held facts |
| `POST /api/variational/sweep`, `POST /api/variational/optimize` | The one-parameter variational (VQE-style) demonstration of lesson 17: `⟨Z⟩` of `RY(θ)` read from backend statevectors, a parameter sweep and a parameter-shift gradient loop; every point carries its run's provenance (see `VARIATIONAL.md`) |
| `POST /api/reasoning/analyze`, `POST /api/reasoning/what-if/preview` | The quantum reasoning engine: probability, optimise, what-if, trace change, compare, debug as structured intents; each analysis is one provenance record whose facts the tutor reads (see `REASONING_ENGINE.md`). The preview shows a what-if's counterfactual circuit before anything runs |
| `POST /api/compare/experiments`, `POST /api/tutor/comparison` | Compare two real runs; ask the tutor about the recorded comparison |
| `GET /api/noise/models`, `POST /api/noise/compare` | The Noise Lab: the bounded noise models and limits; run a circuit ideally and under a noise model on Aer, store three SIMULATION records (ideal, noisy `noisy_shots`, comparison) and return both runs with the comparison. Structured `NOISE_*` errors; see `NOISE_LAB.md` |
| `POST /api/tutor`, `GET /api/lessons`, `GET /api/health` | Tutor (result, lesson, trace-step context), lesson catalog (a concept check is served as its question and options only: no answer key, no explanation), liveness |
| `POST /api/lessons/{lesson_id}/concept-checks/{check_id}/grade`, `POST /api/assessments/regrade` | The server grades a concept-check selection against the lesson's own key and returns correctness and the explanation; the batch form grades saved selections again after a reload (each on its own, so one stale entry cannot sink the rest). A malformed body is `422 GRADE_REQUEST_INVALID`, structured like every other refusal |

| `POST /api/classes`, `POST /api/classes/join`, `GET /api/classes/me`, `POST /api/classes/leave`, `POST /api/classes/sync-progress` | Create a class (returns the class code and the instructor key, shown once); join by code; where this learner token stands; leave; count what a browser already did (the server grades each answer itself) |
| `POST /api/learner-events` | A browser may report only `lesson_started`, `lesson_completed` (accepted only when the server's own record shows every concept check answered correctly) and `challenge_started`; identifiers only |
| `POST /api/experiments`, `GET /api/experiments/{id}` | Share a circuit (and optionally one stored run of exactly that circuit) as a read-only page; read it. No endpoint lists, edits or deletes a share (see §16) |
| `POST /api/circuit/parse-code` | Read pasted OpenQASM 3, Qiskit, Cirq or PennyLane text into the canonical circuit for a preview. Python is parsed, never executed; unsupported code is refused with its line (see §17) |
| `GET /api/classes/{code}/dashboard`, `DELETE /api/classes/{code}` | The instructor's aggregate view and class deletion; both need the instructor key |

Every request schema forbids extra fields, so a client has no field through which to send a result, a state or a verdict.

## 15. Anonymous classroom

A class gives an instructor an aggregate view of the learners who joined it, with no accounts and no personal data. It is a small
capability model, not an authentication system.

**Capabilities (server-issued bearer secrets).** Nothing is authorised by a field a client says about itself; there is no `role`, no
instructor id and no learner id in any request.

| Capability | Issued when | Format | What it allows |
|---|---|---|---|
| Class code | A class is created | 8 characters from a 31-symbol alphabet with no look-alikes (`ABCD-2345`) | Joining that class. It identifies nobody and opens nothing else |
| Instructor key | A class is created (shown once) | `qi_` + 192 random bits | Reading that class's dashboard and deleting that class. Bound to that one class |
| Learner token | A learner first joins | `ql_` + 192 random bits | Being one anonymous learner: reporting that learner's events, leaving, rejoining. Sent only as the `X-Qentor-Learner` header, never in a URL |

Only the SHA-256 of a key or token is stored, compared in constant time. An unknown class and a wrong key get the same 403, and failed
instructor attempts are rate-limited per client address, so a key cannot be searched for or a class code probed. A learner appears to the
instructor only as an alias (`Learner 4F2A`, a one-way hash of an internal id), never as a token, id or address.

**Events.** The server records the minimum that is useful: joined class, started and completed a lesson, concept check submitted or corrected
(or brought from this browser's earlier answers), challenge started, solved or failed, experiment shared. A click is not an event. Most are
**derived by the server** from requests it already handles: grading a concept check records the check and its server verdict, judging a
challenge records solved or failed with the ids of the failed checks, sharing records a share. A browser may **claim** only `lesson_started`,
`lesson_completed` and `challenge_started`, as identifiers: the id is checked against the catalogs, and a lesson counts as finished only if
the server's own record shows the learner answered every concept check correctly. A replay is a no-op (unique on class, learner and a
dedupe key), a learner is capped at 5,000 events per class, and a malformed or unknown event is a structured refusal that echoes nothing.

**The dashboard** (`qentor/classroom/dashboard.py`) is computed only from those events, for learners who are in the class now: learners and
active learners (event in the last 7 days), lesson started / completed / still developing, concept-check correctness (latest answer per
learner and check), common misconceptions (concept-check categories, and the authored idea behind a failed challenge check), challenge attempts,
solves and where attempts fail, and recent activity by alias. Every group carries its sample size. With nobody in the class it returns an empty
view and the page says "No learners have joined this class yet."; no figure is padded, averaged or invented. A learner who leaves is no longer
in the aggregate (their rows are kept until retention or class deletion).

**Browser side.** `web/src/features/classroom/`: a store (`qentor.classroom.v1`, shape-checked on load), Join class with the code validated by
the server, a quiet class indicator in the top bar, Leave class (removes the membership only: the token is kept so rejoining is the same
learner, and no local progress is touched), Teach a class (create, copy the code and the one-time key, open the dashboard, delete). Joining can
count what the browser already did; the server grades each saved answer itself.

**Limits, stated plainly.**

- A token or key is a bearer secret: whoever holds it is that learner or that instructor. There is no recovery, no revocation (deleting the
  class is the instructor's only reset) and no second instructor. A learner who clears their browser data is a new anonymous learner.
- Rate limits are in memory, per process and per client address as the socket reports it. They reset on restart and are not shared between
  workers; behind a reverse proxy every client may share one address unless the proxy's headers are configured (not done here).
- Transport security is the deployment's job (HTTPS); nothing here encrypts traffic.
- Anonymous does not mean unobservable: an instructor of a very small class can often guess who an alias is. The dashboard says how many
  learners every figure is based on.
- Retention is `QENTOR_CLASSROOM_RETENTION_DAYS` (default 180) for events, applied at start; there is no export or per-learner erasure other
  than leaving and deleting the class.
- No class can be discovered or listed; a class is reachable only by its code, and its dashboard only by its key.

## 16. Read-only experiment sharing

"Share as a read-only page" (`POST /api/experiments`) stores an **immutable snapshot**; `GET /api/experiments/{id}` serves it at
`/shared/<id>`. It is collaboration by reading, not by editing: there is no real-time co-editing, no comment, no merge.

- **What a share holds:** the canonical circuit and its hash, the backend and mode, an optional lesson or challenge id (shown by its authored
  title), an optional title (plain text, 80 characters, control characters removed), and an optional result id.
- **What the page shows:** the circuit as a diagram, its OpenQASM 3 and the Qiskit/Cirq/PennyLane text the SERVER writes from the circuit
  (text only, never run), the backend and mode, and, if a run was attached, that run's stored provenance record through the same
  provenance-carrying components as a live result (sampled or theoretical labelling included). A shared run shows what the server stored; the
  sharer's browser contributes no number.
- **Rules the server enforces:** the request schema forbids extra fields (no `result`, `payload`, `provenance_class`, `verification_status`,
  owner, token or class); a run attaches only if it is a `STATE_CHECKED` record of exactly this circuit (hash match), and its backend, mode and
  shot count come from the record, not the request; lesson and challenge ids are checked against the catalogs; the circuit must be one the
  platform would run (limits); creation is rate-limited per client address.
- **Privacy:** the table has no owner column and the response model has no field for a learner token, a class, an address, a path or a key.
  Sharing while in a class records an `experiment_shared` event for the learner under their alias; the share itself carries nothing back to them.
- **Read-only by construction:** the page has no field or action that changes the snapshot, and the router has exactly one write (insert) and
  one read; there is no update, delete, list or search. If a stored circuit no longer validates it is not served; if the attached record is gone
  or no longer matches, the page says so and shows no result.
- **Fork into my Lab** copies the circuit into the visitor's own Lab in the browser (a deep copy, without any result) and sends nothing to the
  server; the shared page is unchanged. Editing the fork cannot affect it.

**Limits, stated plainly.** A shared page is public to anyone who has its address (an unguessable 64-bit id), and a share cannot be revoked or
expired from the product: it can only be removed from the database. There is no per-share access control and no listing, so a lost link is
lost. The attached provenance record stays in the provenance log as it always did.

## 17. Code input (the safe SDK-code reader)

"Import from code" in the Lab (Paste, Parse, Preview, Insert into Lab) reads OpenQASM 3, Qiskit, Cirq or PennyLane text into the canonical
circuit. **Python is never executed**: `circuit/sdk_parse.py` calls `ast.parse` (which parses, it does not run anything) and walks the tree
against an explicit allow-list. There is no `eval`, `exec`, `compile`, `__import__`, `getattr` or dynamic lookup in the module (a test reads the
module's own syntax tree to prove it) and none in the web app either (a test scans the source).

- **Documented subset.** Qiskit: `from qiskit import QuantumCircuit`, `qc = QuantumCircuit(n[, m])`, `qc.h/x/y/z/s/sdg/t/tdg/rx/ry/rz/cx/cz/cp/swap/ccx/
  measure/measure_all/barrier`. Cirq: `import cirq`, `LineQubit`, `cirq.Circuit(...)`, `circuit.append(...)`, the same gates as `cirq.H`, `cirq.CNOT`,
  `cirq.rx(θ)(q)`, `(cirq.S**-1)(q)`, `cirq.cphase`, `cirq.measure(q, key="c0")`. PennyLane: `qml.device("default.qubit", wires=n)`, one `def circuit():`
  (optionally `@qml.qnode(dev)`) of `qml.Hadamard`, `qml.CNOT`, `qml.RX(θ, wires=q)` and the like, ending in `return qml.state()` or
  `qml.probs/sample/counts(wires=...)`. Angles are numbers or expressions of numbers and `pi`; `pi` must be imported as Python requires. Qubits are
  integer literals. The full list is returned with every refusal and shown in the UI.
- **Refused, with the line:** loops, conditionals, functions (other than the one PennyLane circuit), classes, comprehensions, lambdas, f-strings,
  other imports, any call that is not a gate, attribute chains, keyword arguments in qubit positions, computed or negative indices, registers,
  parameters, other devices, unknown gates, wrong argument counts, an index outside the circuit. Up to five problems are listed; a program with any
  problem is refused whole, so nothing is skipped, guessed or silently translated.
- **Limits.** 20,000 characters, 600 lines, 30 levels of brackets, 500 operations, 16 qubits; deeply nested or pathological text is a refusal, not a
  crash. Notes say what the reader decided (`measure_all` adds classical bits as Qiskit does; a `barrier` has no effect and is not kept; a PennyLane
  `return qml.probs(wires=[...])` is read as measuring those wires).
- **Round trip.** Everything the server's own code generator writes for the shared fixtures, and for random circuits, is read back to the same
  circuit in all three SDKs.
- **No result and no insertion.** The endpoint returns the circuit, its OpenQASM 3, its hash and notes: never a number. The browser previews it,
  and nothing reaches the Lab until the learner confirms (a second step if it would replace an existing circuit). Parsing is rate-limited per client.
