"""Tests for the Cirq and PennyLane execution adapters, and their agreement
with the existing Qiskit Aer adapter on the same canonical circuit.

Real SDK calls throughout (no mocking of cirq/pennylane) — these are genuine
integration tests, consistent with test_aer_adapter.py's own style. No
network access or real IBM hardware is used or required; shots use a fixed
seed inside each adapter so results are reproducible run to run.
"""

from __future__ import annotations

import math
import unittest
from types import SimpleNamespace

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.pennylane_adapter import PennyLaneAdapter

BELL = Circuit(
    num_qubits=2,
    num_clbits=2,
    ops=[
        GateOp(gate="h", targets=[0]),
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="measure", targets=[0], clbits=[0]),
        GateOp(gate="measure", targets=[1], clbits=[1]),
    ],
)

BELL_NO_MEASURE = Circuit(
    num_qubits=2,
    num_clbits=0,
    ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])],
)

# 3 qubits, X on q0 only, every qubit measured. Distinguishes q0 from q1/q2 —
# a bit-order bug (e.g. reading the native library's own convention directly)
# would put the '1' in the wrong position instead of giving exactly "001".
ASYMMETRIC_X_ON_Q0 = Circuit(
    num_qubits=3,
    num_clbits=3,
    ops=[
        GateOp(gate="x", targets=[0]),
        GateOp(gate="measure", targets=[0], clbits=[0]),
        GateOp(gate="measure", targets=[1], clbits=[1]),
        GateOp(gate="measure", targets=[2], clbits=[2]),
    ],
)

# A rotation gate exercised so amplitude comparison covers more than Clifford
# gates (RX(pi/2) on |0> -> (|0> - i|1>)/sqrt(2), a genuinely complex state).
RX_CIRCUIT = Circuit(
    num_qubits=1,
    num_clbits=0,
    ops=[GateOp(gate="rx", targets=[0], params=[math.pi / 2])],
)

ADAPTERS = [
    ("qiskit-aer", AerAdapter()),
    ("cirq", CirqAdapter()),
    ("pennylane", PennyLaneAdapter()),
]


class AdapterTestCase(unittest.TestCase):
    """Turns AdapterUnavailable into an explicit skip, never a fake pass."""

    def run_or_skip(self, adapter, circuit: Circuit, mode: str, shots: int | None = None):
        try:
            return adapter.run(circuit, mode, shots)
        except AdapterUnavailable as exc:
            self.skipTest(f"{adapter.name} unavailable in this environment: {exc}")


class TestCrossAdapterAgreement(AdapterTestCase):
    """Item 1 + 6: identical circuits through all three adapters, and the
    normalisation that makes their results directly comparable."""

    def test_bell_statevector_matches_across_all_three_adapters(self) -> None:
        results = {name: self.run_or_skip(adapter, BELL_NO_MEASURE, "statevector") for name, adapter in ADAPTERS}

        reference = results["qiskit-aer"].statevector
        for name, result in results.items():
            self.assertEqual(len(result.statevector), len(reference), name)
            for (re_a, im_a), (re_b, im_b) in zip(result.statevector, reference):
                self.assertAlmostEqual(re_a, re_b, places=6, msg=f"{name} real part")
                self.assertAlmostEqual(im_a, im_b, places=6, msg=f"{name} imaginary part")

    def test_rx_statevector_matches_across_all_three_adapters(self) -> None:
        """A non-Clifford, genuinely complex amplitude — not just the
        real-valued, qubit-swap-symmetric Bell state."""
        results = {name: self.run_or_skip(adapter, RX_CIRCUIT, "statevector") for name, adapter in ADAPTERS}

        reference = results["qiskit-aer"].statevector
        for name, result in results.items():
            for (re_a, im_a), (re_b, im_b) in zip(result.statevector, reference):
                self.assertAlmostEqual(re_a, re_b, places=6, msg=f"{name} real part")
                self.assertAlmostEqual(im_a, im_b, places=6, msg=f"{name} imaginary part")

    def test_asymmetric_circuit_shots_agree_on_bit_order_across_adapters(self) -> None:
        """The critical normalisation proof: X on q0 only, in a 3-qubit
        register, must give exactly "001" (q2=0, q1=0, q0=1) on every
        adapter — a bit-order bug would put the 1 in the wrong position."""
        for name, adapter in ADAPTERS:
            result = self.run_or_skip(adapter, ASYMMETRIC_X_ON_Q0, "shots", shots=200)
            with self.subTest(adapter=name):
                self.assertEqual(set(result.counts.keys()), {"001"})
                self.assertEqual(result.counts["001"], 200)

    def test_bell_shots_only_ever_produce_00_or_11_on_every_adapter(self) -> None:
        for name, adapter in ADAPTERS:
            result = self.run_or_skip(adapter, BELL, "shots", shots=2000)
            with self.subTest(adapter=name):
                self.assertEqual(sum(result.counts.values()), 2000)
                self.assertEqual(set(result.counts.keys()) - {"00", "11"}, set())
                for outcome in ("00", "11"):
                    self.assertIn(outcome, result.probabilities)
                    self.assertAlmostEqual(result.probabilities[outcome], 0.5, delta=0.07)


