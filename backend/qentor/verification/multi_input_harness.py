"""Multi-input test harness (docs/VERIFICATION_ARCHITECTURE.md §4.2).

This is the "basis-sweep" spec kind only: every case prepares an explicit
computational-basis input on a declared set of qubits ("via X gates
prepended", per the doc), runs the circuit, and checks that a declared set of
output qubits reads the expected basis value with probability >= 1 - 1e-9 ("no
sampling"). The other three documented kinds (``oracle-slot``, ``state-prep``,
``unitary-match``) are deliberately not built here: ``oracle-slot`` needs an
``oracle`` gate the canonical model doesn't have yet (docs/ARCHITECTURE.md §4
lists it as future work), and the other two need a fidelity/equivalence
checker this codebase hasn't built yet either. Building only what the model
and existing verification layer already support is why Deutsch-Jozsa is not
hard-coded anywhere in this module.

Design:

- Reuses the existing canonical ``Circuit`` model and ``ExecutionAdapter``
  protocol directly — this module never computes an amplitude, probability or
  count itself; it only reads ``ExecutionResult.statevector`` (real numbers an
  adapter already produced) and does Born-rule bookkeeping on them (squaring
  magnitudes, summing over a qubit subset), exactly what
  ``qentor.verification.bell_state`` already does for its own statevector
  case.
- Runs every case in **statevector mode** even if the submitted circuit has
  terminal ``measure`` ops — those are stripped from the per-case circuit
  before execution. Running a circuit that still contains ``measure`` ops
  through Aer's ``save_statevector()`` would let the projective measurement
  collapse the state *before* the save, making the "exact" probability
  reported for that run random from shot to shot — silently breaking both
  "exact, no sampling" and "deterministic/reproducible" at once. Terminal
  measurement doesn't change the *pre-measurement* probabilities of any
  output qubit, so stripping it and reading the qubit's own computational-
  basis probability directly is the exact, not-an-approximation, equivalent.
- Never writes to the provenance log itself: each case's real
  ``ExecutionResult`` is handed to an injected ``record_execution`` callback
  (the API layer's job, mirroring how ``qentor.tutor``/``qentor.verification``
  never touch ``ProvenanceStore`` directly) so every execution the harness
  uses is still provenance-preserved without this module importing the store.
"""

from __future__ import annotations

import uuid
from enum import Enum
from typing import Callable

from pydantic import BaseModel, ConfigDict, field_validator

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import (
    AdapterExecutionError,
    AdapterUnavailable,
    ExecutionAdapter,
    ExecutionResult,
)

_PROBABILITY_TOLERANCE = 1e-9

# docs/VERIFICATION_ARCHITECTURE.md §4.2: "the library keeps inputs at n <= 5
# ... Larger specs are refused rather than sampled silently." Widened slightly
# to match Circuit's own qubit cap philosophy elsewhere in this codebase,
# still small enough that an exhaustive 2**n sweep never runs away.
MAX_SWEEP_QUBITS = 8
MAX_TEST_CASES = 256


class HarnessValidationError(ValueError):
    """The request itself doesn't make sense for this circuit — rejected
    before any execution is attempted, never silently reinterpreted."""


class CaseStatus(str, Enum):
    PASS = "PASS"
    FAIL = "FAIL"
    EXECUTION_ERROR = "EXECUTION_ERROR"


class OverallStatus(str, Enum):
    ALL_PASSED = "ALL_PASSED"
    SOME_FAILED = "SOME_FAILED"
    INCOMPLETE = "INCOMPLETE"


class TestCaseSpec(BaseModel):
    """One explicit, reproducible input. ``input_bits``/``expected_output``
    are read positionally against the harness's ``input_qubits``/
    ``output_qubits`` lists, each sorted highest-qubit-index-first — the same
    q[n-1]...q[0] convention used for a full register everywhere else in this
    codebase, generalised to an arbitrary qubit subset."""

    model_config = ConfigDict(extra="forbid")

    input_bits: str
    expected_output: str

    @field_validator("input_bits", "expected_output")
    @classmethod
    def _bits_only(cls, value: str) -> str:
        if not value or any(c not in "01" for c in value):
            raise ValueError(f"expected a non-empty string of '0'/'1' characters, got {value!r}")
        return value


