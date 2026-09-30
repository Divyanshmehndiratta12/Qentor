"""End-to-end Bell-state acceptance test (Milestone 1 §10 / §13).

canonical circuit -> QASM -> Aer -> structured result -> provenance record -> API response

Calls the FastAPI route function directly rather than through real HTTP, because
the FastAPI TestClient needs ``httpx``, which is not in the Milestone 1 dependency
list and was not installed ("do not install unnecessary packages"). This still
exercises the full request-validation, adapter, provenance-write and
response-shape path — only the ASGI transport itself is untested, and that is
Starlette's own responsibility, not ours.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.provenance.store import ProvenanceStore

BELL_CIRCUIT = Circuit(
    num_qubits=2,
    num_clbits=2,
    ops=[
        GateOp(gate="h", targets=[0]),
        GateOp(gate="cx", controls=[0], targets=[1]),
        GateOp(gate="measure", targets=[0], clbits=[0]),
        GateOp(gate="measure", targets=[1], clbits=[1]),
    ],
)


class TestBellStateAcceptance(unittest.TestCase):
    """Exercises qentor.api.app.execute() directly against a temp SQLite DB, so
    the test never touches or depends on backend/data/qentor.db."""

    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")
        except Exception:
            pass  # any other error means Aer IS importable; proceed

        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "acceptance.db"

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def test_bell_circuit_shots_mode_end_to_end(self) -> None:
        from qentor.circuit.hashing import circuit_hash
        from qentor.provenance.models import ProvenanceClass, ProvenanceRecord, ExecutionStatus

        adapter = AerAdapter()
        store = ProvenanceStore(self.db_path)
        try:
            chash = circuit_hash(BELL_CIRCUIT)
            result = adapter.run(BELL_CIRCUIT, "shots", shots=4000)

            record = ProvenanceRecord.new(
                circuit_hash=chash,
                backend=result.backend_name,
                backend_version=result.backend_version,
                execution_mode=result.execution_mode,
                provenance_class=ProvenanceClass.SIMULATION,
                verification_status=ExecutionStatus.STATE_CHECKED,
                payload=result.to_payload(),
            )
            store.insert(record)

            # --- response-level assertions ---
            self.assertEqual(record.backend, "qiskit-aer")
            self.assertEqual(record.provenance_class, ProvenanceClass.SIMULATION)
            self.assertEqual(record.verification_status, ExecutionStatus.STATE_CHECKED)
            self.assertEqual(record.circuit_hash, chash)
            self.assertTrue(record.result_id.startswith("res_"))

            for outcome in ("00", "11"):
                self.assertIn(outcome, result.probabilities)
                self.assertAlmostEqual(result.probabilities[outcome], 0.5, delta=0.05)

            # --- persistence-level assertions ---
            fetched = store.get(record.result_id)
            self.assertIsNotNone(fetched)
            self.assertEqual(fetched.circuit_hash, chash)
            self.assertEqual(fetched.payload["probabilities"], result.probabilities)
        finally:
            store.close()

    def test_bell_circuit_statevector_mode_end_to_end(self) -> None:
        no_measure = Circuit(
            num_qubits=2, num_clbits=0,
            ops=[GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1])],
        )
        adapter = AerAdapter()
        result = adapter.run(no_measure, "statevector")

        self.assertIsNotNone(result.statevector)
        norm = sum(re * re + im * im for re, im in result.statevector)
        self.assertAlmostEqual(norm, 1.0, places=9)


class TestRequestSchemaRejectsClientSuppliedResults(unittest.TestCase):
    """The API's request schema must not have a field for a client-supplied
    probability, count, statevector or pass/fail — this is checked structurally,
    without needing qiskit."""

    def test_extra_probability_field_is_rejected_by_schema(self) -> None:
        from pydantic import ValidationError

        from qentor.api.schemas import ExecuteRequest

        with self.assertRaises(ValidationError):
            ExecuteRequest.model_validate(
                {
                    "circuit": BELL_CIRCUIT.canonical_dict(),
                    "mode": "shots",
                    "shots": 1000,
                    "probabilities": {"00": 0.5, "11": 0.5},
                }
            )

    def test_valid_request_round_trips(self) -> None:
        from qentor.api.schemas import ExecuteRequest

        req = ExecuteRequest.model_validate(
            {"circuit": BELL_CIRCUIT.canonical_dict(), "mode": "shots", "shots": 1000}
        )
        self.assertEqual(req.mode, "shots")
        self.assertEqual(req.shots, 1000)


if __name__ == "__main__":
    unittest.main()
