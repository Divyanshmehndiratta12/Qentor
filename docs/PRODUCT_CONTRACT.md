# Qentor — Product Contract

SIH 2026 · Problem statement SIH26140 · AI-Based Interactive Quantum Algorithm Learning Platform.
Source of promises: the idea deck submitted for SIH26140.

## 1. One-sentence product

Qentor teaches quantum algorithms by letting a learner build a circuit, run it on real quantum
software backends, test it on every valid input, optimise it with verified-equivalent rewrites,
compare it with a recorded real-hardware run, and get AI explanations that are only ever about
results the backends actually produced.

The deck's title is the contract: **"Learn Quantum Algorithms by Testing, Optimizing and Verifying Circuits."**

## 2. The problem we promised to solve (Deck p2)

1. A wrong quantum circuit still runs and still returns an answer.
2. A learner cannot inspect a qubit mid-run, so a plausible histogram hides the bug.
3. AI tutors make it worse by confidently stating wrong circuits and numbers.

Every P0 feature must attack at least one of these three.

## 3. The invariant

> **The LLM is not the quantum computer.**

Every quantum fact shown to a learner (statevector, probability, count, expectation value,
fidelity, equivalence verdict, pass/fail, counterexample, hardware result, optimisation result)
comes from an execution or verification backend and carries provenance. The AI may explain,
hint and propose. A proposal is shown as VERIFIED only after the verification layer checks it.

This is enforced by architecture, not by prompt wording. See `VERIFICATION_ARCHITECTURE.md` and
`AI_BOUNDARY.md`.

## 4. The learning loop

The deck defines six stages. The owner's eight-stage brief maps onto them as follows.

| Owner stage | Deck stage | What the learner does | What makes it trustworthy |
|---|---|---|---|
| LEARN | 1 Learn | Reads a short guided lesson with a live example circuit | Example numbers are executed, not written into prose |
| BUILD | 2 Build | Builds on a canvas or in OpenQASM 3; both stay in sync | One canonical circuit model |
| SIMULATE | 2 Build (run) | Runs on Qiskit Aer, Cirq or PennyLane | Real SDK execution with provenance |
| UNDERSTAND | 1 Learn + 3 Test | Steps through the state gate by gate; asks the tutor | Step states come from the backend; tutor sees only verified facts |
| TEST | 3 Test | Circuit is checked on every valid input | Exhaustive, deterministic, counterexample on failure |
| OPTIMIZE | 4 Optimize | Accepts shorter circuits | Each proposal is operator-equivalence checked |
| REALITY CHECK | 5 Reality-check | Compares ideal simulation with a recorded IBM run | Recorded runs carry job id, device, timestamp |
| REFLECT | 6 Reflect | Sees mastery, misconceptions and the next challenge | Mastery updates only from verified test outcomes |

## 5. Users

- **Primary:** undergraduate learners in Indian colleges meeting quantum algorithms for the first time, with no lab access.
- **Secondary:** instructors. The deck mentions misconception tracking for learners (Deck p3). Instructor dashboards appear only in a draft slide, so they are P2; the anonymous class dashboard exists (no accounts, no personal data; `ARCHITECTURE.md` §15).
- **Demo user:** an SIH judge who will try to break the AI and will ask whether hardware results are real.

## 6. Scope

### In scope for the 48-hour build
- Guided lessons for a focused algorithm library: Bell/superposition primer, phase kickback, Deutsch–Jozsa, Bernstein–Vazirani. Superdense coding, teleportation (deferred corrections) and a fixed 2-qubit Grover were added in Sprint 2 as small fixed examples; none is a scalable algorithm. Sprint 4 added the Quantum Fourier Transform, Quantum Phase Estimation (an exact fixed example, stated as such) and the three-qubit bit-flip code (a fixed injected error, stated not to be a noise model), again as small fixed educational examples with a backend-owned challenge each.
- Canvas circuit builder synced two-way with an OpenQASM 3 editor. Read-only Qiskit, Cirq and PennyLane code views.
- Execution on Qiskit Aer (primary), Cirq and PennyLane, with a cross-backend agreement view.
- Gate-by-gate state stepping, probability charts (Plotly) and a Bloch sphere (Three.js).
- Exhaustive multi-input testing with counterexamples, including the 72 Deutsch–Jozsa oracles for n=3.
- Operator-equivalence checking with a distinguishing input when circuits differ.
- Rule-based optimiser whose every proposal is equivalence-checked and explained.
- Recorded real-hardware library: circuits run by the team on IBM Quantum before the demo, stored with job metadata.
- Grounded AI tutor with a deterministic no-AI fallback.
- Mastery, misconception tags and next-challenge recommendation.
- Provenance on every displayed quantum number.

### Out of scope (see §8)
Accounts, native mobile apps, microservices, Redis, Kubernetes, PostgreSQL, WebSockets, job queues,
a 3D avatar, voice, leaderboards, arbitrary Python execution.

## 7. What "done" means for the live demo

The hero path must run end to end, on the demo laptop, with the network unplugged except for the
optional LLM call:

1. Open the Deutsch–Jozsa lesson. The example circuit's probabilities appear with a SIMULATION badge.
2. Build a DJ circuit with a deliberate bug on the canvas. The QASM editor updates live.
3. Run it on Aer, then open the cross-backend view. Cirq and PennyLane agree within tolerance.
4. Press Test. The harness runs all 72 oracles and reports, for example, "70 of 72 pass". The first failing oracle is shown as a counterexample.
5. Trace the counterexample gate by gate. The tutor explains the failure using only verified facts. A misconception tag appears.
6. Ask the tutor for a fix. Its candidate circuit is tested. It is shown as VERIFIED only if all 72 pass. A rejected AI claim is visibly counted.
7. Fix the circuit. All 72 pass.
8. Press Optimize. A shorter circuit is proposed, verified equivalent, and each rewrite is explained.
9. Open Reality-check. The ideal distribution sits beside a RECORDED HARDWARE run of the same circuit hash, with device name, job id and date.
10. Reflect shows the mastery update and recommends Bernstein–Vazirani.

Numbers in step 4 are whatever the backend returns for the circuit actually built. The deck's
"71 of 72" graphic is marked illustrative and must never be hard-coded.

## 8. Explicit non-goals and why

| Not building | Reason |
|---|---|
| Accounts / login | No requirement in the deck. An anonymous learner id in local storage is enough. |
| PostgreSQL | Only in a draft slide. SQLite in one file does the job for one server. |
| WebSockets, background job queue | Only in a draft slide. Live hardware is P1 and polls over plain HTTP. |
| Live hardware as the demo path | Queue times are unpredictable. The deck promises *recorded* runs (Deck p2, p3, p4). |
| Simulated "hardware" | Forbidden. A noise-model simulation (built as the Noise Lab, `NOISE_LAB.md`) is labelled SIMULATION, "Simulated noise". |
| Executing learner or AI Python | Remote code execution risk. Code enters only as OpenQASM 3 parsed into the canonical model. |
| Retrieval over SDK docs | Only in a draft slide. P2. |
| Stabilizer simulation for large Clifford circuits | Deck p4 says "can use". Lesson circuits do not need it. P2. |
| qBraid integration | IBM Quantum alone satisfies "qBraid / IBM". P2. |
| Multilingual content | Not promised in the deck. A Hindi option is a P1 differentiator, labelled as such. |

## 9. Change control

Any requirement not traceable to the submitted idea deck is labelled "not in PPT" wherever
it appears, and cannot displace a P0 item.