class Counterexample(BaseModel):
    """A failing input: what was asked for, and what the backend actually
    produced instead — enough to reproduce and inspect the failure."""

    model_config = ConfigDict(extra="forbid")

    input_bits: str
    expected_output: str
    observed_distribution: dict[str, float]
    circuit_hash: str
    result_id: str | None


class CaseResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_bits: str
    expected_output: str
    status: CaseStatus
    observed_distribution: dict[str, float] | None
    error: str | None
    result_id: str | None
    circuit_hash: str


class HarnessReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    test_id: str
    circuit_hash: str
    backend: str
    backend_version: str | None
    input_qubits: list[int]
    output_qubits: list[int]
    cases: list[CaseResult]
    counterexamples: list[Counterexample]
    overall_status: OverallStatus


def run_multi_input_test(
    *,
    circuit: Circuit,
    adapter: ExecutionAdapter,
    input_qubits: list[int],
    output_qubits: list[int],
    cases: list[TestCaseSpec],
    record_execution: Callable[[ExecutionResult, str], str] | None = None,
    test_id: str | None = None,
) -> HarnessReport:
    """Run every case, statevector-exact, and report pass/fail with
    counterexamples. Raises ``HarnessValidationError`` for a request that
    doesn't fit this circuit (out-of-range qubit, wrong-width bitstring, too
    many qubits/cases) — never silently truncated or reinterpreted.

    ``record_execution``, if given, is called once per case with the real
    ``ExecutionResult`` and that case's own circuit hash, and must return the
    ``result_id`` the caller persisted it under (see qentor.api.app for the
    real ProvenanceStore-backed callback). Left as ``None``, cases still run
    exactly the same; only ``result_id`` fields stay unset — used by this
    module's own unit tests, which don't need a store.
    """
    sorted_inputs, sorted_outputs = _validate_request(circuit, input_qubits, output_qubits, cases)

    case_results: list[CaseResult] = []
    counterexamples: list[Counterexample] = []
    any_execution_error = False
    any_failure = False
    backend_name = adapter.name
    backend_version: str | None = None

    for case in cases:
        prepared = _build_prepared_circuit(circuit, sorted_inputs, case.input_bits)
        case_hash = circuit_hash(prepared)

        try:
            result = adapter.run(prepared, "statevector")
        except (AdapterUnavailable, AdapterExecutionError) as exc:
            any_execution_error = True
            case_results.append(
                CaseResult(
                    input_bits=case.input_bits,
                    expected_output=case.expected_output,
                    status=CaseStatus.EXECUTION_ERROR,
                    observed_distribution=None,
                    error=f"{type(exc).__name__}: {exc}",
                    result_id=None,
                    circuit_hash=case_hash,
                )
            )
            continue

        backend_version = result.backend_version
        distribution = _project_distribution(result.statevector, sorted_outputs)
        result_id = record_execution(result, case_hash) if record_execution else None
        observed_probability = distribution.get(case.expected_output, 0.0)

        if observed_probability >= 1 - _PROBABILITY_TOLERANCE:
            status = CaseStatus.PASS
        else:
            status = CaseStatus.FAIL
            any_failure = True
            counterexamples.append(
                Counterexample(
                    input_bits=case.input_bits,
                    expected_output=case.expected_output,
                    observed_distribution=distribution,
                    circuit_hash=case_hash,
                    result_id=result_id,
                )
            )

        case_results.append(
            CaseResult(
                input_bits=case.input_bits,
                expected_output=case.expected_output,
                status=status,
                observed_distribution=distribution,
                error=None,
                result_id=result_id,
                circuit_hash=case_hash,
            )
        )

    if any_execution_error:
        overall = OverallStatus.INCOMPLETE
    elif any_failure:
        overall = OverallStatus.SOME_FAILED
    else:
        overall = OverallStatus.ALL_PASSED

    return HarnessReport(
        test_id=test_id or f"test_{uuid.uuid4().hex}",
        circuit_hash=circuit_hash(circuit),
        backend=backend_name,
        backend_version=backend_version,
        input_qubits=sorted_inputs,
        output_qubits=sorted_outputs,
        cases=case_results,
        counterexamples=counterexamples,
        overall_status=overall,
    )


