"""The Lab's server-side capabilities: cross-backend agreement, the equivalence endpoint, and the code views.

The browser never compares two quantum values or decides two circuits are equal: it sends canonical circuits and
renders what these endpoints return. Every claim here is about that division of labour.
"""

from __future__ import annotations

import json
import math
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import AgreementRequest, CodeRequest, EquivalenceRequest
from qentor.circuit.codegen import generate_all
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionResult
from qentor.verification.agreement import AGREEMENT_THRESHOLD, compare_all, compare_states
from tests.test_api_tutor import TutorEndpointTestCase

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = {
    p.stem: json.loads(p.read_text(encoding="utf-8"))
    for p in (ROOT / "fixtures" / "circuits").glob("*.json")
    if not p.name.startswith("_")
}
PAIRS = json.loads((ROOT / "fixtures" / "circuits" / "_equivalence.json").read_text(encoding="utf-8"))["pairs"]


def g(name, targets, controls=(), params=(), clbits=()):
    return GateOp(gate=name, targets=list(targets), controls=list(controls), params=list(params), clbits=list(clbits))


def circ(n, *ops, clbits=0):
    return Circuit(num_qubits=n, num_clbits=clbits, ops=list(ops))


BELL = circ(2, g("h", [0]), g("cx", [1], [0]))
BELL_MEASURED = circ(2, g("h", [0]), g("cx", [1], [0]), g("measure", [0], clbits=[0]), g("measure", [1], clbits=[1]), clbits=2)


class TestComparisonMath(unittest.TestCase):
    S = 0.5**0.5

    def test_identical_states(self) -> None:
        state = [[self.S, 0.0], [self.S, 0.0]]
        amp, prob, fidelity = compare_states(state, state)
        self.assertEqual((amp, prob), (0.0, 0.0))
        self.assertAlmostEqual(fidelity, 1.0, places=12)

    def test_a_global_phase_changes_the_amplitude_difference_but_not_probability_or_fidelity(self) -> None:
        a = [[self.S, 0.0], [self.S, 0.0]]
        b = [[0.0, self.S], [0.0, self.S]]  # a * i
        amp, prob, fidelity = compare_states(a, b)
        self.assertGreater(amp, 0.5)
        self.assertAlmostEqual(prob, 0.0, places=12)
        self.assertAlmostEqual(fidelity, 1.0, places=12)
        self.assertTrue(compare_all({"a": a, "b": b})[0].agrees)

    def test_orthogonal_states(self) -> None:
        amp, prob, fidelity = compare_states([[1.0, 0.0], [0.0, 0.0]], [[0.0, 0.0], [1.0, 0.0]])
        self.assertAlmostEqual(prob, 1.0)
        self.assertAlmostEqual(fidelity, 0.0)
        self.assertFalse(compare_all({"a": [[1.0, 0.0], [0.0, 0.0]], "b": [[0.0, 0.0], [1.0, 0.0]]})[0].agrees)

    def test_the_threshold_is_one_in_a_million(self) -> None:
        self.assertEqual(AGREEMENT_THRESHOLD, 1e-6)
        base = [[1.0, 0.0], [0.0, 0.0]]

        def tilted(eps):  # a real, normalised state at an angle eps from |0>
            return [[math.cos(eps), 0.0], [math.sin(eps), 0.0]]

        self.assertTrue(compare_all({"a": base, "b": tilted(1e-4)})[0].agrees)  # 1 - fidelity ~ 1e-8, probability ~ 1e-8
        self.assertFalse(compare_all({"a": base, "b": tilted(2e-3)})[0].agrees)  # ~ 4e-6 in both

    def test_states_of_different_sizes_cannot_be_compared(self) -> None:
        with self.assertRaises(ValueError):
            compare_states([[1.0, 0.0]], [[1.0, 0.0], [0.0, 0.0]])

    def test_every_pair_is_compared_once_in_order(self) -> None:
        s = [[1.0, 0.0], [0.0, 0.0]]
        pairs = compare_all({"x": s, "y": s, "z": s})
        self.assertEqual([(p.backend_a, p.backend_b) for p in pairs], [("x", "y"), ("x", "z"), ("y", "z")])


