"""SQLite provenance persistence — pure Python, no qiskit needed."""

from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

from qentor.provenance.models import ProvenanceClass, ProvenanceRecord, VerificationStatus
from qentor.provenance.store import ProvenanceStore


class TestProvenanceStore(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmpdir.name) / "test.db"
        self.store = ProvenanceStore(self.db_path)

    def tearDown(self) -> None:
        self.store.close()
        self._tmpdir.cleanup()

    def _record(self, circuit_hash: str = "abc123") -> ProvenanceRecord:
        return ProvenanceRecord.new(
            circuit_hash=circuit_hash,
            backend="qiskit-aer",
            backend_version="0.17.2",
            execution_mode="statevector",
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=VerificationStatus.VERIFIED,
            payload={"statevector": [[0.7071, 0.0], [0.0, 0.0], [0.0, 0.0], [0.7071, 0.0]]},
        )

    def test_insert_and_get_round_trip(self) -> None:
        record = self._record()
        self.store.insert(record)
        fetched = self.store.get(record.result_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.result_id, record.result_id)
        self.assertEqual(fetched.circuit_hash, "abc123")
        self.assertEqual(fetched.backend, "qiskit-aer")
        self.assertEqual(fetched.provenance_class, ProvenanceClass.SIMULATION)
        self.assertEqual(fetched.verification_status, VerificationStatus.VERIFIED)
        self.assertEqual(fetched.payload["statevector"][0], [0.7071, 0.0])

    def test_get_unknown_id_returns_none(self) -> None:
        self.assertIsNone(self.store.get("res_does_not_exist"))

    def test_list_by_circuit_hash(self) -> None:
        r1 = self._record(circuit_hash="hash-a")
        r2 = self._record(circuit_hash="hash-a")
        r3 = self._record(circuit_hash="hash-b")
        self.store.insert(r1)
        self.store.insert(r2)
        self.store.insert(r3)
        results = self.store.list_by_circuit_hash("hash-a")
        self.assertEqual({r.result_id for r in results}, {r1.result_id, r2.result_id})

    def test_result_ids_are_unique(self) -> None:
        r1 = self._record()
        r2 = self._record()
        self.assertNotEqual(r1.result_id, r2.result_id)

    def test_insert_and_get_from_different_thread(self) -> None:
        # Mirrors qentor/api/app.py: a module-level ProvenanceStore constructed on
        # one thread (here, the test's main thread) but used from another, the way
        # FastAPI dispatches sync path operations to a worker threadpool. Before the
        # fix this raised sqlite3.ProgrammingError: "SQLite objects created in a
        # thread can only be used in that same thread."
        record = self._record(circuit_hash="cross-thread")
        errors: list[BaseException] = []

        def worker() -> None:
            try:
                self.store.insert(record)
            except BaseException as exc:  # noqa: BLE001 - want to see it fail loudly if raised
                errors.append(exc)

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()

        self.assertEqual(errors, [])
        fetched = self.store.get(record.result_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.circuit_hash, "cross-thread")

    def test_concurrent_inserts_from_many_threads_all_persist(self) -> None:
        records = [self._record(circuit_hash="concurrent") for _ in range(20)]
        errors: list[BaseException] = []

        def worker(rec: ProvenanceRecord) -> None:
            try:
                self.store.insert(rec)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(r,)) for r in records]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        stored = self.store.list_by_circuit_hash("concurrent")
        self.assertEqual({r.result_id for r in stored}, {r.result_id for r in records})

    def test_reopening_store_preserves_data(self) -> None:
        record = self._record()
        self.store.insert(record)
        self.store.close()
        reopened = ProvenanceStore(self.db_path)
        try:
            fetched = reopened.get(record.result_id)
            self.assertIsNotNone(fetched)
            self.assertEqual(fetched.result_id, record.result_id)
        finally:
            reopened.close()


if __name__ == "__main__":
    unittest.main()
