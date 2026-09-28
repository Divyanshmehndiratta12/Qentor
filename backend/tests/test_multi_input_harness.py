"""Tests for qentor.verification.multi_input_harness — the domain logic in
isolation, using the real Aer adapter (skipped, not faked, if unavailable)
but no ProvenanceStore (record_execution left unset). API-level tests with
real persistence live in test_api_multi_input.py.
"""

from __future__ import annotations

import unittest

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionResult
from qentor.execution.aer import AerAdapter
from qentor.verification.multi_input_harness import (
    CaseStatus,
    HarnessValidationError,
    OverallStatus,
    TestCaseSpec,
    run_multi_input_test,
)

# A deterministic "copy" circuit: output qubit 1 always equals input qubit 0.
COPY = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="cx", controls=[0], targets=[1])])

# Identity (no gates) on 3 qubits — used for the isolated-qubit bit-order case.
IDENTITY_3Q = Circuit(num_qubits=3, num_clbits=0, ops=[])

# A circuit with a terminal measure op, to prove it gets stripped rather than
# causing stochastic collapse before the statevector is read.
COPY_WITH_MEASURE = Circuit(
    num_qubits=2,
    num_clbits=2,
    ops=[
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="measure", targets=[0], clbits=[0]),
        GateOp(gate="measure", targets=[1], clbits=[1]),
    ],
)


class AerBackedTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = AerAdapter()
        try:
            self.adapter.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")


class TestAllInputsPass(AerBackedTestCase):
    def test_copy_circuit_passes_for_both_inputs(self) -> None:
        report = run_multi_input_test(
            circuit=COPY,
            adapter=self.adapter,
            input_qubits=[0],
            output_qubits=[1],
            cases=[
                TestCaseSpec(input_bits="0", expected_output="0"),
                TestCaseSpec(input_bits="1", expected_output="1"),
            ],
        )

        self.assertEqual(report.overall_status, OverallStatus.ALL_PASSED)
        self.assertEqual([c.status for c in report.cases], [CaseStatus.PASS, CaseStatus.PASS])
        self.assertEqual(report.counterexamples, [])
        self.assertEqual(report.input_qubits, [0])
        self.assertEqual(report.output_qubits, [1])
        self.assertTrue(report.test_id.startswith("test_"))
        self.assertEqual(len(report.circuit_hash), 64)

    def test_terminal_measure_ops_are_stripped_not_left_to_collapse(self) -> None:
        """The same circuit, but with terminal measure ops included in the
        submitted circuit — must give the identical, deterministic exact
        result as the measure-free version, not a random collapsed one."""
        report = run_multi_input_test(
            circuit=COPY_WITH_MEASURE,
            adapter=self.adapter,
            input_qubits=[0],
            output_qubits=[1],
            cases=[TestCaseSpec(input_bits="1", expected_output="1")],
        )
        self.assertEqual(report.overall_status, OverallStatus.ALL_PASSED)
        self.assertEqual(report.cases[0].observed_distribution, {"1": 1.0})


