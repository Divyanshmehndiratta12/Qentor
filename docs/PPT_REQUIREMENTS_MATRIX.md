# PPT Requirements Matrix

Every row is traceable to `docs/source/PPT_SOURCES.md`. "Deck pN" is the final submitted deck.
Draft-only promises are marked **(draft)** and are never P0 on their own authority.

The "Current status" column is the state of the code today (see `BUILD_STATE.md`). "Built" means it runs and has tests; "Partial" and "Not built" are stated plainly. Hardware (B7, R1-R4) is not built and the UI says so.

Priority: **P0** required for a convincing live demo · **P1** valuable if time remains · **P2** cut unless everything else is finished.
Demo importance: **Critical** (the story breaks without it) · **High** · **Medium** · **Low**.

## Learn

| # | Requirement | Source | Priority | Current status | Required backend | Verification method | Demo importance |
|---|---|---|---|---|---|---|---|
| L1 | Guided lesson per algorithm with short explainers and guided examples | Deck p2 (1 Learn), p3 step 1 | P0 | Built (18 lessons) | Content files + Aer for example circuits | Example circuits executed on load. No probability is written into lesson prose. A content test runs every lesson circuit. | High |
| L2 | Interactive visuals in lessons | Deck p3 step 1 | P0 | Built (trace, Bloch, charts) | Aer (statevector, per-step states) | Visuals render only backend results | High |
| L3 | Focused algorithm library that can grow | Deck p4 "Scalable product" | P0 (Bell primer, phase kickback, DJ, BV) · P1 (Grover-2) · P2 (QFT/QPE) | Built (Bell, kickback, DJ, BV, superdense coding, teleportation with deferred corrections, a fixed 2-qubit Grover, a fixed 3-qubit QFT, an exact fixed 4-qubit QPE, the three-qubit bit-flip code with a fixed injected error) | Aer | Each algorithm's reference solution passes its own test spec in CI | High |

## Build

| # | Requirement | Source | Priority | Current status | Required backend | Verification method | Demo importance |
|---|---|---|---|---|---|---|---|
| B1 | Visual circuit builder (canvas) | Deck p2 sol 2, p3 step 2 | P0 | Built | None (client) | Canvas writes only the canonical circuit model | Critical |
| B2 | Code editor synced with canvas | Deck p2 sol 2, p3 step 2 | P0 (OpenQASM 3 two-way) · P1 (restricted Qiskit subset parse, never executed) | Built (OpenQASM 3 two-way; Qiskit-subset parse not built) | Server QASM canonicaliser | Golden round-trip fixtures. IR to QASM to IR is identity. Client and server emitters produce identical text. | Critical |
| B3 | OpenQASM 3 as the common circuit format between stages | Deck p2 workflow, p3 arrows, p4 | P0 | Built | Server canonical emitter; Qiskit `qasm3` importer as an independent parser | Canonical QASM re-parsed by Qiskit's importer and compared by operator equivalence in tests | High |
| B4 | Run on Qiskit Aer | Deck p2 sol 2, p3, p4 | P0 | Built | qiskit-aer | Provenance record per run with Aer version | Critical |
| B5 | Run on Cirq | Deck p2 sol 2, p3, p4 | P0 | Built | cirq-core | Cross-backend agreement with Aer within 1e-6 on fixture circuits | High |
| B6 | Run on PennyLane | Deck p2 sol 2, p3, p4 | P0 (drops to P1 if install fails by hour 2) | Built | pennylane `default.qubit` | Cross-backend agreement with Aer within 1e-6 | Medium |
| B7 | Run on real hardware via IBM / qBraid | Deck p2 sol 2, p3 step 2, p4 "Hardware ready" | P0 as **recorded** runs (see R1) · P1 live IBM submission · P2 qBraid | Not built: hardware is shown as unavailable | qiskit-ibm-runtime (offline recording script) | Stored job id, device, timestamps, raw counts, circuit hash | Critical |
| B8 | Code export to Qiskit, Cirq, PennyLane | Deck p4 "Multi-SDK" | P0 read-only views · P1 CI test that executes generated code | Built (read-only views for all three SDKs) | Emitters | P1: generated code executed in CI and compared with the adapter result | Medium |

## Simulate and understand

| # | Requirement | Source | Priority | Current status | Required backend | Verification method | Demo importance |
|---|---|---|---|---|---|---|---|
| S1 | Statevector and probability display | Implied by Deck p3 step 2 and p3 charts | P0 | Built | Aer | Rendered only through the provenance-carrying value component | Critical |
| S2 | Plotly charts (histograms, expected vs actual) | Deck p3 tech stack | P0 | Built | Aer / recorded hardware | Chart data comes from a result id | High |
| S3 | Three.js 3D Bloch sphere | Deck p3 tech stack, p4 "WebGL/Three.js" | P0 (single-qubit reduced states) | Built (single-qubit sphere; one sphere per qubit, with purity, for a register) | Aer statevector, reduced density matrix on server | Bloch vector computed server-side, carries provenance | Medium |
| S4 | Gate-by-gate state stepping ("you can't inspect a qubit mid-run") | Deck p2 problem statement | P0 | Built (trace with first/previous/next/last) | Aer with per-step statevector saves | Each step is a backend snapshot | High |
| S5 | Lesson-scale simulation without cloud dependency | Deck p4 "Simulation" | P0 | Built (web fonts are the only third-party request) | Local Aer | Demo rehearsed with the network off | High |
| S6 | Stabilizer simulation for larger Clifford circuits | Deck p4 ("can use") | P2 | Not built | Aer `stabilizer` method | — | Low |

