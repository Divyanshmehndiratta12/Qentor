# Quantum reasoning engine

A server-side analysis layer above execution, trace, optimisation and comparison. It accepts a **structured intent** plus circuit and
result context the server already holds, and returns **structured facts computed by the execution and verification layers**. A language
model is never its authority: the model, when one is configured, may only restate facts after the claim guard accepts it.

Code: `backend/qentor/reasoning/` (the engine), `backend/qentor/api/reasoning.py` (HTTP, provenance, tutor hand-off),
`backend/qentor/tutor/reasoning_facts.py` (`R#` facts and answers), `backend/qentor/tutor/intents.py` (English, Hindi and Kannada routing).
Frontend: `web/src/features/tutor/ReasoningActions.tsx`, `ReasoningCard.tsx`.

## Position in the dependency order

`api → tutor → reasoning → verification → execution → circuit`. The engine imports `circuit`, `execution` and `verification`; never
`qentor.tutor`, the provenance store, the attempt log or the API (an import-graph test pins this and that it executes no code). It takes
already-fetched `ProvenanceRecord`s and an injected `runner` (a recorded statevector run), exactly like the multi-input harness. The API
layer fetches and verifies the records and writes each analysis as **one more provenance record** (`backend = reasoning-engine`,
`execution_mode = analysis`, `SIMULATION`); the tutor then reads that record's payload back as `R#` facts, so the tutor "receives result ids
and reads facts from the provenance log" like everywhere else.

## Intents

`POST /api/reasoning/analyze` takes a request discriminated by `intent`. Every request model forbids extra fields and none has a field for a
probability, an expected optimisation, a counterfactual circuit or a verdict. Every request may carry `expected_circuit_hash` (the hash the
client was shown): a different hash is `409 REASONING_STALE_CIRCUIT`.

| Intent | Request | What the server does | Result |
|---|---|---|---|
| `PROBABILITY` | circuit, `result_id`, target (`basis_state`, `qubit_value`, `each_qubit_value`, `most_likely`, `sampled_vs_theoretical`) | Reads `|amplitude|²` from the backend's statevector (the learner's own run when it is a clean state; otherwise a recorded statevector run of the circuit without its terminal measurements) and `count/shots` from a shots run | Theoretical probability, sampled frequency beside it, difference; ties reported, never chosen; bit order stated |
| `OPTIMIZE` | circuit | `verification.optimizer` + `verification.equivalence` | Original, candidate, operation counts, rewrite sentences, equivalence verdict, candidate provenance; or an explicit `NO_IMPROVEMENT` with the reason and **no** candidate circuit |
| `WHAT_IF` | circuit, ONE modification, optional hashes from the preview | Validates, builds the counterfactual canonical circuit, hashes it, runs both circuits' states, compares with `experiment_compare` | Description, both hashes, counts, diff, equivalence, probability and state differences |
| `TRACE_CHANGE` | circuit, trace-step identity | Verifies the step against the circuit and the stored records, then derives before / operation / after from the two backend states | Probability changes, per-qubit reduced states (Bloch vector, purity, entangled-with-rest), change kind; `INITIAL_STATE` for step 0 |
| `COMPARE` | two circuits, two result ids | The existing comparison (`/api/compare/experiments`), stored as the comparison record | Circuit, measurement and state difference; both runs named |
| `DEBUG` | circuit, `result_id` (+ optional attempt, step, goal) | The deterministic debugger, given the engine's evidence | The debugger's report plus the analysis (most likely outcomes, a verified shorter circuit or none, idle qubits, no measurement) |

`POST /api/reasoning/what-if/preview` returns the counterfactual circuit (operations, diff, OpenQASM, hash) **without running anything or storing
anything**: it is what the learner sees before confirming. `POST /api/debug` also gains `engine_evidence` and `analysis_id`; the report's own
sections are unchanged (a test pins that).

### What-if is a closed set

One modification of: `remove_gate`, `replace_gate` (a one-qubit gate for another, `cx` for `cz`, a rotation keeps its angle),
`set_angle` (rx, ry, rz, cp), `insert_gate` (any gate but `measure`). There is no code, no expression, no list of operations. Limits:
**8 qubits and 64 operations** (original and counterfactual), angles within ±8π, positions at most 1000; a gate after a measurement is refused;
a change that changes nothing is refused. Exactly two statevector runs are made per what-if.

## Provenance

Each response carries `sources`: every backend run the analysis rests on (role, result id, execution id, circuit hash, backend and version,
mode, provenance class, status), and the analysis record's own provenance. In the browser every number is a `QuantumValue` with that
provenance and renders only through `VerifiedValueInline`. An analysis built on a failed run is `FAILED`, not `STATE_CHECKED`.

## Tutor routing (English, Hindi, Kannada)

`tutor/intents.py` is a fixed table of phrases per intent and language (not NLP). The same question in the three languages maps to one
intent: "What is the probability of 1?", "1 आने की संभावना कितनी है?", "1 ಬರುವ ಸಾಧ್ಯತೆ ಎಷ್ಟು?". Precedence: what-if, debug, a sampled-versus-
theoretical probability, optimise, compare, trace change, probability. A question that matches nothing, or whose context is missing, is
answered exactly as before. An English "what changed in this step" stays with the step tutor. A typed what-if or compare question points at the
controls (it names no structured input); nothing is computed from its words. The answer language only chooses the wrapper text.

## What the model may and may not do here

It may restate `R#` facts in its own words if every number, bitstring and verdict word is already in a fact (the existing claim guard); the
deterministic answer quotes the facts. It may not declare equivalence, state a probability, invent a candidate or comparison, or see a number
from a client. Tests give it a fake model that does each of those and require the fallback.

## Not built

No hardware analysis (a recorded or live run is refused: only simulations are analysed). No noise model. No free-text what-if
(the modification is a form, on purpose). No multi-step counterfactuals. Trace analysis is limited to the trace's own 8 qubits.