class TestFailingInputProducesCounterexample(AerBackedTestCase):
    def test_wrong_expectation_produces_a_concrete_counterexample(self) -> None:
        report = run_multi_input_test(
            circuit=COPY,
            adapter=self.adapter,
            input_qubits=[0],
            output_qubits=[1],
            cases=[
                TestCaseSpec(input_bits="0", expected_output="0"),
                TestCaseSpec(input_bits="1", expected_output="0"),  # wrong: copy outputs 1 for input 1
            ],
        )

        self.assertEqual(report.overall_status, OverallStatus.SOME_FAILED)
        self.assertEqual([c.status for c in report.cases], [CaseStatus.PASS, CaseStatus.FAIL])

        self.assertEqual(len(report.counterexamples), 1)
        counterexample = report.counterexamples[0]
        self.assertEqual(counterexample.input_bits, "1")
        self.assertEqual(counterexample.expected_output, "0")
        self.assertEqual(counterexample.observed_distribution, {"1": 1.0})
        self.assertEqual(len(counterexample.circuit_hash), 64)

    def test_multiple_failing_inputs_are_each_represented(self) -> None:
        report = run_multi_input_test(
            circuit=COPY,
            adapter=self.adapter,
            input_qubits=[0],
            output_qubits=[1],
            cases=[
                TestCaseSpec(input_bits="0", expected_output="1"),  # wrong
                TestCaseSpec(input_bits="1", expected_output="0"),  # wrong
            ],
        )

        self.assertEqual(report.overall_status, OverallStatus.SOME_FAILED)
        self.assertEqual([c.status for c in report.cases], [CaseStatus.FAIL, CaseStatus.FAIL])
        self.assertEqual(len(report.counterexamples), 2)
        self.assertEqual({c.input_bits for c in report.counterexamples}, {"0", "1"})
        # Each counterexample's own circuit hash differs (different X-prep).
        self.assertNotEqual(report.counterexamples[0].circuit_hash, report.counterexamples[1].circuit_hash)

    def test_does_not_claim_correctness_from_a_single_passing_input(self) -> None:
        """One passing case among a failing one must not push the overall
        verdict toward ALL_PASSED."""
        report = run_multi_input_test(
            circuit=COPY,
            adapter=self.adapter,
            input_qubits=[0],
            output_qubits=[1],
            cases=[
                TestCaseSpec(input_bits="0", expected_output="0"),  # correct
                TestCaseSpec(input_bits="1", expected_output="0"),  # wrong
            ],
        )
        self.assertNotEqual(report.overall_status, OverallStatus.ALL_PASSED)
        self.assertEqual(report.overall_status, OverallStatus.SOME_FAILED)


class TestExecutionFailureVsAlgorithmFailure(unittest.TestCase):
    """Item 4: an adapter that can't run the circuit at all must be reported
    as INCOMPLETE, never conflated with a wrong-answer FAIL."""

    class _AlwaysUnavailable:
        name = "stub-unavailable"

        def run(self, circuit, mode, shots=None):
            raise AdapterUnavailable("stub: backend not installed")

    class _AlwaysExecutionError:
        name = "stub-execution-error"

        def run(self, circuit, mode, shots=None):
            raise AdapterExecutionError("stub: the SDK rejected this circuit")

    def test_adapter_unavailable_is_incomplete_not_failed(self) -> None:
        report = run_multi_input_test(
            circuit=COPY,
            adapter=self._AlwaysUnavailable(),
            input_qubits=[0],
            output_qubits=[1],
            cases=[TestCaseSpec(input_bits="0", expected_output="0")],
        )
        self.assertEqual(report.overall_status, OverallStatus.INCOMPLETE)
        self.assertEqual(report.cases[0].status, CaseStatus.EXECUTION_ERROR)
        self.assertIn("stub: backend not installed", report.cases[0].error)
        self.assertIsNone(report.cases[0].observed_distribution)

    def test_adapter_execution_error_is_incomplete_not_failed(self) -> None:
        report = run_multi_input_test(
            circuit=COPY,
            adapter=self._AlwaysExecutionError(),
            input_qubits=[0],
            output_qubits=[1],
            cases=[TestCaseSpec(input_bits="0", expected_output="0")],
        )
        self.assertEqual(report.overall_status, OverallStatus.INCOMPLETE)
        self.assertEqual(report.cases[0].status, CaseStatus.EXECUTION_ERROR)

    def test_incomplete_takes_priority_even_alongside_a_real_failure(self) -> None:
        """A mixed run — this codebase never had a scenario where a single
        adapter both succeeds and fails per case, but the aggregation rule
        must still hold: INCOMPLETE outranks SOME_FAILED, since a run that
        couldn't fully execute cannot honestly claim any verdict."""

        class FailsOnSecondCall:
            name = "flaky"

            def __init__(self) -> None:
                self.calls = 0

            def run(self, circuit, mode, shots=None):
                self.calls += 1
                if self.calls == 1:
                    return ExecutionResult(
                        backend_name="flaky",
                        backend_version="0",
                        execution_mode="statevector",
                        execution_id="flaky-1",
                        statevector=[[1.0, 0.0], [0.0, 0.0]],  # always |0>, wrong for input '1'
                    )
                raise AdapterExecutionError("second call fails")

        report = run_multi_input_test(
            circuit=Circuit(num_qubits=1, num_clbits=0, ops=[]),
            adapter=FailsOnSecondCall(),
            input_qubits=[0],
            output_qubits=[0],
            cases=[
                TestCaseSpec(input_bits="1", expected_output="0"),  # will FAIL (stub always returns |0>)
                TestCaseSpec(input_bits="0", expected_output="0"),  # will error on 2nd call
            ],
        )
        self.assertEqual(report.overall_status, OverallStatus.INCOMPLETE)