## Test

| # | Requirement | Source | Priority | Current status | Required backend | Verification method | Demo importance |
|---|---|---|---|---|---|---|---|
| T1 | Circuit tested on every valid input | Deck p2 sol 3·4, p3 step 3, p4 "Verification engine" | P0 | Partial (multi-input basis sweep with explicit cases) | Aer statevector (exact) | Exhaustive enumeration of the challenge's input space. Exact probabilities, tolerance 1e-9. | Critical |
| T2 | Failure returns a counterexample | Deck p2, p3 step 3 | P0 | Built (counterexamples) | Aer | First failing case returned with input, expected, actual and its own result id | Critical |
| T3 | Expected vs actual display | Deck p3 step 3 mock | P0 | Built | Aer | Both sides are backend results | High |
| T4 | 72 Deutsch–Jozsa oracles tested exhaustively and quickly | Deck p2 graphic (marked illustrative), Draft-Layered | P0 | Built as a library and tests (`verification/dj_family.py`): all 72 oracles run on Aer, reference passes 72 of 72, broken oracles and buggy algorithms fail. Not wired to a Lab button; the two oracle challenges still use one fixed oracle each | Aer | 2 constant + C(8,4) = 70 balanced oracles for n=3. The count is asserted in a unit test. | Critical |
| T5 | Misconception tag with the counterexample | Draft-Tech; Deck p3 step 6 "find misconceptions" | P0 | Partial (concept-check misconception signals) | Deterministic rules over the test report | Rule unit tests on known-buggy circuits | High |
| T6 | Property-based tests of the verifier itself | Draft-Tech | P1 | Not built | pytest + hypothesis | Random circuits: optimiser output always equivalent; emit/parse round-trip | Medium |

## Optimize

| # | Requirement | Source | Priority | Current status | Required backend | Verification method | Demo importance |
|---|---|---|---|---|---|---|---|
| O1 | Optimizer suggests shorter circuits | Deck p2, p3 step 4 | P0 | Built | Rule engine (server) | Gate count, depth and two-qubit count computed from the model | Critical |
| O2 | Optimized circuit verified equivalent | Deck p2, p3, p4 | P0 | Built | qiskit `quantum_info.Operator` | Operator equivalence up to global phase, per proposal, at runtime. Distinguishing input returned when not equivalent. | Critical |
| O3 | Each rewrite explained | Draft-Tech | P0 | Built | Rule engine | Each step names its rule. The explanation is templated from the rule, not generated. | High |
| O4 | Qiskit transpiler as a second proposal source | Draft-Tech (Qiskit tooling) | P1 | Not built | Qiskit transpiler | Same equivalence gate | Low |

## Reality check

| # | Requirement | Source | Priority | Current status | Required backend | Verification method | Demo importance |
|---|---|---|---|---|---|---|---|
| R1 | Simulation beside recorded real-device runs | Deck p2 sol 5, p3 step 5, p4 | P0 | Not built: no recorded hardware run exists | Recorded IBM runs (read-only JSON) + Aer | Match by exact circuit hash. Show job id, device, date. TVD and Hellinger fidelity computed server-side. | Critical |
| R2 | Show "what noise does" (the noise gap) | Deck p2 workflow, p5 | P0 | Not built | Aer + recorded runs | Highlight probability mass on outcomes the ideal result forbids | High |
| R3 | Recorded run of *the same circuit* | Draft-Tech | P0 | Not built | Hash lookup | If the hash differs, say so. An equivalent reference circuit is shown only with an "equivalent, not identical" label. | High |
| R4 | Dataset of circuits, results and real-device runs | Deck p6 | P1 | Not built | Export of recorded runs + provenance log | Files carry a SHA-256 manifest | Low |

## AI tutor

| # | Requirement | Source | Priority | Current status | Required backend | Verification method | Demo importance |
|---|---|---|---|---|---|---|---|
| A1 | Tutor explains concepts | Deck p2 sol 1, Draft-Layered | P0 | Built (guarded, deterministic fallback) | LLM API + fact sheet | Output schema validation and numeric guard | Critical |
| A2 | Tutor debugs the learner's circuit | Deck p2 sol 1, p5 | P0 | Built (Debug my circuit; trace-step tutor) | LLM + test report + step trace | Explanation references counterexample result ids only | Critical |
| A3 | Every circuit or number the tutor states is re-simulated before display | Deck p2 sol 1, p5 "re-simulates every claim" | P0 | Partial (claim guard against facts; no re-simulation of typed claims) | Aer + verification layer | Typed claims re-executed. Mismatches dropped and counted. Candidate circuits run through the full test spec. | Critical |
| A4 | Model-agnostic LLM via API | Draft-Tech | P0 (adapter interface) | Built (adapter; Anthropic default, off unless configured) | Anthropic API as default adapter | Adapter contract tests with a fake model | Low |
| A5 | Retrieval over SDK docs and course notes | Draft-Tech | P2 | Not built | — | — | Low |

