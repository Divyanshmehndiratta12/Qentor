# Verification Architecture

This document defines how Qentor guarantees that no quantum result shown to a learner was
invented by the LLM or by the frontend. It is the engineering form of the deck's promise:
"every circuit or number it states is re-simulated before you see it" (Deck p2).

## 1. Trust boundary

```
TRUSTED (may create quantum facts)            UNTRUSTED (may only reference facts)
─────────────────────────────────             ─────────────────────────────────────
execution/  Aer, Cirq, PennyLane adapters     LLM output
execution/  recorded-hardware loader          browser / client payloads
verification/ harness, equivalence, optimiser lesson prose
                                              learner input
        │ writes                                     │ reads by result_id only
        ▼                                            ▼
   provenance log (SQLite `results`)  ◄────── tutor fact builder
```

Only modules on the left can create a `QuantumResult`. Everything on the right can hold a
`result_id` and ask the server what it points to.

## 2. The five enforcement mechanisms

The invariant is enforced in code at five points. Each one would catch a fabricated number on
its own.

1. **No write path.** The tutor module has no import of the provenance writer. A unit test imports the tutor package and asserts that the writer is not reachable from it. The API has no endpoint that accepts a probability, count, fidelity or verdict from the client.
2. **Reference, not value.** The client sends result ids to the tutor. The server loads the values from its own log. A forged number in a client request has nowhere to go.
3. **Output guard.** LLM text is scanned. Decimals, percentages, fractions, amplitudes, ket coefficients, counts, and verdict words ("equivalent", "passes", "correct", "fidelity") are rejected unless they are a fact reference or backed by a verification report in the context. See `AI_BOUNDARY.md` §4.
4. **Re-simulation of claims.** Any typed claim the LLM makes (for example "P(00) = 0.5 for circuit X") is executed on Aer. Only matching claims are displayed, rendered from the backend value. Mismatches are dropped and counted in the UI as "AI claims rejected by the simulator".
5. **Typed rendering.** The frontend renders quantum numbers only through `VerifiedValue`, which requires a provenance object. A frontend test fails if a component renders a raw probability field outside it.

## 3. Provenance record

Every execution or verification produces one record.

```json
{
  "result_id": "res_01J…",
  "kind": "execution | test_report | equivalence_report | optimisation | hardware_comparison",
  "circuit_hash": "qc_3f9a1c0b7e21",
  "qasm3": "OPENQASM 3.0; …",
  "backend": {"name": "qiskit-aer", "version": "x.y.z", "provider": "local"},
  "provenance_class": "SIMULATION | REAL_HARDWARE | RECORDED_HARDWARE",
  "execution_mode": "statevector | shots | steps | unitary",
  "shots": null,
  "seed": 1234,
  "execution_id": "aer-… | ibm job id",
  "created_at": "2026-09-28T10:15:00Z",
  "verification_status": "VERIFIED | FAILED | NOT_EQUIVALENT | UNVERIFIABLE | ERROR",
  "hardware": {
    "device": "ibm_…",
    "job_id": "…",
    "submitted_at": "…",
    "completed_at": "…",
    "transpiled_qasm3": "…",
    "qubit_layout": [0, 1],
    "calibration_note": "optional"
  },
  "payload": {"probabilities": {"00": 0.5, "11": 0.5}}
}
```

UI classes, shown as a badge on every result:

| Class | Meaning | Badge |
|---|---|---|
| SIMULATION | Computed now by a named simulator | "Simulated · Qiskit Aer 0.x" |
| REAL_HARDWARE | Returned now by a live IBM job (P1) | "Real hardware · ibm_x · job …" |
| RECORDED_HARDWARE | Stored result of a past IBM job | "Recorded hardware · ibm_x · job … · date" |

A noise-model run (P1) is SIMULATION with mode detail "noise model". It is never styled like hardware.

## 4. Verification kinds

### 4.1 Execution
Statevector, probabilities, counts and per-step states from an adapter.

**What an execution's status means (as built).** Three different things used to share the word
"verified", and only the last says anything about a circuit:

| | Meaning | Recorded as |
|---|---|---|
| 1 | the backend ran | (a run that raised is `ERROR`, HTTP 400/503) |
| 2 | what it returned is a well-formed result | `STATE_CHECKED` (`qentor/execution/sanity.py`) |
| 3 | the circuit has a property, or two circuits agree | a **verifier's** verdict: `VERIFIED` / `FAILED` / `UNVERIFIABLE` (Bell check, multi-input test, equivalence check, `VERIFIED_SHORTER`) |

`STATE_CHECKED` requires: a statevector of length 2**n with finite entries and squared norm 1 within
1e-9; probabilities in [0, 1] summing to 1 within 1e-9; counts that are non-negative integers adding up
to the requested shots. A result that fails is stored as `FAILED` with the reasons and none of its
numbers, and the request is refused with `502 EXECUTION_STATE_INVALID`: a malformed state is never shown,
explained or built on. `SUCCEEDED` exists only to read rows written before state checks existed (they
were stored as `VERIFIED`); nothing writes it and it is not treated as usable.