class TestNormalizedProvenanceFields(AdapterTestCase):
    """Item 6: the persisted result must clearly identify which adapter/SDK
    produced it, in the same shape regardless of which one ran."""

    def test_each_adapter_reports_its_own_name_and_a_real_version_string(self) -> None:
        expected_execution_id_prefix = {"qiskit-aer": "aer-local-", "cirq": "cirq-local-", "pennylane": "pennylane-local-"}
        for name, adapter in ADAPTERS:
            result = self.run_or_skip(adapter, BELL_NO_MEASURE, "statevector")
            with self.subTest(adapter=name):
                self.assertEqual(result.backend_name, name)
                self.assertIsInstance(result.backend_version, str)
                self.assertTrue(len(result.backend_version) > 0)
                self.assertTrue(result.execution_id.startswith(expected_execution_id_prefix[name]))

    def test_payload_shape_is_identical_regardless_of_adapter(self) -> None:
        for name, adapter in ADAPTERS:
            sv_result = self.run_or_skip(adapter, BELL_NO_MEASURE, "statevector")
            shots_result = self.run_or_skip(adapter, BELL, "shots", shots=500)
            with self.subTest(adapter=name):
                self.assertEqual(set(sv_result.to_payload().keys()), {"execution_id", "statevector", "theoretical_probabilities"})
                self.assertEqual(set(shots_result.to_payload().keys()), {"execution_id", "counts", "probabilities", "shots"})