## Reflect

| # | Requirement | Source | Priority | Current status | Required backend | Verification method | Demo importance |
|---|---|---|---|---|---|---|---|
| F1 | Progress tracking and mastery display | Deck p2 (6 Reflect), p3 step 6 | P0 | Built (browser-local, versioned) | SQLite + local storage | Mastery changes only on verified test events | High |
| F2 | Misconception detection over time | Deck p3 step 6, p5 | P0 (per attempt) · P1 (history view) | Built (per attempt) | Rules over test reports | Rule unit tests | Medium |
| F3 | Personalized path / next challenge | Deck p2 "next challenge", p3, p5 | P0 (rule-based) | Built (rule-based, with evidence) | Learning engine | Deterministic recommender unit tests | Medium |
| F4 | Instructor misconception dashboards | Draft-Layered only | P2 | Built for anonymous classes (Sprint 5): class code, one-time instructor key, server-derived events, aggregate misconceptions with sample sizes; no accounts, no cohort data invented | SQLite aggregate | `tests/test_classroom.py` | Low |

## Platform

| # | Requirement | Source | Priority | Current status | Required backend | Verification method | Demo importance |
|---|---|---|---|---|---|---|---|
| PL1 | React + TypeScript browser app | Deck p3, p4 | P0 | Built (served by FastAPI, deep links) | Vite build served by FastAPI | — | High |
| PL2 | Python API tier (FastAPI) | Draft-Tech; Deck p4 pipeline needs a Python simulator tier | P0 | Built | FastAPI | — | Medium |
| PL3 | Docker deployment | Draft-Tech | P1 | Partial (Dockerfile written; image not built here) | Dockerfile | Container smoke test | Medium |
| PL4 | Public demo link and repo link | Deck p6 | P1 | Not done (no public URL) | Hosted container | — | Medium |
| PL5 | PostgreSQL | Draft-Tech only | Not building (SQLite) | Not building (SQLite) | — | — | Low |
| PL6 | WebSockets and background queue for hardware jobs | Draft-Tech only | P2 | Not built | — | — | Low |
| PL7 | Installable low-bandwidth web app | Draft-Tech only | P2 | Not built | — | — | Low |

## Requested by the owner but not in the PPT

| # | Requirement | Source | Priority | Note |
|---|---|---|---|---|
| X1 | Backend provenance on every result | Owner brief §7 | P0 | Makes Deck p2 sol 1 and the hardware claim checkable. |
| X2 | Multilingual educational content, Hindi first | Owner brief §9 | P1 | Not promised in the deck. Use i18n string keys from day one so it stays cheap. |
| X3 | Noise-model simulation for circuits without a recorded run | Supports Deck p2 sol 5 | P1 | Must be labelled SIMULATION · NOISE MODEL, never hardware. |

## Built beyond the deck (added in the final sprint)

| # | Capability | Status | Where the trust rule is enforced |
|---|---|---|---|
| E1 | Challenge system: fourteen backend-owned challenges, server-side deterministic verdicts, structured feedback, deterministic hints | Built | `challenges/evaluate.py`; no LLM in any verdict (import-graph and no-call tests) |
| E2 | Fixed Deutsch-Jozsa and Bernstein-Vazirani challenges (one oracle each, no synthesis) | Built | Anchor check requires the oracle exactly, once, in order |
| E3 | "Debug my circuit": observed / evidence / mismatch / next experiment / hint | Built | `tutor/debugger.py`: evidence and hint never model output; claim guard plus verdict-consistency check |
| E4 | Experiment comparison (circuit diff, measurement difference, state difference) and "Ask Tutor about this difference" | Built | `verification/experiment_compare.py`; comparison stored as a provenance record |
| E5 | Deterministic, evidence-carrying recommendation | Built | `web/src/features/learn/recommendation.ts` (fixed rules; says no AI) |
| E6 | Sampled vs theoretical labelling on every chart | Built | Kind badge on each chart; backend supplies theoretical probabilities |
| E7 | Learner report on Progress (challenge completion, recent activity) | Built (one learner, this browser) | States that no cohort data exists |
| E8 | Share link and export bundle | Built | Link carries the circuit only; bundle has run metadata, no results, nothing of the server's |
| E9 | Read-only experiment page with "Fork into my Lab" (collaboration by reading; no real-time co-editing). **Not in PPT** | Built | `api/sharing.py`: the request has no field for a number or a verdict, a run attaches only if it is a checked run of exactly this circuit, no owner column; the page reads stored records |
| E10 | Import a circuit from OpenQASM 3, Qiskit, Cirq or PennyLane code. **Not in PPT** | Built (a documented subset) | `circuit/sdk_parse.py`: `ast.parse` and an allow-list, no execution anywhere (a test reads the module's syntax tree); unsupported code is refused with its line |