The word "verified" is reserved for (3). A successful simulation is described everywhere (API facts, the
tutor, the UI tooltip and trace row) as "state checked: the backend ran and returned a well-formed result;
this does not show the circuit does what you intend". The wire field is still called `verification_status`.

**Request limits (as built; `qentor/execution/limits.py`).** Checked before any backend allocates memory;
an over-limit request is `422` with `{code, message, limit, requested, backend}` and no partial run.

| Limit | Value |
|---|---|
| qubits, Qiskit Aer | 16 |
| qubits, Cirq | 14 |
| qubits, PennyLane | 14 |
| operations per request | 500 |
| shots per request | 100000 |
| qubits, equivalence check (optimizer) | 10 (also enforced inside `check_equivalence`, which returns `UNVERIFIABLE`) |
| qubits, trace / multi-input inputs | 8 (`MAX_SWEEP_QUBITS`, unchanged; the backend limits above also apply) |

Execute, trace, multi-input test and optimize all enforce them.

**Per-step trace (`POST /api/execute/trace`, `qentor/execution/trace.py`).** The state after
operation *k* is the backend's own statevector for the circuit truncated after operation *k*, so a
trace is `N + 1` ordinary statevector-mode `adapter.run` calls (the empty circuit, then each
operation) — the same path `/api/execute` uses, not a second simulator. The trace code never
computes, rescales or interpolates an amplitude; a test proves it forwards exactly what a backend
returned.

- Each step is persisted as an ordinary provenance record (`SIMULATION`, `statevector` mode) whose
  `circuit_hash` is that step's own prefix circuit, so it is retrievable and usable like any
  execution. The last step is the record `/api/execute` would have written for the same circuit.
  `VERIFIED` here means only what it means in §4.1 (the backend ran and the state's norm is within
  1e-9 of 1); the trace makes no claim that the circuit is correct or equivalent to anything.
- Only `statevector` mode can be traced. `shots` is refused (`TRACE_MODE_UNSUPPORTED`); no per-step
  data is invented for sampled counts. Aer, Cirq and PennyLane all support it; a backend that cannot
  run (503) or returns no/invalid state (502) is reported as such.
- Terminal `measure` ops are stripped and listed (`terminal_measurements`), because a measurement left
  in the circuit makes Aer collapse the state at random. A measurement followed by gates is refused
  (`TRACE_MID_CIRCUIT_MEASUREMENT`).
- Limits reuse the harness's: `MAX_SWEEP_QUBITS` qubits (a full statevector per step) and
  `MAX_TEST_CASES` backend runs per request (`operations + 1`).
- Errors are structured: `detail = {"code", "message"}`.
- **Bloch vectors (`bloch_vector` on a trace step, `qentor/execution/bloch.py`).** For a
  single-qubit circuit each step also carries `(x, y, z)` — derived by the backend from that
  step's own validated, backend-produced statevector, `|ψ⟩ = α|0⟩ + β|1⟩`:
  `x = 2 Re(ᾱβ)`, `y = 2 Im(ᾱβ)`, `z = |α|² − |β|²`. The frontend never calculates them.
  - It is a *derived view of one backend state*, not a circuit-correctness verdict: it carries no
    verification status. Its `derived_from` block names the exact source — step index, `result_id`,
    `execution_id`, the step's prefix `circuit_hash`, backend and version — so it cannot be detached
    from the state it came from. Only the statevector is used as input (no gate names, no textbook
    answers), values are not rounded, and global phase has no effect (relative phase does).
  - A multi-qubit step has `bloch_vector = null`. A Bloch vector describes a single qubit; an
    entangled register (e.g. a Bell state) has no pure state per qubit — each qubit alone is
    maximally mixed — so one 3-vector for the whole register would hide the correlations that make
    it entangled. There is no per-qubit reduced-state abstraction yet, so nothing is invented, not
    even for unentangled multi-qubit states.

### 4.2 Multi-input test harness
A challenge declares a spec. All checks use exact Aer statevector probabilities (no sampling),
tolerance 1e-9.

| Spec kind | Inputs enumerated | Pass condition | Counterexample |
|---|---|---|---|
| `basis-sweep` | Every basis input on the declared input qubits, via X gates prepended | Output is the expected basis state with probability 1 | The first input, expected output and actual distribution |
| `oracle-slot` | Every oracle in a declared family, substituted into the `oracle` slot | The algorithm's decision is correct with probability 1 | Oracle index, truth table and measured distribution |
| `state-prep` | The single declared input | Fidelity with target ≥ 1 − 1e-9, ignoring global phase | The state difference |
| `unitary-match` | All inputs, implicitly | Operator equivalence with the reference (§4.3) | Distinguishing input |

