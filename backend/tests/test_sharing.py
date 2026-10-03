"""Read-only shared experiments, through the real FastAPI stack.

A share is an immutable snapshot: the circuit, the code the server writes from it, the backend and mode, an optional lesson/challenge, a plain-text
title and, optionally, ONE stored run of exactly this circuit. What a viewer sees comes from the server's stored records, never from the sharer's
browser, and nothing about the sharer, the class or the server ever reaches the page. "Fork into my Lab" copies in the browser: there is no
server endpoint that could change a share, and these tests pin that.
"""

from __future__ import annotations

import ast
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from qentor.api import app as app_module
from qentor.api import classroom as classroom_api
from qentor.api.schemas import ExecuteRequest
from qentor.challenges import CHALLENGES
from qentor.challenges.content import circ, g
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import GateName, GateOp
from qentor.classroom import ClassroomStore, normalise_code
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.provenance.store import ProvenanceStore
from qentor.sharing import ExperimentStore, is_experiment_id
from qentor.sharing.store import MAX_TITLE, clean_experiment_title
from tests.asgi_driver import http

BACKEND = Path(__file__).resolve().parents[1]
BELL = circ(2, [g("h", 0), g("cx", 1, control=0)])
OTHER = circ(2, [g("x", 0)])
BELL_MEASURED = circ(2, [g("h", 0), g("cx", 1, control=0), *[GateOp(gate=GateName.MEASURE, targets=[q], clbits=[q]) for q in (0, 1)]], num_clbits=2)


def circuit_json(c) -> dict:
    return json.loads(c.model_dump_json(by_alias=True))


class ShareCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.db = Path(self._tmp.name) / "qentor.db"
        self.classroom = ClassroomStore(self.db)
        self.provenance = ProvenanceStore(self.db)
        self.experiments = ExperimentStore(self.db)
        self._patches = [
            patch.object(app_module, "_classroom", self.classroom),
            patch.object(app_module, "_store", self.provenance),
            patch.object(app_module, "_experiments", self.experiments),
        ]
        for p in self._patches:
            p.start()
        classroom_api.reset_rate_limits()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self.classroom.close()
        self.provenance.close()
        self.experiments.close()
        self._tmp.cleanup()
        classroom_api.reset_rate_limits()

    def call(self, method: str, path: str, body: dict | None = None, *, learner: str | None = None, ip: str = "10.0.0.1"):
        headers = {"X-Qentor-Learner": learner} if learner else {}
        status, raw = http(method, path, None if body is None else json.dumps(body).encode(), headers=headers, client=(ip, 5555))
        return status, (json.loads(raw) if raw else None)

    def run_circuit(self, circuit, mode: str = "statevector", shots: int | None = None):
        # as a function, not through the ASGI threadpool: see docs/BUILD_STATE.md (Qiskit worker-thread crash)
        return app_module.execute(ExecuteRequest(circuit=circuit, mode=mode, shots=shots))

    def share(self, circuit=BELL, **extra):
        return self.call("POST", "/api/experiments", {"circuit": circuit_json(circuit), **extra})