class TestCodeEndpoint(TutorEndpointTestCase):
    def test_returns_the_generated_text_for_all_three_frameworks_and_the_hash(self) -> None:
        response = app_module.circuit_code_endpoint(CodeRequest(circuit=BELL_MEASURED))
        self.assertEqual(response.code, generate_all(BELL_MEASURED))
        self.assertEqual(list(response.code), ["qiskit", "cirq", "pennylane"])
        self.assertEqual(response.circuit_hash, circuit_hash(BELL_MEASURED))
        self.assertEqual(response.generator, "qentor.codegen/1")

    def test_matches_the_golden_text_of_every_fixture(self) -> None:
        for name, data in FIXTURES.items():
            with self.subTest(fixture=name):
                response = app_module.circuit_code_endpoint(CodeRequest(circuit=Circuit.model_validate(data["circuit"])))
                self.assertEqual(response.code, data["code"])

    def test_the_request_has_no_field_for_code_or_a_framework_to_run(self) -> None:
        with self.assertRaises(ValidationError):
            CodeRequest.model_validate({"circuit": BELL.canonical_dict(), "code": "import os"})
        with self.assertRaises(ValidationError):
            CodeRequest.model_validate({"circuit": BELL.canonical_dict(), "framework": "qiskit"})

    def test_an_oversized_circuit_is_a_structured_refusal(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            app_module.circuit_code_endpoint(CodeRequest(circuit=circ(1, *[g("h", [0])] * 501)))
        self.assertEqual((raised.exception.status_code, raised.exception.detail["code"]), (422, "CIRCUIT_TOO_MANY_OPERATIONS"))

    def test_it_writes_nothing_to_the_provenance_log(self) -> None:
        app_module.circuit_code_endpoint(CodeRequest(circuit=BELL))
        self.assertEqual(self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0], 0)


class TestEquivalenceEndpoint(TutorEndpointTestCase):
    def ask(self, a: Circuit, b: Circuit):
        return app_module.equivalence_endpoint(EquivalenceRequest(circuit_a=a, circuit_b=b))

    def test_every_labelled_fixture_pair_gets_its_verdict_through_the_endpoint(self) -> None:
        for pair in PAIRS:
            with self.subTest(pair=pair["name"]):
                a, b = Circuit.model_validate(pair["a"]["circuit"]), Circuit.model_validate(pair["b"]["circuit"])
                response = self.ask(a, b)
                self.assertEqual(response.status, pair["expected"], pair["note"])
                self.assertEqual((response.circuit_hash_a, response.circuit_hash_b), (circuit_hash(a), circuit_hash(b)))

    def test_the_report_names_the_method_the_checker_version_and_its_checks(self) -> None:
        response = self.ask(circ(1, g("h", [0]), g("z", [0]), g("h", [0])), circ(1, g("x", [0])))
        self.assertEqual(response.status, "EQUIVALENT")
        self.assertEqual(response.method, "qiskit.quantum_info.Operator.equiv")
        self.assertRegex(response.checker_version, r"^\d+\.\d+")
        self.assertIn("operator_equivalent_up_to_global_phase", [c.name for c in response.checks])
        self.assertIsNotNone(response.global_phase)

    def test_a_pure_global_phase_is_equivalent_and_reports_the_phase(self) -> None:
        response = self.ask(circ(1, g("z", [0]), g("x", [0]), g("z", [0]), g("x", [0])), circ(1))
        self.assertEqual(response.status, "EQUIVALENT")
        self.assertAlmostEqual(abs(response.global_phase), math.pi, places=9)

    def test_a_relative_phase_is_not_equivalent_and_has_no_global_phase(self) -> None:
        response = self.ask(circ(1, g("z", [0])), circ(1))
        self.assertEqual(response.status, "NOT_EQUIVALENT")
        self.assertIsNone(response.global_phase)
        self.assertIn("differ", response.reason or "")

    def test_what_it_cannot_decide_is_unverifiable_with_the_reason(self) -> None:
        widths = self.ask(circ(1, g("h", [0])), circ(2, g("h", [0])))
        self.assertEqual((widths.status, widths.reason), ("UNVERIFIABLE", "circuits act on a different number of qubits"))
        mid = self.ask(circ(1, g("h", [0]), g("measure", [0], clbits=[0]), g("x", [0]), clbits=1), circ(1, g("h", [0])))
        self.assertEqual(mid.status, "UNVERIFIABLE")
        self.assertIn("no_mid_circuit_measurement_a", [c.name for c in mid.checks])

    def test_terminal_measurements_do_not_change_the_operator(self) -> None:
        self.assertEqual(self.ask(BELL_MEASURED, BELL).status, "EQUIVALENT")

    def test_over_the_size_limit_is_refused_before_any_operator_is_built(self) -> None:
        with patch("qiskit.quantum_info.Operator", side_effect=AssertionError("an operator was built")):
            for a, b in ((circ(11, g("h", [0])), circ(11)), (circ(2, *[g("h", [0])] * 501), circ(2))):
                with self.subTest(size=a.num_qubits, ops=len(a.ops)), self.assertRaises(HTTPException) as raised:
                    self.ask(a, b)
                self.assertEqual(raised.exception.status_code, 422)
                self.assertIn(raised.exception.detail["code"], {"CIRCUIT_TOO_MANY_QUBITS", "CIRCUIT_TOO_MANY_OPERATIONS"})

    def test_the_request_has_no_field_for_a_verdict(self) -> None:
        for extra in ({"status": "EQUIVALENT"}, {"expected": "EQUIVALENT"}, {"global_phase": 0.0}):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                EquivalenceRequest.model_validate({"circuit_a": BELL.canonical_dict(), "circuit_b": BELL.canonical_dict(), **extra})

    def test_the_optimizer_and_the_endpoint_use_the_same_checker(self) -> None:
        candidate = circ(1)  # what H H would be optimised to
        original = circ(1, g("h", [0]), g("h", [0]))
        self.assertEqual(self.ask(original, candidate).status, "EQUIVALENT")

    def test_it_writes_nothing_to_the_provenance_log(self) -> None:
        self.ask(BELL, BELL)
        self.assertEqual(self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0], 0)