class TestUnsupportedRequestIsRejectedExplicitly(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = AerAdapter()

    def test_out_of_range_input_qubit_is_rejected(self) -> None:
        with self.assertRaises(HarnessValidationError):
            run_multi_input_test(
                circuit=COPY,
                adapter=self.adapter,
                input_qubits=[5],
                output_qubits=[1],
                cases=[TestCaseSpec(input_bits="1", expected_output="1")],
            )

    def test_out_of_range_output_qubit_is_rejected(self) -> None:
        with self.assertRaises(HarnessValidationError):
            run_multi_input_test(
                circuit=COPY,
                adapter=self.adapter,
                input_qubits=[0],
                output_qubits=[9],
                cases=[TestCaseSpec(input_bits="1", expected_output="1")],
            )

    def test_mismatched_input_bits_length_is_rejected(self) -> None:
        with self.assertRaises(HarnessValidationError):
            run_multi_input_test(
                circuit=COPY,
                adapter=self.adapter,
                input_qubits=[0, 1],
                output_qubits=[1],
                cases=[TestCaseSpec(input_bits="1", expected_output="1")],
            )

    def test_mismatched_expected_output_length_is_rejected(self) -> None:
        with self.assertRaises(HarnessValidationError):
            run_multi_input_test(
                circuit=COPY,
                adapter=self.adapter,
                input_qubits=[0],
                output_qubits=[0, 1],
                cases=[TestCaseSpec(input_bits="1", expected_output="1")],
            )

    def test_empty_cases_is_rejected(self) -> None:
        with self.assertRaises(HarnessValidationError):
            run_multi_input_test(
                circuit=COPY, adapter=self.adapter, input_qubits=[0], output_qubits=[1], cases=[]
            )

    def test_duplicate_input_qubits_is_rejected(self) -> None:
        with self.assertRaises(HarnessValidationError):
            run_multi_input_test(
                circuit=COPY,
                adapter=self.adapter,
                input_qubits=[0, 0],
                output_qubits=[1],
                cases=[TestCaseSpec(input_bits="11", expected_output="1")],
            )

    def test_too_many_input_qubits_is_rejected(self) -> None:
        big_circuit = Circuit(num_qubits=10, num_clbits=0, ops=[])
        with self.assertRaises(HarnessValidationError):
            run_multi_input_test(
                circuit=big_circuit,
                adapter=self.adapter,
                input_qubits=list(range(9)),
                output_qubits=[9],
                cases=[TestCaseSpec(input_bits="0" * 9, expected_output="0")],
            )

    def test_non_binary_characters_are_rejected_by_the_case_schema(self) -> None:
        with self.assertRaises(ValueError):
            TestCaseSpec(input_bits="0x", expected_output="0")


class TestDeterministicAndReproducible(AerBackedTestCase):
    def test_running_the_same_spec_twice_gives_identical_results(self) -> None:
        def run_once():
            return run_multi_input_test(
                circuit=COPY,
                adapter=AerAdapter(),
                input_qubits=[0],
                output_qubits=[1],
                cases=[
                    TestCaseSpec(input_bits="0", expected_output="0"),
                    TestCaseSpec(input_bits="1", expected_output="1"),
                ],
            )

        first, second = run_once(), run_once()
        self.assertEqual(
            [c.observed_distribution for c in first.cases],
            [c.observed_distribution for c in second.cases],
        )
        self.assertEqual(first.overall_status, second.overall_status)
        self.assertEqual([c.circuit_hash for c in first.cases], [c.circuit_hash for c in second.cases])


class TestProvenanceReferencesArePreserved(AerBackedTestCase):
    def test_record_execution_callback_is_invoked_once_per_case_and_ids_flow_through(self) -> None:
        recorded: list[tuple[str, str]] = []

        def record_execution(result: ExecutionResult, case_hash: str) -> str:
            result_id = f"res_fake_{len(recorded)}"
            recorded.append((result_id, case_hash))
            return result_id

        report = run_multi_input_test(
            circuit=COPY,
            adapter=self.adapter,
            input_qubits=[0],
            output_qubits=[1],
            cases=[
                TestCaseSpec(input_bits="0", expected_output="0"),
                TestCaseSpec(input_bits="1", expected_output="1"),
            ],
            record_execution=record_execution,
        )

        self.assertEqual(len(recorded), 2)
        self.assertEqual([c.result_id for c in report.cases], [r[0] for r in recorded])

    def test_no_record_execution_callback_leaves_result_ids_unset(self) -> None:
        report = run_multi_input_test(
            circuit=COPY,
            adapter=self.adapter,
            input_qubits=[0],
            output_qubits=[1],
            cases=[TestCaseSpec(input_bits="0", expected_output="0")],
        )
        self.assertIsNone(report.cases[0].result_id)


class TestAsymmetricInputCatchesBitOrderMistakes(AerBackedTestCase):
    def test_isolated_high_index_qubit_reads_back_correctly(self) -> None:
        """A 3-qubit identity circuit; only q2 is prepared and only q2 is
        read. A bit-order bug (e.g. treating qubit 0 as most significant, or
        reading q0 instead of q2) would report the wrong value here even
        though it might accidentally pass a qubit-0-only or symmetric test."""
        report = run_multi_input_test(
            circuit=IDENTITY_3Q,
            adapter=self.adapter,
            input_qubits=[2],
            output_qubits=[2],
            cases=[
                TestCaseSpec(input_bits="0", expected_output="0"),
                TestCaseSpec(input_bits="1", expected_output="1"),
            ],
        )
        self.assertEqual(report.overall_status, OverallStatus.ALL_PASSED)

    def test_cross_qubit_copy_distinguishes_control_from_bystander(self) -> None:
        """3-qubit register: CX(q0 -> q2); q1 is an untouched bystander.
        Reading q1 as the output (instead of q2) must FAIL — this is exactly
        the kind of mistake a swapped qubit-index convention would produce."""
        cross_copy = Circuit(num_qubits=3, num_clbits=0, ops=[GateOp(gate="cx", controls=[0], targets=[2])])

        correct = run_multi_input_test(
            circuit=cross_copy,
            adapter=self.adapter,
            input_qubits=[0],
            output_qubits=[2],
            cases=[TestCaseSpec(input_bits="1", expected_output="1")],
        )
        self.assertEqual(correct.overall_status, OverallStatus.ALL_PASSED)

        wrong_output_qubit = run_multi_input_test(
            circuit=cross_copy,
            adapter=self.adapter,
            input_qubits=[0],
            output_qubits=[1],  # bystander, always 0 regardless of input
            cases=[TestCaseSpec(input_bits="1", expected_output="1")],
        )
        self.assertEqual(wrong_output_qubit.overall_status, OverallStatus.SOME_FAILED)
        self.assertEqual(wrong_output_qubit.counterexamples[0].observed_distribution, {"0": 1.0})


if __name__ == "__main__":
    unittest.main()