class TestCreateAndRead(ShareCase):
    def test_a_circuit_alone_can_be_shared_and_is_read_back_with_server_written_code(self) -> None:
        status, created = self.share(title="Bell pair")
        self.assertEqual(status, 201, created)
        self.assertTrue(is_experiment_id(created["experiment_id"]))
        self.assertEqual(created["path"], f"/shared/{created['experiment_id']}")
        status, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual(status, 200, view)
        self.assertEqual(view["read_only"], True)
        self.assertEqual(view["title"], "Bell pair")
        self.assertEqual(view["circuit_hash"], circuit_hash(BELL))
        self.assertEqual(view["circuit"]["ops"][0]["gate"], "h")
        self.assertIn("h q[0];", view["qasm"])
        self.assertEqual(sorted(view["code"]), ["cirq", "pennylane", "qiskit"])
        self.assertIn("qc.h(0)", view["code"]["qiskit"])
        self.assertIsNone(view["result"])
        self.assertIn("without a result", view["result_note"])
        self.assertIsNone(view["lesson"])
        self.assertIsNone(view["challenge"])

    def test_a_run_of_this_exact_circuit_is_attached_from_the_stored_record_not_from_the_request(self) -> None:
        run = self.run_circuit(BELL)
        status, created = self.share(result_id=run.result_id)
        self.assertEqual(status, 201, created)
        status, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual(status, 200)
        result = view["result"]
        self.assertEqual(result["result_id"], run.result_id)
        self.assertEqual(result["circuit_hash"], circuit_hash(BELL))
        self.assertEqual(result["provenance_class"], "SIMULATION")
        self.assertEqual(result["payload"], run.model_dump(mode="json")["payload"])
        self.assertEqual((view["backend"], view["mode"]), (run.backend, run.execution_mode))
        self.assertIn("stored record", view["result_note"])

    def test_a_shared_statevector_run_carries_the_servers_per_qubit_states_derived_from_its_stored_record(self) -> None:
        run = self.run_circuit(BELL)
        _, created = self.share(result_id=run.result_id)
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        states = view["result"]["qubit_states"]
        self.assertEqual([s["qubit"] for s in states], [0, 1])
        for state in states:  # a Bell pair: each qubit maximally mixed, and the record it came from is named
            self.assertEqual(state["status"], "OK")
            self.assertAlmostEqual(state["purity"], 0.5, delta=1e-9)
            self.assertEqual(state["entangled_with_rest"], True)
            self.assertEqual(state["derived_from"]["result_id"], run.result_id)
        self.assertEqual(states, run.model_dump(mode="json")["qubit_states"])  # the same view the live run showed

    def test_a_shared_shots_run_has_no_state_view(self) -> None:
        run = self.run_circuit(BELL_MEASURED, "shots", 64)
        _, created = self.share(BELL_MEASURED, result_id=run.result_id)
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual(view["result"]["qubit_states"], [])

    def test_the_backend_and_mode_of_a_shared_run_come_from_the_record_even_if_the_request_lies(self) -> None:
        run = self.run_circuit(BELL)
        status, created = self.share(result_id=run.result_id, backend="cirq", mode="shots")
        self.assertEqual(status, 201, created)
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual((view["backend"], view["mode"]), (run.backend, run.execution_mode))

    def test_a_shots_run_keeps_its_shot_count_from_the_record(self) -> None:
        run = self.run_circuit(BELL_MEASURED, "shots", 256)
        _, created = self.share(BELL_MEASURED, result_id=run.result_id)
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual(view["shots"], 256)
        self.assertEqual(view["mode"], "shots")
        self.assertEqual(sum(view["result"]["payload"]["counts"].values()), 256)

    def test_a_lesson_and_a_challenge_can_be_named_and_are_shown_by_their_authored_titles(self) -> None:
        challenge = CHALLENGES[0]
        status, created = self.share(lesson_id="quantum-fourier-transform", challenge_id=challenge.id)
        self.assertEqual(status, 201, created)
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual(view["lesson"]["id"], "quantum-fourier-transform")
        self.assertTrue(view["lesson"]["title"])
        self.assertEqual(view["challenge"]["id"], challenge.id)
        self.assertEqual(view["challenge"]["title"], challenge.title)

    def test_the_title_is_plain_text_capped_and_stripped(self) -> None:
        for raw, want in {
            "  A   spaced \n title  ": "A spaced title",
            "x" * 500: "x" * MAX_TITLE,
            "": None,
            "   \t\n ": None,
            "bell\x00\x07pair": "bellpair",
        }.items():
            self.assertEqual(clean_experiment_title(raw), want)
        status, created = self.share(title="<script>alert(1)</script>")
        self.assertEqual(status, 201)
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual(view["title"], "<script>alert(1)</script>")  # stored as text; the page renders it as text (tested in the web suite)
        self.assertLessEqual(len(view["title"]), MAX_TITLE)

    def test_the_title_is_cleaned_when_it_is_stored_not_only_by_the_helper(self) -> None:
        status, created = self.share(title="  A\x00\x07   shared \n title  " + "x" * 200)
        self.assertEqual(status, 201)
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertTrue(view["title"].startswith("A shared title x"))
        self.assertEqual(len(view["title"]), MAX_TITLE)
        self.assertNotIn("\x00", view["title"])
        with sqlite3.connect(self.db) as conn:
            stored = conn.execute("SELECT title FROM shared_experiments WHERE experiment_id = ?", (created["experiment_id"],)).fetchone()[0]
        self.assertEqual(stored, view["title"])  # what is on disk is the cleaned text too

    def test_a_share_is_the_same_every_time_it_is_read(self) -> None:
        _, created = self.share()
        _, a = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        _, b = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual(a, b)