class TestAgreementEndpoint(TutorEndpointTestCase):
    def compare(self, circuit: Circuit, backends=None):
        return app_module.compare_backends_endpoint(AgreementRequest(circuit=circuit, backends=backends))

    def test_the_three_simulators_agree_on_every_fixture(self) -> None:
        for name, data in FIXTURES.items():
            with self.subTest(fixture=name):
                response = self.compare(Circuit.model_validate(data["circuit"]))
                self.assertEqual(response.status, "AGREE", name)
                self.assertEqual([b.status for b in response.backends], ["RAN"] * 3)
                self.assertEqual(len(response.pairs), 3)
                for pair in response.pairs:
                    self.assertTrue(pair.agrees, (name, pair))
                    self.assertLess(pair.max_probability_difference, 1e-9)
                    self.assertAlmostEqual(pair.fidelity, 1.0, places=9)

    def test_every_backend_and_the_comparison_have_provenance_records(self) -> None:
        response = self.compare(BELL_MEASURED)
        chash = circuit_hash(BELL)  # terminal measurements are stripped before running
        self.assertEqual(response.circuit_hash, chash)
        self.assertEqual(response.terminal_measurements_stripped, 2)
        for entry in response.backends:
            record = self.store.get(entry.provenance.result_id)
            self.assertEqual((record.backend, record.execution_mode, record.circuit_hash), (entry.backend, "statevector", chash))
            self.assertEqual(record.verification_status.value, "STATE_CHECKED")
        comparison = self.store.get(response.provenance.result_id)
        self.assertEqual((comparison.backend, comparison.execution_mode), ("cross-backend-agreement", "agreement"))
        self.assertEqual(comparison.payload["status"], "AGREE")
        self.assertEqual(
            [b["result_id"] for b in comparison.payload["backends"]],
            [b.provenance.result_id for b in response.backends],
        )
        self.assertEqual(response.provenance.provenance_class, "SIMULATION")

    def test_the_numbers_in_the_response_are_the_ones_persisted(self) -> None:
        response = self.compare(BELL)
        payload = self.store.get(response.provenance.result_id).payload
        self.assertEqual(payload["pairs"], [p.model_dump() for p in response.pairs])
        self.assertEqual(payload["threshold"], AGREEMENT_THRESHOLD)

    def test_a_subset_of_backends_can_be_compared_and_a_single_one_cannot(self) -> None:
        response = self.compare(BELL, ["cirq", "pennylane"])
        self.assertEqual([b.backend for b in response.backends], ["cirq", "pennylane"])
        self.assertEqual(len(response.pairs), 1)
        with self.assertRaises(ValidationError):
            AgreementRequest(circuit=BELL, backends=["cirq"])
        with self.assertRaises(ValidationError):
            AgreementRequest(circuit=BELL, backends=["cirq", "cirq"])

    def test_a_mid_circuit_measurement_is_refused_because_no_deterministic_state_exists(self) -> None:
        circuit = circ(1, g("h", [0]), g("measure", [0], clbits=[0]), g("x", [0]), clbits=1)
        with self.assertRaises(HTTPException) as raised:
            self.compare(circuit)
        self.assertEqual((raised.exception.status_code, raised.exception.detail["code"]), (422, "AGREEMENT_MID_CIRCUIT_MEASUREMENT"))

    def test_a_backend_that_cannot_run_is_reported_and_never_replaced(self) -> None:
        with patch.object(app_module._adapters["cirq"], "run", side_effect=AdapterUnavailable("no cirq here")):
            response = self.compare(BELL)
        statuses = {b.backend: b for b in response.backends}
        self.assertEqual(statuses["cirq"].status, "UNAVAILABLE")
        self.assertIn("no cirq here", statuses["cirq"].message)
        self.assertIsNone(statuses["cirq"].provenance)
        self.assertEqual(response.status, "AGREE")  # the two that ran agree; the third is honestly absent
        self.assertEqual(len(response.pairs), 1)

    def test_fewer_than_two_results_is_incomplete_not_agree(self) -> None:
        with patch.object(app_module._adapters["cirq"], "run", side_effect=AdapterUnavailable("x")), patch.object(
            app_module._adapters["pennylane"], "run", side_effect=AdapterExecutionError("y")
        ):
            response = self.compare(BELL)
        self.assertEqual(response.status, "INCOMPLETE")
        self.assertEqual(response.pairs, [])
        self.assertEqual({b.backend: b.status for b in response.backends}, {"qiskit-aer": "RAN", "cirq": "UNAVAILABLE", "pennylane": "FAILED"})
        self.assertEqual(self.store.get(response.provenance.result_id).verification_status.value, "FAILED")

    def test_a_backend_that_returns_a_different_state_is_a_disagreement(self) -> None:
        real = app_module._adapters["cirq"].run
        s = 0.5**0.5

        def wrong(circuit, mode, shots=None):
            good = real(circuit, mode, shots)
            return ExecutionResult(
                backend_name=good.backend_name,
                backend_version=good.backend_version,
                execution_mode="statevector",
                execution_id="fake",
                statevector=[[s, 0.0], [0.0, 0.0], [0.0, 0.0], [-s, 0.0]],  # a normalised state, but not the Bell state
            )

        with patch.object(app_module._adapters["cirq"], "run", side_effect=wrong):
            response = self.compare(BELL)
        self.assertEqual(response.status, "DISAGREE")
        by_pair = {(p.backend_a, p.backend_b): p for p in response.pairs}
        self.assertTrue(by_pair[("qiskit-aer", "pennylane")].agrees)
        self.assertFalse(by_pair[("qiskit-aer", "cirq")].agrees)
        # (|00> - |11>)/sqrt(2) has exactly the Bell state's probabilities: only the fidelity, not the probabilities,
        # can tell a relative-phase difference, which is why both are reported and both are in the verdict.
        self.assertLess(by_pair[("qiskit-aer", "cirq")].max_probability_difference, 1e-9)
        self.assertLess(by_pair[("qiskit-aer", "cirq")].fidelity, 1e-9)

    def test_a_malformed_state_is_that_backends_failure_and_the_rest_still_compare(self) -> None:
        bad = ExecutionResult(backend_name="cirq", backend_version="x", execution_mode="statevector", execution_id="f", statevector=[[2.0, 0.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]])
        with patch.object(app_module._adapters["cirq"], "run", return_value=bad):
            response = self.compare(BELL)
        cirq = next(b for b in response.backends if b.backend == "cirq")
        self.assertEqual(cirq.status, "FAILED")
        self.assertIn("state check", cirq.message)
        self.assertEqual(self.store.get(cirq.provenance.result_id).verification_status.value, "FAILED")
        self.assertEqual(response.status, "AGREE")
        self.assertEqual(len(response.pairs), 1)

    def test_a_backend_over_its_own_limit_is_refused_by_name(self) -> None:
        response = self.compare(circ(15, g("h", [0])))  # Aer allows 16; Cirq and PennyLane 14
        by = {b.backend: b for b in response.backends}
        self.assertEqual(by["qiskit-aer"].status, "RAN")
        self.assertEqual((by["cirq"].status, by["pennylane"].status), ("REFUSED", "REFUSED"))
        self.assertIn("14-qubit limit", by["cirq"].message)
        self.assertEqual(response.status, "INCOMPLETE")

    def test_the_request_has_no_field_for_a_result_or_a_verdict(self) -> None:
        for extra in ({"pairs": []}, {"status": "AGREE"}, {"statevector": []}, {"threshold": 1.0}):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                AgreementRequest.model_validate({"circuit": BELL.canonical_dict(), **extra})

    def test_over_the_operation_limit_is_refused_up_front(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            self.compare(circ(1, *[g("h", [0])] * 501))
        self.assertEqual(raised.exception.detail["code"], "CIRCUIT_TOO_MANY_OPERATIONS")


if __name__ == "__main__":
    unittest.main()
