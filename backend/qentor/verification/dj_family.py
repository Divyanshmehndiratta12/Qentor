"""The Deutsch-Jozsa oracle family for n = 3 (docs/VERIFICATION_ARCHITECTURE.md §4.2, "oracle-slot").

The repository's requirement, quoted: "2 constant functions plus C(8,4) = 70 balanced functions gives 72 oracles. Each
is built as a bit-flip oracle from multi-controlled X gates. A unit test asserts the count and that the reference
solution passes all 72." This module is exactly that and nothing more general:

- The family is the fixed set of promise functions f: {0,1}^3 -> {0,1}: the 2 constant functions and the 70 balanced
  ones (exactly four of the eight inputs map to 1). A truth table that is neither is refused (``ValueError``); there is
  no oracle generator for other sizes or other functions.
- Each oracle is the bit-flip oracle |x>|b>|0> -> |x>|b xor f(x)>|0>, built from one multi-controlled X per input x with
  f(x) = 1 (X gates select the input pattern; the 3-control X is a Toffoli ladder through ONE clean work qubit, because
  the gate set has ``ccx`` but no 3-control X).
- Everything quantum comes from the backend: the oracle's behaviour is read from a basis sweep of exact statevectors
  (``multi_input_harness``), and the algorithm's decision from the exact probability of reading ``000`` on the input
  register. The only classical facts used are the truth table and its constant/balanced class, which are definitions of
  the family, not results.

Qubit layout (displayed ``q[n-1] … q[0]``): q0, q1, q2 are the input bits x, so the integer x has the binary string
``q2 q1 q0``; q3 is the oracle's output (ancilla) qubit; q4 is the work qubit, which must come back to 0.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations
from typing import Callable, Literal

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionAdapter, ExecutionResult
from qentor.verification.multi_input_harness import (
    OverallStatus,
    TestCaseSpec,
    project_distribution,
    run_multi_input_test,
)

N_INPUTS = 3
INPUT_QUBITS = [0, 1, 2]
ANCILLA = 3
WORK = 4
NUM_QUBITS = 5
TABLE_SIZE = 1 << N_INPUTS  # 8 input values
FAMILY_SIZE = 72  # 2 constant + C(8,4) = 70 balanced
PROBABILITY_TOLERANCE = 1e-9

Kind = Literal["constant", "balanced"]


@dataclass(frozen=True)
class DJOracle:
    index: int
    kind: Kind
    outputs: tuple[int, ...]  # outputs[x] = f(x) for x = 0..7, where x's binary string is q2 q1 q0

    @property
    def truth_table(self) -> str:
        """f(0) … f(7) left to right, e.g. "00001111" is f(x) = q2."""
        return "".join(str(bit) for bit in self.outputs)

    def as_mapping(self) -> dict[str, int]:
        """{"q2q1q0": f(x)}, so the bit order is visible: x = 1 is "001" (q0 set)."""
        return {format(x, f"0{N_INPUTS}b"): bit for x, bit in enumerate(self.outputs)}


def classify(outputs: tuple[int, ...]) -> Kind:
    """The promise: constant or balanced. Anything else is outside the Deutsch-Jozsa problem and is refused."""
    if len(outputs) != TABLE_SIZE or any(bit not in (0, 1) for bit in outputs):
        raise ValueError(f"a truth table has {TABLE_SIZE} bits, each 0 or 1; got {outputs!r}")
    ones = sum(outputs)
    if ones in (0, TABLE_SIZE):
        return "constant"
    if ones == TABLE_SIZE // 2:
        return "balanced"
    raise ValueError(f"{outputs!r} is neither constant nor balanced, so it is outside the Deutsch-Jozsa promise")


def build_family() -> list[DJOracle]:
    """The 72 oracles in a fixed order: constant 0, constant 1, then the 70 balanced tables by ascending set of inputs
    mapped to 1 (itertools.combinations order). The index is the oracle's position in this list."""
    tables: list[tuple[int, ...]] = [(0,) * TABLE_SIZE, (1,) * TABLE_SIZE]
    for ones in combinations(range(TABLE_SIZE), TABLE_SIZE // 2):
        tables.append(tuple(1 if x in ones else 0 for x in range(TABLE_SIZE)))
    family = [DJOracle(index=i, kind=classify(t), outputs=t) for i, t in enumerate(tables)]
    if len(family) != FAMILY_SIZE:  # a construction error must fail loudly, not shrink the family
        raise AssertionError(f"Deutsch-Jozsa family has {len(family)} oracles, expected {FAMILY_SIZE}")
    return family


def _g(gate: str, *, targets: list[int], controls: list[int] | None = None) -> GateOp:
    return GateOp(gate=GateName(gate), targets=targets, controls=controls or [])


def oracle_ops(oracle: DJOracle) -> list[GateOp]:
    """Bit-flip oracle: for every x with f(x) = 1, flip the ancilla when the inputs equal x. X gates turn the
    "inputs equal x" pattern into all-ones, a Toffoli ladder through the work qubit is the 3-control X, and the
    ladder's first step is undone so the work qubit returns to 0."""
    ops: list[GateOp] = []
    for x, bit in enumerate(oracle.outputs):
        if not bit:
            continue
        zeros = [q for q in INPUT_QUBITS if not (x >> q) & 1]
        ops += [_g("x", targets=[q]) for q in zeros]
        ops += [
            _g("ccx", controls=[0, 1], targets=[WORK]),
            _g("ccx", controls=[WORK, 2], targets=[ANCILLA]),
            _g("ccx", controls=[0, 1], targets=[WORK]),
        ]
        ops += [_g("x", targets=[q]) for q in zeros]
    return ops


def oracle_circuit(oracle: DJOracle) -> Circuit:
    return Circuit(num_qubits=NUM_QUBITS, num_clbits=0, ops=oracle_ops(oracle))


def reference_algorithm(oracle: DJOracle) -> Circuit:
    """The reference Deutsch-Jozsa circuit: ancilla to |1>, Hadamard everything, one oracle call, Hadamard the inputs.
    Reading q2 q1 q0 = 000 means constant; anything else means balanced. The measurement is left to the harness (it
    reads exact probabilities from the statevector and strips terminal measurements)."""
    ops = [_g("x", targets=[ANCILLA])]
    ops += [_g("h", targets=[q]) for q in (*INPUT_QUBITS, ANCILLA)]
    ops += oracle_ops(oracle)
    ops += [_g("h", targets=[q]) for q in INPUT_QUBITS]
    return Circuit(num_qubits=NUM_QUBITS, num_clbits=0, ops=ops)


@dataclass
class OracleBehaviourReport:
    """The basis sweep of one oracle: does |x>|0>|0> map to |x>|f(x)>|0> for all 8 inputs, on the backend?"""

    passed: bool
    failing_inputs: list[str]  # input strings q2q1q0
    observed: dict[str, dict[str, float]]  # input -> distribution over q4 q3 q2 q1 q0 (only for failing inputs)
    incomplete: bool = False


def check_oracle_behaviour(
    oracle: DJOracle,
    adapter: ExecutionAdapter,
    circuit: Circuit | None = None,
    record_execution: Callable[[ExecutionResult, str], str] | None = None,
) -> OracleBehaviourReport:
    """Run the oracle (``circuit`` defaults to the canonical one) on all 8 basis inputs and compare with its truth
    table. Expected output string is read over q4 q3 q2 q1 q0: work qubit 0, then f(x), then x itself (unchanged)."""
    cases = [
        TestCaseSpec(
            input_bits=format(x, f"0{N_INPUTS}b"),
            expected_output="0" + str(oracle.outputs[x]) + format(x, f"0{N_INPUTS}b"),
        )
        for x in range(TABLE_SIZE)
    ]
    report = run_multi_input_test(
        circuit=circuit or oracle_circuit(oracle),
        adapter=adapter,
        input_qubits=INPUT_QUBITS,
        output_qubits=[0, 1, 2, ANCILLA, WORK],
        cases=cases,
        record_execution=record_execution,
    )
    failing = [c.input_bits for c in report.cases if c.status.value != "PASS"]
    observed = {c.input_bits: c.observed_distribution for c in report.cases if c.status.value == "FAIL" and c.observed_distribution}
    return OracleBehaviourReport(
        passed=report.overall_status is OverallStatus.ALL_PASSED,
        failing_inputs=failing,
        observed=observed,
        incomplete=report.overall_status is OverallStatus.INCOMPLETE,
    )


Decision = Literal["constant", "balanced", "ambiguous"]


@dataclass
class OracleVerdict:
    index: int
    kind: Kind
    truth_table: str
    decision: Decision | None  # None when the backend could not run it
    probability_000: float | None  # exact P(q2 q1 q0 = 000) from the backend's statevector
    passed: bool
    circuit_hash: str
    result_id: str | None = None
    error: str | None = None
    input_distribution: dict[str, float] | None = None  # q2q1q0, the counterexample's measured distribution


@dataclass
class FamilyReport:
    total: int
    constant: int
    balanced: int
    passed: int
    verdicts: list[OracleVerdict] = field(default_factory=list)
    oracle_failures: list[int] = field(default_factory=list)  # indices whose oracle did not match its truth table
    backend: str = ""
    backend_version: str | None = None

    @property
    def counterexamples(self) -> list[OracleVerdict]:
        return [v for v in self.verdicts if not v.passed]

    @property
    def all_passed(self) -> bool:
        return self.passed == self.total and not self.oracle_failures


def decide(probability_000: float) -> Decision:
    """The algorithm's decision from the exact probability of reading 000 on the inputs."""
    if probability_000 >= 1 - PROBABILITY_TOLERANCE:
        return "constant"
    if probability_000 <= PROBABILITY_TOLERANCE:
        return "balanced"
    return "ambiguous"


def run_family_sweep(
    adapter: ExecutionAdapter,
    *,
    build_algorithm: Callable[[DJOracle], Circuit] = reference_algorithm,
    build_oracle: Callable[[DJOracle], Circuit] = oracle_circuit,
    check_oracles: bool = True,
    record_execution: Callable[[ExecutionResult, str], str] | None = None,
) -> FamilyReport:
    """Run all 72 oracles through the algorithm on the backend. A case passes when the algorithm's decision equals the
    oracle's class with probability 1 (a mixed distribution is "ambiguous" and fails). With ``check_oracles`` each
    oracle's own circuit is also swept against its truth table, so a wrong oracle is reported as an oracle failure
    instead of being blamed on the algorithm. ``build_*`` let a caller test a different circuit; the defaults are the
    reference solution."""
    family = build_family()
    report = FamilyReport(
        total=len(family),
        constant=sum(o.kind == "constant" for o in family),
        balanced=sum(o.kind == "balanced" for o in family),
        passed=0,
        backend=adapter.name,
    )
    for oracle in family:
        if check_oracles and not check_oracle_behaviour(oracle, adapter, build_oracle(oracle), record_execution).passed:
            report.oracle_failures.append(oracle.index)

        circuit = build_algorithm(oracle)
        digest = circuit_hash(circuit)
        try:
            result = adapter.run(_without_measurements(circuit), "statevector")
        except (AdapterUnavailable, AdapterExecutionError) as exc:
            report.verdicts.append(
                OracleVerdict(
                    index=oracle.index, kind=oracle.kind, truth_table=oracle.truth_table, decision=None,
                    probability_000=None, passed=False, circuit_hash=digest, error=f"{type(exc).__name__}: {exc}",
                )
            )
            continue
        report.backend_version = result.backend_version
        distribution = project_distribution(result.statevector, sorted(INPUT_QUBITS, reverse=True))
        p_zero = distribution.get("0" * N_INPUTS, 0.0)
        decision = decide(p_zero)
        passed = decision == oracle.kind
        report.passed += passed
        report.verdicts.append(
            OracleVerdict(
                index=oracle.index, kind=oracle.kind, truth_table=oracle.truth_table, decision=decision,
                probability_000=p_zero, passed=passed, circuit_hash=digest,
                result_id=record_execution(result, digest) if record_execution else None,
                input_distribution=distribution,
            )
        )
    return report


def _without_measurements(circuit: Circuit) -> Circuit:
    """Terminal measurements would collapse the statevector at random before it is saved (see the harness)."""
    return Circuit(
        num_qubits=circuit.num_qubits,
        num_clbits=circuit.num_clbits,
        ops=[op for op in circuit.ops if op.gate is not GateName.MEASURE],
    )