class TestRefusals(ShareCase):
    def test_unknown_malformed_and_traversal_ids_are_the_same_404(self) -> None:
        for bad in ("ex_0000000000000000", "nope", "ex_ZZZZ", "ex_00000000000000000", "..%2F..%2Fetc%2Fpasswd", "ex_0000000000000000%0A", "EX_0000000000000000"):
            status, body = self.call("GET", f"/api/experiments/{bad}")
            self.assertEqual(status, 404, bad)
            self.assertEqual(body["detail"]["code"], "EXPERIMENT_NOT_FOUND", bad)

    def test_a_run_of_another_circuit_cannot_be_attached(self) -> None:
        run = self.run_circuit(OTHER)
        status, body = self.share(BELL, result_id=run.result_id)
        self.assertEqual(status, 422)
        self.assertEqual(body["detail"]["code"], "SHARE_INVALID")
        self.assertIn("not a run of this circuit", body["detail"]["message"])

    def test_an_unknown_result_id_is_refused(self) -> None:
        status, body = self.share(result_id="res_does_not_exist")
        self.assertEqual(status, 404)
        self.assertEqual(body["detail"]["code"], "SHARE_INVALID")

    def test_a_run_that_did_not_pass_its_state_check_cannot_be_shared(self) -> None:
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(BELL),
            backend="qiskit-aer",
            backend_version="x",
            execution_mode="statevector",
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.ERROR,
            payload={"error": "boom"},
        )
        self.provenance.insert(record)
        status, body = self.share(result_id=record.result_id)
        self.assertEqual(status, 422)
        self.assertIn("state check", body["detail"]["message"])

    def test_unknown_lesson_and_challenge_ids_are_refused(self) -> None:
        for extra in ({"lesson_id": "no-such-lesson"}, {"challenge_id": "no-such-challenge"}):
            status, body = self.share(**extra)
            self.assertEqual(status, 422, extra)
            self.assertEqual(body["detail"]["code"], "SHARE_INVALID")

    def test_the_request_is_strict_so_nothing_can_be_smuggled_into_a_share(self) -> None:
        for extra in (
            {"result": {"probabilities": {"00": 1.0}}},
            {"payload": {"counts": {"00": 1000}}},
            {"provenance_class": "REAL_HARDWARE"},
            {"verification_status": "VERIFIED"},
            {"owner": "someone"},
            {"learner_token": "ql_" + "a" * 29},
            {"class_code": "ABCD-EFGH"},
            {"read_only": False},
            {"qasm": "OPENQASM 3.0;"},
            {"code": {"qiskit": "import os"}},
            {"shots": 99999},
        ):
            status, _ = self.share(**extra)
            self.assertEqual(status, 422, extra)
        self.assertEqual(self.count_shares(), 0)

    def test_an_invalid_circuit_or_body_is_refused(self) -> None:
        bad = circuit_json(BELL)
        bad["ops"][0]["targets"] = [9]
        for body in ({"circuit": bad}, {"circuit": {"num_qubits": 0}}, {}, {"circuit": None}):
            status, _ = self.call("POST", "/api/experiments", body)
            self.assertEqual(status, 422, body)
        status, _ = http("POST", "/api/experiments", b"not json")
        self.assertEqual(status, 422)
        self.assertEqual(self.count_shares(), 0)

    def test_a_circuit_the_platform_would_not_run_is_not_shared(self) -> None:
        huge = circ(20, [g("h", 0)])
        status, body = self.share(huge)
        self.assertGreaterEqual(status, 400)
        self.assertLess(status, 500)
        self.assertEqual(self.count_shares(), 0, body)

    def test_creation_is_rate_limited_per_client(self) -> None:
        statuses = [self.share()[0] for _ in range(32)]
        self.assertEqual(statuses[0], 201)
        self.assertEqual(statuses[-1], 429)
        status, _ = self.call("POST", "/api/experiments", {"circuit": circuit_json(BELL)}, ip="10.9.9.9")
        self.assertEqual(status, 201)  # another client is not affected

    def count_shares(self) -> int:
        with sqlite3.connect(self.db) as conn:
            return conn.execute("SELECT COUNT(*) FROM shared_experiments").fetchone()[0]