def _validate_request(
    circuit: Circuit,
    input_qubits: list[int],
    output_qubits: list[int],
    cases: list[TestCaseSpec],
) -> tuple[list[int], list[int]]:
    if not input_qubits:
        raise HarnessValidationError("input_qubits must not be empty")
    if not output_qubits:
        raise HarnessValidationError("output_qubits must not be empty")
    if len(set(input_qubits)) != len(input_qubits):
        raise HarnessValidationError(f"input_qubits contains duplicates: {input_qubits}")
    if len(set(output_qubits)) != len(output_qubits):
        raise HarnessValidationError(f"output_qubits contains duplicates: {output_qubits}")
    for label, qubits in (("input_qubits", input_qubits), ("output_qubits", output_qubits)):
        for q in qubits:
            if not (0 <= q < circuit.num_qubits):
                raise HarnessValidationError(
                    f"{label} contains qubit {q}, out of range for a {circuit.num_qubits}-qubit circuit"
                )
    if len(input_qubits) > MAX_SWEEP_QUBITS:
        raise HarnessValidationError(
            f"input_qubits has {len(input_qubits)} qubits, more than the {MAX_SWEEP_QUBITS} this harness allows"
        )
    if not cases:
        raise HarnessValidationError("cases must not be empty")
    if len(cases) > MAX_TEST_CASES:
        raise HarnessValidationError(f"{len(cases)} cases given, more than the {MAX_TEST_CASES} this harness allows")

    sorted_inputs = sorted(set(input_qubits), reverse=True)
    sorted_outputs = sorted(set(output_qubits), reverse=True)

    for case in cases:
        if len(case.input_bits) != len(sorted_inputs):
            raise HarnessValidationError(
                f"input_bits {case.input_bits!r} has length {len(case.input_bits)}, "
                f"expected {len(sorted_inputs)} to match input_qubits"
            )
        if len(case.expected_output) != len(sorted_outputs):
            raise HarnessValidationError(
                f"expected_output {case.expected_output!r} has length {len(case.expected_output)}, "
                f"expected {len(sorted_outputs)} to match output_qubits"
            )

    return sorted_inputs, sorted_outputs


def _build_prepared_circuit(circuit: Circuit, sorted_input_qubits: list[int], input_bits: str) -> Circuit:
    """The base circuit with an X gate prepended for every '1' input bit, and
    any terminal ``measure`` op stripped — see the module docstring for why."""
    x_preps = [
        GateOp(gate=GateName.X, targets=[qubit])
        for qubit, bit in zip(sorted_input_qubits, input_bits)
        if bit == "1"
    ]
    body = [op for op in circuit.ops if op.gate is not GateName.MEASURE]
    return Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=[*x_preps, *body])


def _project_distribution(
    statevector: list[list[float]], sorted_output_qubits: list[int]
) -> dict[str, float]:
    """Exact Born-rule probability of each output-qubit bit pattern, summed
    over every basis state that projects onto it. Pure arithmetic on
    amplitudes an adapter already returned — no simulation happens here."""
    distribution: dict[str, float] = {}
    for index, (re, im) in enumerate(statevector):
        probability = re * re + im * im
        if probability <= _PROBABILITY_TOLERANCE:
            continue
        bits = "".join(str((index >> qubit) & 1) for qubit in sorted_output_qubits)
        distribution[bits] = distribution.get(bits, 0.0) + probability
    return distribution