**Deutsch–Jozsa family for n=3:** 2 constant functions plus C(8,4) = 70 balanced functions gives
72 oracles. Each is built as a bit-flip oracle from multi-controlled X gates. A unit test asserts
the count and that the reference solution passes all 72.

**Bernstein–Vazirani, n=3:** all 8 secret strings. Pass means the measured string equals the secret with probability 1.

**Oracle correctness beyond basis states.** A basis sweep checks the classical truth table. It
cannot see a wrong relative phase, such as a stray Z. Function-oracle challenges therefore run a
`unitary-match` against the reference oracle as well. The basis sweep supplies the readable
counterexample; the operator check supplies the verdict.

**Scale.** Exhaustive testing is exponential in input size. The library keeps inputs at n ≤ 5,
which runs in well under a second on Aer. Larger specs are refused rather than sampled
silently.

Each failing case is stored as its own result, so the UI can open a gate-by-gate trace of exactly
that input.

### 4.3 Equivalence checker
1. Reject if either circuit contains mid-circuit measurement, reset or classical control: **UNVERIFIABLE**, with the reason.
2. Strip terminal measurements and barriers. Require the same qubit count.
3. Build both operators with Qiskit `Operator`. Equivalent when `U_b = e^{iφ} U_a` within 1e-9. Record φ.
4. If not equivalent, find a distinguishing input:
   - First, basis inputs: the first column where output states differ (fidelity < 1 − 1e-9).
   - If every column matches up to its own phase, the circuits differ in relative phase. Return (|i⟩ + |j⟩)/√2 for two columns whose phases differ.
5. Report: status, method, global phase, distinguishing input, and the output states of both circuits for that input as result ids.

### 4.4 Optimiser
- P0 rules: remove identity gates and zero-angle rotations; cancel adjacent self-inverse pairs (H·H, X·X, CX·CX on the same qubits, SWAP·SWAP); cancel inverse pairs (S·Sdg, T·Tdg); merge same-axis rotations; commute past gates on disjoint qubits to expose cancellations.
- Each applied rule is logged with its name, the ops it touched and a templated explanation.
- The final proposal and every intermediate step go through §4.3. Only EQUIVALENT proposals are shown as "Verified shorter". Anything else is discarded and logged as a verifier-caught bug.
- P1: Qiskit transpiler output as a second proposal source through the same gate.
- AI-proposed optimisations use exactly the same gate.

### 4.5 Hardware comparison
- Input: a circuit hash.
- If a recorded run has that exact hash, compute ideal probabilities on Aer and compare with the recorded counts: total variation distance, Hellinger fidelity, and the probability mass on outcomes the ideal result gives zero probability.
- If no run has that hash, the answer is "no recorded run". A verified-equivalent library circuit may be offered with the label "Equivalent reference circuit, not identical. Hardware noise depends on the exact gates."
- Recorded files are loaded read-only and checked against `MANIFEST.sha256` at startup. A mismatch disables the file and logs an error.
- No code path writes to `server/data/hardware_runs/` except `scripts/record_hardware.py`, which only runs with a real IBM token.

### 4.6 Cross-backend agreement
The same circuit runs on Aer, Cirq and PennyLane. The report lists each backend's version, the
largest probability difference, and pairwise state fidelity. Agreement threshold is 1e-6. A
disagreement is shown, not hidden. It usually means a bit-order bug.

## 5. Frontend contract

- `QuantumValue<T>` = `{ value: T, provenance: Provenance }`. The only way to obtain one is to parse an API response with its zod schema.
- `VerifiedValue` renders a number with its badge and a tooltip showing hash, backend, mode, execution id and time.
- Charts accept `QuantumValue<Distribution>` only.
- Pass/fail and equivalence verdicts are rendered from report objects, never from tutor text.
- Mock or placeholder data is forbidden in shipped components. A story or test fixture must be labelled FIXTURE in the UI if ever rendered.

## 6. Tests that protect the invariant

| Test | What it proves |
|---|---|
| Golden fixtures: model ↔ QASM on client and server | One canonical circuit format |
| Qiskit `qasm3` import of our QASM equals our model's operator | The emitter is correct by an independent parser |
| Cross-backend agreement on about 20 fixture circuits | Adapters and bit order are correct |
| Harness: every reference solution passes; known-buggy circuits fail with the expected counterexample | The test harness works |
| DJ family has exactly 72 oracles | The headline number is real |
| Equivalence: known equal pairs, global-phase pairs, relative-phase-only pairs, unequal pairs | The checker is sound in the tricky cases |
| Optimiser property test on random circuits (P1 hypothesis) | Rewrites never change the operator |
| Tutor with a fake LLM that invents numbers, verdicts and a wrong circuit | The guard rejects them and nothing unverified renders |
| Import-graph test: tutor cannot reach the provenance writer | No write path from AI to results |
| Manifest check on recorded hardware files | Recorded runs are untampered |
