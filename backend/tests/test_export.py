"""Share / export: a portable description of a circuit, with metadata but no results and nothing of the server's."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ExecuteRequest, ExportRequest
from qentor.challenges.content import circ, g
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.qasm import to_qasm3
from qentor.provenance.store import ProvenanceStore

BELL = circ(2, [g("h", 0), g("cx", 1, 0)])


class TestExport(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "export.db"
        self.store = ProvenanceStore(self.db_path)
        self._patch = patch.object(app_module, "_store", self.store)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self.store.close()
        self._tmp.cleanup()

    def export(self, circuit=BELL, result_id=None):
        return app_module.export_circuit_endpoint(ExportRequest(circuit=circuit, result_id=result_id))

    def test_bundle_has_the_circuit_qasm_code_and_hash(self) -> None:
        r = self.export()
        self.assertEqual(r.format, "qentor.export/1")
        self.assertEqual(r.circuit_hash, circuit_hash(BELL))
        self.assertEqual(r.qasm, to_qasm3(BELL))
        self.assertEqual(set(r.code), {"qiskit", "cirq", "pennylane"})
        self.assertEqual(r.circuit, BELL)
        self.assertIsNone(r.execution)

    def test_generated_code_is_text_only_and_matches_the_code_endpoint(self) -> None:
        from qentor.circuit.codegen import generate_all

        self.assertEqual(self.export().code, generate_all(BELL))

    def test_a_named_run_contributes_its_metadata_only(self) -> None:
        ex = app_module.execute(ExecuteRequest(circuit=BELL, mode="statevector"))
        r = self.export(result_id=ex.result_id)
        self.assertEqual(r.execution.result_id, ex.result_id)
        self.assertEqual((r.execution.backend, r.execution.provenance_class), ("qiskit-aer", "SIMULATION"))
        self.assertEqual(
            set(r.model_dump(mode="json")["execution"]),
            {"result_id", "circuit_hash", "backend", "backend_version", "execution_mode", "provenance_class", "verification_status", "created_at"},
        )
        dumped = json.dumps(r.model_dump(mode="json", by_alias=True))
        for forbidden in ('"probabilities"', '"counts"', '"theoretical_probabilities"', '"payload"', '"execution_id"', '"amplitude'):
            self.assertNotIn(forbidden, dumped)

    def test_nothing_of_the_server_leaks(self) -> None:
        ex = app_module.execute(ExecuteRequest(circuit=BELL, mode="statevector"))
        dumped = json.dumps(self.export(result_id=ex.result_id).model_dump(mode="json", by_alias=True))
        for secret in (str(self.db_path), self._tmp.name, "/home/", "qentor.db", "API_KEY", "api_key", "sk-", "QENTOR_TUTOR"):
            self.assertNotIn(secret, dumped)

    def test_unknown_run_is_404_and_a_run_of_another_circuit_is_422(self) -> None:
        with self.assertRaises(HTTPException) as c:
            self.export(result_id="res_nope")
        self.assertEqual(c.exception.status_code, 404)
        ex = app_module.execute(ExecuteRequest(circuit=circ(1, [g("h", 0)]), mode="statevector"))
        with self.assertRaises(HTTPException) as c:
            self.export(result_id=ex.result_id)
        self.assertEqual(c.exception.status_code, 422)

    def test_the_request_has_no_field_for_results(self) -> None:
        for field in ("probabilities", "statevector", "counts", "verdict"):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                ExportRequest.model_validate({"circuit": BELL.model_dump(by_alias=True), field: 1})

    def test_an_oversized_circuit_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as c:
            self.export(circ(1, [g("h", 0)] * 501))
        self.assertEqual(c.exception.status_code, 422)

    def test_the_note_says_there_are_no_results_in_it(self) -> None:
        self.assertIn("no results", self.export().note)

    def test_the_bundle_round_trips_into_the_same_circuit(self) -> None:
        from qentor.circuit.model import Circuit

        r = self.export()
        again = Circuit.model_validate(json.loads(json.dumps(r.model_dump(mode="json", by_alias=True)))["circuit"])
        self.assertEqual(circuit_hash(again), r.circuit_hash)


if __name__ == "__main__":
    unittest.main()
