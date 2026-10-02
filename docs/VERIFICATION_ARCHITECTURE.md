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
    it entangled. What a register does have is a reduced state per qubit, below.
- **Per-qubit reduced states (`qubit_states` on a trace step, `qentor/execution/reduced_state.py`).**
  Every step, of every circuit, carries one entry per qubit (`q[0]` first): the 2×2 density matrix
  left after tracing out every other qubit, `ρ[a][b] = Σ_rest ψ[a,rest]·conj(ψ[b,rest])`, reported as
  its Bloch vector `x = 2 Re ρ01`, `y = −2 Im ρ01`, `z = ρ00 − ρ11`, its `bloch_length`, its
  `purity = Tr ρ²` (1 pure, ½ maximally mixed) and `entangled_with_rest = purity < 1 − 1e-9`.
  The last is meaningful because every traced state is globally pure: then a mixed qubit is exactly
  one that is entangled with the others. It does not say with which, and it is not a circuit verdict.
  - Each entry carries `derived_from` (step index, `result_id`, `execution_id`, the step's prefix
    `circuit_hash`, backend and version), so a number cannot be detached from its state. Only the
    statevector is read — no gate names, no textbook answers — and values are not rounded.
  - `status = "UNUSABLE"` is explicit, with a `reason` and no number: a malformed or unnormalised
    state, a qubit outside the register, or a derived qubit state that is not a valid density matrix
    (purity outside [½, 1] or a Bloch vector longer than 1, beyond 1e-9). Nothing is shown in its place.
  - Tests check it against Qiskit's own Pauli expectation values and partial-trace purity on random
    circuits (including `cp`), against hand-known states (Bell, GHZ, product), and across all three backends.
- **Amplitude / phase view (`amplitude_view` on a trace step, `qentor/execution/amplitude_view.py`).**
  Per basis state, in statevector order: `magnitude`, `probability` and `phase = atan2(im, re)`
  (radians). `phase` is `null` where the amplitude is numerically zero (probability ≤ 1e-9), because the
  angle of zero is undefined. The phase is the simulator's own, relative to an unobservable global phase,
  so only differences between basis states are physical. The frontend draws bars and arrows by setting a
  CSS variable to each number; it computes none of them.

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

**As built (`qentor/verification/dj_family.py`, `tests/test_dj_family.py`).** The 72 cases are exactly these and no others:

| Cases | What they are |
|---|---|
| 2 constant | truth tables `00000000` (f ≡ 0) and `11111111` (f ≡ 1) |
| 70 balanced | every choice of 4 of the 8 inputs that map to 1: C(8,4) = 70 tables |

A truth table lists f(0) … f(7) left to right, and the input x is the integer whose binary string is `q2 q1 q0` (so x = 1
is `001`, q0 set). Qubits: q0–q2 are the input bits, q3 is the oracle's output (ancilla) qubit, q4 is one clean work qubit
(the gate set has `ccx` but no 3-control X, so each multi-controlled X is a Toffoli ladder through it and the work qubit
must come back to 0). Each oracle is the bit-flip oracle |x⟩|b⟩|0⟩ → |x⟩|b⊕f(x)⟩|0⟩: for every x with f(x) = 1, X gates select
the pattern, the ladder flips the ancilla, and the X gates are undone. A function that is neither constant nor balanced
is refused (`classify` raises); there is no generator for other sizes or functions. The order is fixed: indices 0 and 1 are
the constants, 2–71 the balanced tables in `itertools.combinations` order.

Two checks run on the backend for every oracle (Aer by default; Cirq agrees on the algorithm decisions):

1. **Oracle behaviour.** A basis sweep of the oracle alone through the existing harness: for each x the output over
   `q4 q3 q2 q1 q0` must be `0`, f(x), x with probability 1, so a wrong truth table, a disturbed input or a dirty work
   qubit fails with the harness's counterexample.
2. **Algorithm decision.** The reference circuit (ancilla to |1⟩, Hadamard on all, one oracle call, Hadamard on the inputs)
   is run in exact statevector mode. The decision is read from the backend's probability of `q2 q1 q0 = 000`: ≥ 1 − 1e-9 is
   "constant", ≤ 1e-9 is "balanced", anything between is "ambiguous" and fails. A case passes when the decision equals the
   oracle's class. The only classical inputs are the truth table and its class, which define the case; no quantum number is
   supplied by the test.

The sweep reports, per oracle: index, class, truth table, the decision, the backend's probability, the circuit hash and (when
a recorder is given) the result id; failures carry the measured input distribution as the counterexample. Measured on this
machine: 72 decisions in about 0.1 s, with the 576 oracle-behaviour runs about 0.8 s. The tests include broken oracle
structure (a dropped Toffoli, a missing uncompute, a wrong control wire), a changed expected result, the pinned bit
order, two known-buggy algorithms (no final Hadamards: every case "ambiguous"; no ancilla X: all 70 balanced cases fail),
a scripted backend that returns the zero state, and an unavailable backend (an error, never a pass). It is a library
and test suite; the Lab does not yet expose a "run all 72" button, so the hero path's step 4 is still not wired to it.

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
- **Optimisation as learning (built).** A VERIFIED_SHORTER report also carries what the learner needs to understand the change, all computed by the server and none of it by the browser or a model:
  - `operations_removed` and the original and candidate operation counts;
  - `changes`: an operation-level diff (`diff_ops`, a longest-common-subsequence walk over exact operations): each operation of the original is `kept` or `removed`, each operation only in the candidate is `added`. A merged rotation is the two rotations removed and one added. The diff is attached only in the one place a VERIFIED_SHORTER report is built, after the equivalence check said EQUIVALENT; a rejected or unverifiable candidate is never described;
  - `rule_notes`: for each rule that fired, a plain sentence on why that kind of rewrite is safe (`explain_rule`), or `null` for a rule string the server has no sentence for. The sentence is textbook reasoning, contains no number and no verdict, and the UI says the equivalence check, not the rule, decides;
  - `candidate_provenance`: the persisted statevector run of the proposed circuit (result id, circuit hash, backend and version, mode, class), evidence to inspect and explicitly not the equivalence proof.
- **`EquivalentTo` challenge check.** "Your whole circuit does what this circuit does" is judged by `check_equivalence` (operator equivalence up to global phase), not by comparing one state. A circuit the checker cannot decide does not pass. The challenge `optimize-redundant` ("Shorten it without changing it", Interference lesson) starts from a 10-operation circuit and asks for at most 3 that do the same thing. The Lab's Optimize button is not offered inside a challenge, where it would hand over the answer; Equivalence (pin a reference, check) is.

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