class TestCirqAdapter(AdapterTestCase):
    def setUp(self) -> None:
        self.adapter = CirqAdapter()

    def test_statevector_norm_is_one(self) -> None:
        result = self.run_or_skip(self.adapter, BELL_NO_MEASURE, "statevector")
        norm = sum(re * re + im * im for re, im in result.statevector)
        self.assertAlmostEqual(norm, 1.0, places=9)

    def test_shots_probabilities_sum_to_one(self) -> None:
        result = self.run_or_skip(self.adapter, BELL, "shots", shots=1000)
        self.assertAlmostEqual(sum(result.probabilities.values()), 1.0, places=9)

    def test_shots_mode_without_measurement_raises(self) -> None:
        try:
            with self.assertRaises(AdapterExecutionError):
                self.adapter.run(BELL_NO_MEASURE, "shots", shots=100)
        except AdapterUnavailable as exc:
            self.skipTest(f"cirq unavailable in this environment: {exc}")

    def test_zero_shots_raises(self) -> None:
        try:
            with self.assertRaises(AdapterExecutionError):
                self.adapter.run(BELL, "shots", shots=0)
        except AdapterUnavailable as exc:
            self.skipTest(f"cirq unavailable in this environment: {exc}")

    def test_unsupported_gate_fails_explicitly_rather_than_substituting(self) -> None:
        # The canonical Circuit/GateOp model rejects an unknown gate name
        # before it can ever reach an adapter (pydantic validation runs even
        # on a pre-built GateOp nested in a Circuit) — so this exercises the
        # adapter's own defensive dispatch directly with a duck-typed circuit,
        # the only way to reach that branch at all. Never a shipped fixture;
        # CLAUDE.md: "test fixtures stay in tests."
        fake_op = SimpleNamespace(gate="swap", targets=[0], controls=[], params=[], clbits=[])
        fake_circuit = SimpleNamespace(num_qubits=1, num_clbits=0, ops=[fake_op])
        try:
            with self.assertRaises(AdapterExecutionError):
                self.adapter.run(fake_circuit, "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"cirq unavailable in this environment: {exc}")

    def test_deterministic_shots_with_fixed_seed(self) -> None:
        r1 = self.run_or_skip(self.adapter, BELL, "shots", shots=500)
        r2 = self.run_or_skip(CirqAdapter(), BELL, "shots", shots=500)
        self.assertEqual(r1.counts, r2.counts)


class TestPennyLaneAdapter(AdapterTestCase):
    def setUp(self) -> None:
        self.adapter = PennyLaneAdapter()

    def test_statevector_norm_is_one(self) -> None:
        result = self.run_or_skip(self.adapter, BELL_NO_MEASURE, "statevector")
        norm = sum(re * re + im * im for re, im in result.statevector)
        self.assertAlmostEqual(norm, 1.0, places=9)

    def test_shots_probabilities_sum_to_one(self) -> None:
        result = self.run_or_skip(self.adapter, BELL, "shots", shots=1000)
        self.assertAlmostEqual(sum(result.probabilities.values()), 1.0, places=9)

    def test_shots_mode_without_measurement_raises(self) -> None:
        try:
            with self.assertRaises(AdapterExecutionError):
                self.adapter.run(BELL_NO_MEASURE, "shots", shots=100)
        except AdapterUnavailable as exc:
            self.skipTest(f"pennylane unavailable in this environment: {exc}")

    def test_zero_shots_raises(self) -> None:
        try:
            with self.assertRaises(AdapterExecutionError):
                self.adapter.run(BELL, "shots", shots=0)
        except AdapterUnavailable as exc:
            self.skipTest(f"pennylane unavailable in this environment: {exc}")

    def test_unsupported_gate_fails_explicitly_rather_than_substituting(self) -> None:
        fake_op = SimpleNamespace(gate="swap", targets=[0], controls=[], params=[], clbits=[])
        fake_circuit = SimpleNamespace(num_qubits=1, num_clbits=0, ops=[fake_op])
        try:
            with self.assertRaises(AdapterExecutionError):
                self.adapter.run(fake_circuit, "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"pennylane unavailable in this environment: {exc}")

    def test_deterministic_shots_with_fixed_seed(self) -> None:
        r1 = self.run_or_skip(self.adapter, BELL, "shots", shots=500)
        r2 = self.run_or_skip(PennyLaneAdapter(), BELL, "shots", shots=500)
        self.assertEqual(r1.counts, r2.counts)

    def test_partial_measurement_pads_unmeasured_clbits_with_zero(self) -> None:
        """Only q0 and q1 measured, into clbits 0 and 1, of a 3-clbit
        register; clbit 2 is never written and must default to '0' —
        mirrors AerAdapter's own behaviour for the identical scenario
        (see test_verification_bell_state's real-bug regression test)."""
        circuit = Circuit(
            num_qubits=2,
            num_clbits=3,
            ops=[
                GateOp(gate="h", targets=[0]),
                GateOp(gate="cx", controls=[0], targets=[1]),
                GateOp(gate="measure", targets=[0], clbits=[0]),
                GateOp(gate="measure", targets=[1], clbits=[1]),
            ],
        )
        result = self.run_or_skip(self.adapter, circuit, "shots", shots=500)
        self.assertEqual(set(result.counts.keys()), {"000", "011"})


class TestApiExecuteBackendSelection(unittest.TestCase):
    """Item 7: adapter selection through /api/execute, and item 8: the
    default (unspecified) backend is exactly the original Aer path."""

    def setUp(self) -> None:
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        from qentor.api import app as app_module
        from qentor.provenance.store import ProvenanceStore

        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")
        except Exception:
            pass

        self.app_module = app_module
        self._tmpdir = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmpdir.name) / "backends.db")
        self._patcher = patch.object(app_module, "_store", self.store)
        self._patcher.start()

    def tearDown(self) -> None:
        self._patcher.stop()
        self.store.close()
        self._tmpdir.cleanup()

    def test_each_backend_value_selects_the_matching_adapter(self) -> None:
        from qentor.api.schemas import ExecuteRequest

        for backend in ("qiskit-aer", "cirq", "pennylane"):
            try:
                response = self.app_module.execute(
                    ExecuteRequest(circuit=BELL, mode="shots", shots=500, backend=backend)
                )
            except AdapterUnavailable as exc:
                self.skipTest(f"{backend} unavailable in this environment: {exc}")
            with self.subTest(backend=backend):
                self.assertEqual(response.backend, backend)
                self.assertEqual(sum(response.payload["counts"].values()), 500)

    def test_omitting_backend_defaults_to_qiskit_aer_unchanged(self) -> None:
        from qentor.api.schemas import ExecuteRequest

        response = self.app_module.execute(ExecuteRequest(circuit=BELL, mode="shots", shots=500))
        self.assertEqual(response.backend, "qiskit-aer")

    def test_unknown_backend_value_is_rejected_by_the_request_schema(self) -> None:
        from pydantic import ValidationError

        from qentor.api.schemas import ExecuteRequest

        with self.assertRaises(ValidationError):
            ExecuteRequest.model_validate(
                {"circuit": BELL.canonical_dict(), "mode": "shots", "shots": 500, "backend": "not-a-real-backend"}
            )


if __name__ == "__main__":
    unittest.main()
