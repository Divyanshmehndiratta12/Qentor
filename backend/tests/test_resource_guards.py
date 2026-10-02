"""Resource bounds: the HTTP body-size limit, the heavy-work gate, and the provenance log's retention.

The numbers behind them (how long the largest accepted requests take, how big their records are) were measured on a running server with
``backend/scripts/resource_smoke.py`` and are written in docs/BUILD_STATE.md "Resource limits". These tests pin the guards themselves with no
quantum backend: a dummy ASGI app stands in for the application, and the real application is driven only for requests that never reach a backend.
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from qentor.api import guards
from qentor.api.guards import BodySizeLimitMiddleware, HeavyWorkGate
from qentor.provenance import store as store_module
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.provenance.store import ProvenanceStore
from tests.asgi_driver import http


# ---------------------------------------------------------------------------------------------------------------------------- ASGI helpers
async def call(app, method: str, path: str, body: bytes = b"", headers: list[tuple[bytes, bytes]] | None = None, chunks: list[bytes] | None = None):
    """Run one request through ``app``; returns (status, parsed JSON or None, response headers)."""
    parts = chunks if chunks is not None else [body]
    queue = [{"type": "http.request", "body": p, "more_body": i < len(parts) - 1} for i, p in enumerate(parts)]
    sent: list[dict] = []

    async def receive() -> dict:
        return queue.pop(0) if queue else {"type": "http.disconnect"}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {"type": "http", "method": method, "path": path, "headers": headers if headers is not None else [(b"content-length", str(len(body)).encode())]}
    await app(scope, receive, send)
    start = next(m for m in sent if m["type"] == "http.response.start")
    raw = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    try:
        parsed = json.loads(raw)
    except ValueError:
        parsed = None
    return start["status"], parsed, dict(start["headers"])


def echo_app(read_body: bool = True):
    async def app(scope, receive, send):
        size = 0
        if read_body:
            while True:
                event = await receive()
                size += len(event.get("body", b""))
                if not event.get("more_body"):
                    break
        payload = json.dumps({"ok": True, "bytes": size}).encode()
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": payload})

    return app


# ----------------------------------------------------------------------------------------------------------------------------- body size
class TestBodySizeLimit(unittest.TestCase):
    def run_it(self, coro):
        return asyncio.run(coro)

    def test_a_body_at_the_limit_goes_through_and_one_byte_more_is_413_with_the_standard_error_shape(self) -> None:
        app = BodySizeLimitMiddleware(echo_app(), max_bytes=1000)
        status, body, _ = self.run_it(call(app, "POST", "/api/x", b"a" * 1000))
        self.assertEqual((status, body["bytes"]), (200, 1000))
        status, body, _ = self.run_it(call(app, "POST", "/api/x", b"a" * 1001))
        self.assertEqual(status, 413)
        self.assertEqual(body["detail"]["code"], guards.REQUEST_TOO_LARGE)
        self.assertIn("limit", body["detail"]["message"])

    def test_the_application_never_sees_a_body_the_header_already_says_is_too_big(self) -> None:
        reached = []

        async def app(scope, receive, send):
            reached.append(1)

        wrapped = BodySizeLimitMiddleware(app, max_bytes=10)
        status, _, _ = self.run_it(call(wrapped, "POST", "/api/x", b"x" * 11))
        self.assertEqual((status, reached), (413, []))

    def test_a_body_sent_in_chunks_without_a_declared_size_is_still_stopped(self) -> None:
        app = BodySizeLimitMiddleware(echo_app(), max_bytes=100)
        status, body, _ = self.run_it(call(app, "POST", "/api/x", headers=[], chunks=[b"a" * 60, b"a" * 60]))
        self.assertEqual(status, 413)
        self.assertEqual(body["detail"]["code"], guards.REQUEST_TOO_LARGE)
        status, body, _ = self.run_it(call(app, "POST", "/api/x", headers=[], chunks=[b"a" * 60, b"a" * 40]))
        self.assertEqual((status, body["bytes"]), (200, 100))

    def test_a_body_that_lies_about_its_size_is_stopped_by_the_count(self) -> None:
        app = BodySizeLimitMiddleware(echo_app(), max_bytes=100)
        status, _, _ = self.run_it(call(app, "POST", "/api/x", headers=[(b"content-length", b"5")], chunks=[b"a" * 150]))
        self.assertEqual(status, 413)

    def test_reads_and_non_http_scopes_are_not_limited(self) -> None:
        app = BodySizeLimitMiddleware(echo_app(read_body=False), max_bytes=1)
        status, _, _ = self.run_it(call(app, "GET", "/api/lessons", headers=[(b"content-length", b"999")]))
        self.assertEqual(status, 200)

    def test_the_real_application_refuses_an_oversized_post_with_413_before_parsing_it(self) -> None:
        status, raw = http("POST", "/api/execute", b'{"circuit": "' + b"a" * (guards.MAX_BODY_BYTES + 10) + b'"}')
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(raw)["detail"]["code"], guards.REQUEST_TOO_LARGE)

    def test_the_real_application_still_validates_a_normal_sized_bad_body_as_before(self) -> None:
        status, _ = http("POST", "/api/execute", b'{"nonsense": 1}')
        self.assertEqual(status, 422)  # the usual validation answer, so the guard changed nothing for ordinary requests

    def test_the_limit_is_far_above_any_real_request(self) -> None:
        # a 500-operation circuit is the largest the server runs; its JSON is well under the limit
        from qentor.circuit.model import Circuit, GateOp

        biggest = Circuit(num_qubits=16, num_clbits=0, ops=[GateOp(gate="cx", controls=[i % 16], targets=[(i + 1) % 16]) for i in range(500)])
        self.assertLess(len(biggest.model_dump_json(by_alias=True)), guards.MAX_BODY_BYTES // 5)


# ------------------------------------------------------------------------------------------------------------------------- heavy-work gate
class GatedApp:
    """An application that holds each request until told to finish, and counts how many ran at once."""

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.running = 0
        self.max_running = 0
        self.fail = False

    async def __call__(self, scope, receive, send):
        self.running += 1
        self.max_running = max(self.max_running, self.running)
        try:
            await self.release.wait()
            if self.fail:
                raise RuntimeError("boom")
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"{}"})
        finally:
            self.running -= 1


class TestHeavyWorkGate(unittest.TestCase):
    def test_only_the_limit_runs_at_once_the_rest_wait_and_all_finish_in_order_of_arrival(self) -> None:
        async def scenario():
            inner = GatedApp()
            gate = HeavyWorkGate(inner, limit=2, wait_seconds=5)
            tasks = [asyncio.create_task(call(gate, "POST", "/api/execute")) for _ in range(5)]
            await asyncio.sleep(0.05)
            running_now = inner.running
            inner.release.set()
            results = await asyncio.gather(*tasks)
            return running_now, inner.max_running, [r[0] for r in results]

        running_now, max_running, statuses = asyncio.run(scenario())
        self.assertEqual(running_now, 2)
        self.assertEqual(max_running, 2)
        self.assertEqual(statuses, [200] * 5)

    def test_a_request_that_waits_too_long_gets_503_with_the_standard_shape_and_nothing_is_run(self) -> None:
        async def scenario():
            inner = GatedApp()
            gate = HeavyWorkGate(inner, limit=1, wait_seconds=0.05)
            first = asyncio.create_task(call(gate, "POST", "/api/verify/equivalence"))
            await asyncio.sleep(0.02)
            status, body, headers = await call(gate, "POST", "/api/verify/equivalence")
            ran_while_waiting = inner.running
            inner.release.set()
            await first
            return status, body, headers, ran_while_waiting

        status, body, headers, ran = asyncio.run(scenario())
        self.assertEqual(status, 503)
        self.assertEqual(body["detail"]["code"], guards.SERVER_BUSY)
        self.assertIn("nothing was run", body["detail"]["message"])
        self.assertEqual(headers[b"retry-after"], b"5")
        self.assertEqual(ran, 1)  # only the first request was ever running

    def test_light_requests_are_never_held_behind_heavy_ones(self) -> None:
        async def scenario():
            inner = GatedApp()
            gate = HeavyWorkGate(inner, limit=1, wait_seconds=5)
            held = asyncio.create_task(call(gate, "POST", "/api/execute"))
            await asyncio.sleep(0.02)
            light = []

            async def quick(scope, receive, send):
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"{}"})

            lightweight = HeavyWorkGate(quick, limit=1, wait_seconds=0.01)
            lightweight._loop, lightweight._semaphore = asyncio.get_running_loop(), gate._semaphore  # share the saturated semaphore
            for method, path in (("GET", "/api/execute"), ("GET", "/api/lessons"), ("POST", "/api/lessons/x/concept-checks/y/grade"), ("POST", "/api/classroom/join"), ("POST", "/api/health")):
                light.append((await call(lightweight, method, path))[0])
            inner.release.set()
            await held
            return light

        self.assertEqual(asyncio.run(scenario()), [200] * 5)

    def test_a_failing_request_still_gives_its_slot_back(self) -> None:
        async def scenario():
            inner = GatedApp()
            inner.fail = True
            inner.release.set()
            gate = HeavyWorkGate(inner, limit=1, wait_seconds=0.2)
            for _ in range(3):
                with self.assertRaises(RuntimeError):
                    await call(gate, "POST", "/api/optimize")
            inner.fail = False
            return (await call(gate, "POST", "/api/optimize"))[0]

        self.assertEqual(asyncio.run(scenario()), 200)

    def test_the_body_limit_is_checked_before_the_gate_so_an_oversized_request_never_waits(self) -> None:
        async def scenario():
            inner = GatedApp()
            stack = BodySizeLimitMiddleware(HeavyWorkGate(inner, limit=1, wait_seconds=5), max_bytes=10)
            held = asyncio.create_task(call(stack, "POST", "/api/execute", b"ok"))
            await asyncio.sleep(0.02)
            status = (await call(stack, "POST", "/api/execute", b"x" * 50))[0]
            inner.release.set()
            await held
            return status

        self.assertEqual(asyncio.run(scenario()), 413)

    def test_which_paths_are_heavy(self) -> None:
        gate = HeavyWorkGate(echo_app(), limit=1)
        heavy = ["/api/execute", "/api/execute/trace", "/api/verify/equivalence", "/api/optimize", "/api/test/multi-input", "/api/compare/backends",
                 "/api/compare/experiments", "/api/variational/sweep", "/api/reasoning/analyze", "/api/debug", "/api/challenges/qft-2qubit/submit"]
        for path in heavy:
            self.assertTrue(gate._is_heavy({"type": "http", "method": "POST", "path": path}), path)
            self.assertFalse(gate._is_heavy({"type": "http", "method": "GET", "path": path}), path)
        for path in ["/api/health", "/api/lessons", "/api/tutor", "/api/classroom/join", "/api/export/circuit", "/", "/assets/index.js"]:
            self.assertFalse(gate._is_heavy({"type": "http", "method": "POST", "path": path}), path)

    def test_every_heavy_prefix_names_a_real_route(self) -> None:
        from qentor.api import app as app_module

        paths = [getattr(r, "path", "") for r in app_module.app.routes]
        for prefix in guards.HEAVY_PREFIXES:
            self.assertTrue(any(p.startswith(prefix) for p in paths), f"{prefix} matches no route")

    def test_the_limit_comes_from_the_setting_or_the_cpu_count_clamped(self) -> None:
        with mock.patch.dict(os.environ, {"QENTOR_MAX_HEAVY_REQUESTS": "7"}):
            self.assertEqual(guards.default_heavy_limit(), 7)
        with mock.patch.dict(os.environ, {"QENTOR_MAX_HEAVY_REQUESTS": "zero"}):
            with mock.patch("os.cpu_count", return_value=64):
                self.assertEqual(guards.default_heavy_limit(), 4)
            with mock.patch("os.cpu_count", return_value=1):
                self.assertEqual(guards.default_heavy_limit(), 2)

    def test_the_real_application_has_both_guards_installed(self) -> None:
        from qentor.api import app as app_module

        installed = [m.cls for m in app_module.app.user_middleware]
        self.assertIn(BodySizeLimitMiddleware, installed)
        self.assertIn(HeavyWorkGate, installed)
        self.assertLess(installed.index(BodySizeLimitMiddleware), installed.index(HeavyWorkGate), "the body limit must be the outer layer")


# ---------------------------------------------------------------------------------------------------------------------- provenance retention
def record(n: int, padding: int = 0) -> ProvenanceRecord:
    return ProvenanceRecord.new(
        circuit_hash=f"h{n}",
        backend="qiskit-aer",
        backend_version="0.17.2",
        execution_mode="statevector",
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=ExecutionStatus.STATE_CHECKED,
        payload={"n": n, "pad": "x" * padding},
    )


class TestProvenanceRetention(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = Path(self._tmp.name) / "p.db"

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def stored(self, store: ProvenanceStore) -> int:
        return store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001

    def test_the_row_limit_deletes_the_oldest_and_keeps_the_newest(self) -> None:
        store = ProvenanceStore(self.path, max_rows=10, max_bytes=10**9)
        records = [record(i) for i in range(25)]
        for r in records:
            store.insert(r)
        self.assertLessEqual(self.stored(store), 10)
        self.assertGreater(store.pruned_total, 0)
        self.assertIsNone(store.get(records[0].result_id))  # the oldest is gone, and reading it says "not found" like any unknown id
        for r in records[-5:]:
            self.assertIsNotNone(store.get(r.result_id))
        store.close()

    def test_pruning_stops_at_eighty_percent_of_the_limit_not_at_zero(self) -> None:
        store = ProvenanceStore(self.path, max_rows=10, max_bytes=10**9)
        for i in range(11):  # the eleventh crosses the limit
            store.insert(record(i))
        self.assertEqual(self.stored(store), 8)
        store.close()

    def test_the_byte_limit_applies_even_with_few_rows(self) -> None:
        store = ProvenanceStore(self.path, max_rows=10**6, max_bytes=5000)
        for i in range(20):
            store.insert(record(i, padding=1000))
        self.assertLess(store._bytes, 5000)  # noqa: SLF001
        self.assertLess(self.stored(store), 20)
        store.close()

    def test_a_record_a_shared_experiment_or_an_attempt_points_at_is_never_deleted(self) -> None:
        store = ProvenanceStore(self.path, max_rows=6, max_bytes=10**9)
        records = [record(i) for i in range(4)]
        for r in records:
            store.insert(r)
        conn = sqlite3.connect(self.path)
        conn.execute(
            "INSERT INTO shared_experiments (experiment_id, created_at, circuit_json, circuit_hash, backend, mode, result_id) VALUES ('e1','t','{}','h','b','statevector',?)",
            (records[0].result_id,),
        )
        conn.execute(
            "INSERT INTO challenge_attempts (attempt_id, challenge_id, circuit_hash, passed, final_result_id, checks_json, created_at) VALUES ('a1','c','h',1,?,'[]','t')",
            (records[1].result_id,),
        )
        conn.commit()
        conn.close()
        for i in range(4, 40):
            store.insert(record(i))
        self.assertIsNotNone(store.get(records[0].result_id))
        self.assertIsNotNone(store.get(records[1].result_id))
        self.assertIsNone(store.get(records[2].result_id))  # unreferenced and old: pruned
        store.close()

    def test_the_record_just_written_survives_even_if_it_alone_is_over_the_byte_limit(self) -> None:
        store = ProvenanceStore(self.path, max_rows=10**6, max_bytes=500)
        big = record(0, padding=5000)
        store.insert(big)
        self.assertIsNotNone(store.get(big.result_id))
        store.insert(record(1))
        self.assertIsNone(store.get(big.result_id))  # now it is old and unreferenced
        store.close()

    def test_when_everything_left_is_referenced_pruning_stops_instead_of_looping(self) -> None:
        store = ProvenanceStore(self.path, max_rows=2, max_bytes=10**9)
        kept = [record(i) for i in range(3)]
        for r in kept[:2]:
            store.insert(r)
        conn = sqlite3.connect(self.path)
        for n, r in enumerate(kept[:2]):
            conn.execute(
                "INSERT INTO challenge_attempts (attempt_id, challenge_id, circuit_hash, passed, final_result_id, checks_json, created_at) VALUES (?,'c','h',1,?,'[]','t')",
                (f"a{n}", r.result_id),
            )
        conn.commit()
        conn.close()
        store.insert(kept[2])  # over the limit with nothing deletable
        self.assertEqual(self.stored(store), 3)
        store.close()

    def test_the_running_totals_match_the_table_and_survive_a_restart(self) -> None:
        store = ProvenanceStore(self.path, max_rows=10, max_bytes=10**9)
        for i in range(37):
            store.insert(record(i, padding=i))
        rows, size = store._conn.execute("SELECT COUNT(*), SUM(LENGTH(CAST(payload_json AS BLOB))) FROM results").fetchone()  # noqa: SLF001
        self.assertEqual((store._rows, store._bytes), (rows, size))  # noqa: SLF001
        store.close()
        again = ProvenanceStore(self.path, max_rows=10, max_bytes=10**9)
        self.assertEqual((again._rows, again._bytes), (rows, size))  # noqa: SLF001
        again.close()

    def test_nothing_is_pruned_below_the_limits(self) -> None:
        store = ProvenanceStore(self.path, max_rows=100, max_bytes=10**9)
        for i in range(50):
            store.insert(record(i))
        self.assertEqual((self.stored(store), store.pruned_total), (50, 0))
        store.close()

    def test_limits_come_from_the_environment_with_documented_defaults_and_bad_values_ignored(self) -> None:
        with mock.patch.dict(os.environ, {store_module.ROWS_ENV: "123", store_module.BYTES_ENV: "456"}):
            store = ProvenanceStore(self.path)
            self.assertEqual((store.max_rows, store.max_bytes), (123, 456))
            store.close()
        with mock.patch.dict(os.environ, {store_module.ROWS_ENV: "many", store_module.BYTES_ENV: "0"}):
            store = ProvenanceStore(self.path)
            self.assertEqual((store.max_rows, store.max_bytes), (store_module.DEFAULT_MAX_ROWS, store_module.DEFAULT_MAX_BYTES))
            store.close()
        self.assertEqual((store_module.DEFAULT_MAX_ROWS, store_module.DEFAULT_MAX_BYTES), (20_000, 512 * 1024 * 1024))


class TestOneDatabaseManyStores(unittest.TestCase):
    """The provenance log, the attempt log and the rest share ONE SQLite file through separate connections, each serialised by its own lock.
    Written concurrently from many threads (as the server's worker pool does) they must not lock each other out or lose a row."""

    def test_concurrent_writers_on_different_stores_lose_nothing_and_raise_nothing(self) -> None:
        import threading

        from qentor.provenance.attempts import AttemptRecord, AttemptStore

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "shared.db"
            results = ProvenanceStore(path, max_rows=10**6, max_bytes=10**10)
            attempts = AttemptStore(path)
            errors: list[BaseException] = []
            per_thread = 150

            def write_results(offset: int) -> None:
                try:
                    for i in range(per_thread):
                        results.insert(record(offset * 1000 + i, padding=200))
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            def write_attempts(offset: int) -> None:
                try:
                    for i in range(per_thread):
                        attempts.insert(AttemptRecord.new(challenge_id="c", circuit_hash=f"h{offset}-{i}", passed=bool(i % 2), final_result_id=None, checks=[{"id": i}]))
                except BaseException as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [threading.Thread(target=write_results, args=(n,)) for n in range(4)] + [threading.Thread(target=write_attempts, args=(n,)) for n in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=120)
            self.assertEqual(errors, [])
            check = sqlite3.connect(path)
            self.assertEqual(check.execute("SELECT COUNT(*) FROM results").fetchone()[0], 4 * per_thread)
            self.assertEqual(check.execute("SELECT COUNT(*) FROM challenge_attempts").fetchone()[0], 4 * per_thread)
            check.close()
            self.assertEqual(results._rows, 4 * per_thread)  # noqa: SLF001  the running total matches under concurrency
            results.close()
            attempts.close()


if __name__ == "__main__":
    unittest.main()