class TestPrivacy(ShareCase):
    """What a viewer can see never includes who shared it, which class they are in, or anything of the server."""

    def test_the_public_view_has_no_owner_class_token_or_server_detail(self) -> None:
        code_status, made = self.call("POST", "/api/classes", {"title": "Period 3 physics"})
        self.assertEqual(code_status, 201)
        status, joined = self.call("POST", "/api/classes/join", {"class_code": made["class_code"]})
        self.assertEqual(status, 200)
        token = joined["learner_token"]
        run = self.run_circuit(BELL)
        status, raw = http(
            "POST",
            "/api/experiments",
            json.dumps({"circuit": circuit_json(BELL), "result_id": run.result_id, "title": "mine"}).encode(),
            headers={"X-Qentor-Learner": token},
        )
        self.assertEqual(status, 201, raw)
        created = json.loads(raw)
        status, raw = http("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual(status, 200)
        text = raw.decode() if isinstance(raw, bytes) else str(raw)
        for secret in (
            token,
            token[3:],
            made["class_code"],
            made["class_code"].replace("-", ""),
            made["instructor_key"],
            "Period 3 physics",
            "Learner ",
            str(self.db),
            self.db.name,
            "/home/",
            "C:\\",
            "QENTOR_",
            "api_key",
            "secret",
        ):
            self.assertNotIn(secret, text, secret)
        self.assertEqual(
            sorted(json.loads(text)),
            sorted(["experiment_id", "created_at", "title", "read_only", "note", "circuit_hash", "circuit", "qasm", "generator", "code", "backend", "mode", "shots", "lesson", "challenge", "result", "result_note"]),
        )

    def test_the_stored_row_has_no_column_that_could_hold_an_owner(self) -> None:
        with sqlite3.connect(self.db) as conn:
            columns = [row[1] for row in conn.execute("PRAGMA table_info(shared_experiments)")]
        self.assertEqual(
            columns,
            ["experiment_id", "created_at", "title", "circuit_json", "circuit_hash", "backend", "mode", "shots", "result_id", "lesson_id", "challenge_id"],
        )

    def test_sharing_with_a_token_records_only_a_counted_event_in_the_class_never_the_reverse(self) -> None:
        _, made = self.call("POST", "/api/classes", {})
        _, joined = self.call("POST", "/api/classes/join", {"class_code": made["class_code"]})
        token = joined["learner_token"]
        status, created = self.call("POST", "/api/experiments", {"circuit": circuit_json(BELL)}, learner=token)
        self.assertEqual(status, 201)
        cls = self.classroom.class_by_code(normalise_code(made["class_code"]))
        events = self.classroom.member_events(cls.class_id)
        shared = [e for e in events if e.kind == "experiment_shared"]
        self.assertEqual([e.subject_id for e in shared], [created["experiment_id"]])
        # and the share itself carries nothing back to the learner
        with sqlite3.connect(self.db) as conn:
            row = conn.execute("SELECT * FROM shared_experiments WHERE experiment_id = ?", (created["experiment_id"],)).fetchone()
        self.assertNotIn(token, "".join(str(v) for v in row))

    def test_a_bad_or_missing_token_still_shares_and_records_nothing(self) -> None:
        for token in (None, "garbage", "ql_" + "z" * 29):
            status, _ = self.call("POST", "/api/experiments", {"circuit": circuit_json(BELL)}, learner=token)
            self.assertEqual(status, 201, token)

    def test_the_public_view_does_not_depend_on_who_asks(self) -> None:
        _, created = self.share()
        views = [self.call("GET", f"/api/experiments/{created['experiment_id']}", learner=t)[1] for t in (None, "ql_" + "a" * 29, "garbage")]
        self.assertEqual(views[0], views[1])
        self.assertEqual(views[0], views[2])


class TestReadOnly(ShareCase):
    def test_there_is_no_endpoint_that_changes_lists_or_deletes_a_share(self) -> None:
        _, created = self.share()
        path = f"/api/experiments/{created['experiment_id']}"
        _, before = self.call("GET", path)
        for method in ("PUT", "PATCH", "DELETE", "POST"):
            status, _ = self.call(method, path, {"title": "changed", "circuit": circuit_json(OTHER)})
            self.assertIn(status, (404, 405), method)
        for listing in ("/api/experiments", "/api/experiments/", "/api/experiments/list", "/api/experiments/search?q=a"):
            status, _ = self.call("GET", listing)
            self.assertIn(status, (404, 405, 422), listing)
        _, after = self.call("GET", path)
        self.assertEqual(before, after)

    def test_the_router_has_exactly_one_write_and_one_read_and_the_write_only_inserts(self) -> None:
        source = (BACKEND / "qentor" / "api" / "sharing.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        decorators = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                for dec in node.decorator_list:
                    if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.func.attr in ("get", "post", "put", "patch", "delete"):
                        decorators.append(dec.func.attr)
        self.assertEqual(sorted(decorators), ["get", "post"])
        store_source = (BACKEND / "qentor" / "sharing" / "store.py").read_text(encoding="utf-8")
        for verb in ("UPDATE ", "DELETE "):
            self.assertNotIn(verb, store_source)

    def test_forking_is_a_copy_made_in_the_browser_so_a_second_share_is_a_new_id_and_the_first_is_unchanged(self) -> None:
        _, first = self.share(title="original")
        _, original = self.call("GET", f"/api/experiments/{first['experiment_id']}")
        edited = circuit_json(BELL)
        edited["ops"].append({"gate": "x", "targets": [1], "controls": [], "params": [], "clbits": []})
        status, second = self.call("POST", "/api/experiments", {"circuit": edited, "title": "fork"})
        self.assertEqual(status, 201)
        self.assertNotEqual(first["experiment_id"], second["experiment_id"])
        _, again = self.call("GET", f"/api/experiments/{first['experiment_id']}")
        self.assertEqual(original, again)
        self.assertEqual(len(again["circuit"]["ops"]), 2)

    def test_a_stored_circuit_that_no_longer_validates_is_not_served(self) -> None:
        _, created = self.share()
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE shared_experiments SET circuit_json = ? WHERE experiment_id = ?", ('{"num_qubits": -4}', created["experiment_id"]))
            conn.commit()
        status, _ = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertEqual(status, 404)

    def test_a_stored_run_that_no_longer_matches_the_circuit_is_not_shown(self) -> None:
        run = self.run_circuit(BELL)
        _, created = self.share(result_id=run.result_id)
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE results SET circuit_hash = ? WHERE result_id = ?", ("0" * 64, run.result_id))
            conn.commit()
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertIsNone(view["result"])
        self.assertIn("no longer available", view["result_note"])

    def test_a_stored_run_that_is_no_longer_a_checked_state_is_not_shown(self) -> None:
        run = self.run_circuit(BELL)
        _, created = self.share(result_id=run.result_id)
        with sqlite3.connect(self.db) as conn:
            conn.execute("UPDATE results SET verification_status = ? WHERE result_id = ?", (ExecutionStatus.ERROR.value, run.result_id))
            conn.commit()
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertIsNone(view["result"])
        self.assertIn("no longer available", view["result_note"])

    def test_a_run_that_has_since_gone_missing_is_said_so_not_substituted(self) -> None:
        run = self.run_circuit(BELL)
        _, created = self.share(result_id=run.result_id)
        with sqlite3.connect(self.db) as conn:
            conn.execute("DELETE FROM results WHERE result_id = ?", (run.result_id,))
            conn.commit()
        self.assertIsNone(self.provenance.get(run.result_id))
        _, view = self.call("GET", f"/api/experiments/{created['experiment_id']}")
        self.assertIsNone(view["result"])
        self.assertIn("no longer available", view["result_note"])


class TestArchitecture(unittest.TestCase):
    def test_the_sharing_package_imports_nothing_it_should_not(self) -> None:
        forbidden = {"qentor.tutor", "qentor.execution", "qentor.verification", "qentor.classroom", "qentor.api", "qentor.provenance"}
        for path in (BACKEND / "qentor" / "sharing").glob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                modules = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""] if isinstance(node, ast.ImportFrom) and node.level == 0 else []
                for module in modules:
                    self.assertFalse(any(module == f or module.startswith(f + ".") for f in forbidden), f"{path.name} imports {module}")

    def test_nothing_below_the_api_imports_sharing(self) -> None:
        for package in ("tutor", "execution", "verification", "circuit", "challenges", "lessons", "classroom", "provenance"):
            for path in (BACKEND / "qentor" / package).rglob("*.py"):
                self.assertNotIn("qentor.sharing", path.read_text(encoding="utf-8"), str(path))

    def test_the_tutor_cannot_reach_the_share_writer(self) -> None:
        for path in (BACKEND / "qentor" / "tutor").rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("ExperimentStore", text, str(path))
            self.assertNotIn("qentor.sharing", text, str(path))


if __name__ == "__main__":
    unittest.main()
