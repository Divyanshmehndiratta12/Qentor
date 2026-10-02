"""The one-parameter variational (VQE-style) demonstration: <Z> read from backend statevectors, the parameter sweep, the optimiser, the
HTTP surface and the challenge. The physics written in these tests (<Z> = cos(theta) for RY(theta) on |0>) is the TEST's independent check of
the backend; no shipped module contains it.
"""

from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api import reasoning as reasoning_api
from qentor.api import variational as variational_api
from qentor.api.schemas import ChallengeSubmitRequest
from qentor.challenges import CHALLENGE_BY_ID
from qentor.challenges.content import circ, g
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.execution.adapter import AdapterUnavailable, ExecutionResult
from qentor.execution.aer import AerAdapter
from qentor.execution.bloch import bloch_coordinates
from qentor.execution.expectation import EXPECTATION_METHOD, z_expectation
from qentor.execution.reduced_state import qubit_bloch
from qentor.provenance.store import ProvenanceStore
from qentor.verification import variational
from tests.asgi_driver import http

PI = math.pi
AER = AerAdapter()


def ry(theta: float) -> Circuit:
    return circ(1, [GateOp(gate=GateName.RY, targets=[0], params=[theta])])


def needs_aer(case: unittest.TestCase) -> None:
    try:
        AER.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
    except AdapterUnavailable as exc:
        case.skipTest(f"qiskit-aer unavailable: {exc}")
    except Exception:
        pass


class TestZExpectation(unittest.TestCase):
    """Read from a state; never from a gate."""

    def test_basis_states_and_the_equator(self) -> None:
        self.assertEqual(z_expectation([[1.0, 0.0], [0.0, 0.0]], 0, 1), 1.0)
        self.assertEqual(z_expectation([[0.0, 0.0], [1.0, 0.0]], 0, 1), -1.0)
        s = 1 / math.sqrt(2)
        self.assertAlmostEqual(z_expectation([[s, 0.0], [s, 0.0]], 0, 1), 0.0, places=12)
        self.assertAlmostEqual(z_expectation([[s, 0.0], [0.0, s]], 0, 1), 0.0, places=12)  # a phase does not matter

    def test_it_follows_the_amplitudes_not_a_gate_name(self) -> None:
        # a state no named gate produces: probability 0.36 of reading 1
        state = [[0.8, 0.0], [0.0, 0.6]]
        self.assertAlmostEqual(z_expectation(state, 0, 1), 0.64 - 0.36, places=12)

    def test_it_is_invariant_under_a_global_phase(self) -> None:
        a = [[0.6, 0.0], [0.0, 0.8]]
        phase = complex(math.cos(0.7), math.sin(0.7))
        b = [[(0.6 * phase).real, (0.6 * phase).imag], [(0.8 * phase).real, (0.8 * phase).imag]]
        self.assertAlmostEqual(z_expectation(a, 0, 1), z_expectation(b, 0, 1), places=12)

    def test_it_reads_the_right_qubit_of_a_register(self) -> None:
        # |q1 q0> = |10>: q1 reads 1, q0 reads 0 (index 2 of the statevector)
        state = [[0.0, 0.0], [0.0, 0.0], [1.0, 0.0], [0.0, 0.0]]
        self.assertEqual(z_expectation(state, 1, 2), -1.0)
        self.assertEqual(z_expectation(state, 0, 2), 1.0)

    def test_it_agrees_with_the_bloch_z_of_the_reduced_state(self) -> None:
        needs_aer(self)
        circuit = circ(3, [g("h", 0), g("cx", 1, control=0), GateOp(gate=GateName.RY, targets=[2], params=[1.1]), g("h", 2), g("cx", 2, control=1)])
        state = AER.run(circuit, "statevector").statevector
        for q in range(3):
            self.assertAlmostEqual(z_expectation(state, q, 3), qubit_bloch(state, q, 3)[2], places=12)

    def test_an_unusable_state_has_no_expectation_value(self) -> None:
        nan = float("nan")
        for bad, qubit, n in (
            (None, 0, 1),
            ([[1.0, 0.0]], 0, 1),  # wrong size
            ([[0.5, 0.0], [0.5, 0.0]], 0, 1),  # not normalised
            ([[nan, 0.0], [0.0, 0.0]], 0, 1),
            ([[1.0, 0.0], [0.0, 0.0]], 1, 1),  # qubit outside the register
            ([[1.0, 0.0], [0.0, 0.0]], -1, 1),
            ([[1.0, 0.0, 0.0], [0.0, 0.0]], 0, 1),  # an amplitude that is not a pair
            ([[True, 0.0], [0.0, 0.0]], 0, 1),
            ([[1.0, 0.0], [0.0, 0.0]], 0, 0),
        ):
            with self.subTest(state=bad, qubit=qubit):
                self.assertIsNone(z_expectation(bad, qubit, n))

    def test_the_method_is_named(self) -> None:
        self.assertEqual(EXPECTATION_METHOD, "pauli-z-expectation-from-statevector/1")


class VariationalCase(unittest.TestCase):
    def setUp(self) -> None:
        needs_aer(self)
        self._tmp = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmp.name) / "q.db")
        self._patch = patch.object(app_module, "_store", self.store)
        self._patch.start()
        self.recorded: list[str] = []

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()

    def record(self, result: ExecutionResult, chash: str) -> str:
        return app_module._record_run(result, chash, 1).result_id  # noqa: SLF001 - the API's own recorder


class TestEvaluate(VariationalCase):
    def test_the_value_is_read_from_the_backends_state(self) -> None:
        for theta in (0.0, 0.3, PI / 2, 1.234, PI, 2 * PI - 0.1, -1.0):
            with self.subTest(theta=theta):
                point = variational.evaluate(theta, AER, self.record)
                state = self.store.get(point.result_id).payload["statevector"]
                self.assertEqual(point.expectation_z, z_expectation(state, 0, 1))
                self.assertEqual(point.bloch, bloch_coordinates(state))
                self.assertAlmostEqual(point.expectation_z, point.bloch[2], places=12)
                self.assertAlmostEqual(point.expectation_z, math.cos(theta), places=9)  # the TEST's independent physics

    def test_each_point_names_its_run(self) -> None:
        point = variational.evaluate(0.7, AER, self.record)
        record = self.store.get(point.result_id)
        self.assertEqual(record.circuit_hash, point.circuit_hash)
        self.assertEqual(record.circuit_hash, circuit_hash(ry(0.7)))
        self.assertEqual(record.payload["execution_id"], point.execution_id)
        self.assertEqual((point.backend, point.backend_version), (record.backend, record.backend_version))
        self.assertEqual(record.execution_mode, "statevector")

    def test_probabilities_are_the_backends_squared_amplitudes(self) -> None:
        point = variational.evaluate(PI / 2, AER, self.record)
        self.assertAlmostEqual(point.probabilities["0"] + point.probabilities["1"], 1.0, places=12)
        self.assertAlmostEqual(point.expectation_z, point.probabilities["0"] - point.probabilities["1"], places=12)

    def test_a_backend_state_that_is_not_normalised_is_refused_not_repaired(self) -> None:
        class Broken:
            name = "broken"

            def run(self, circuit, mode, shots=None):  # noqa: ANN001
                return ExecutionResult(backend_name="broken", backend_version="0", execution_mode="statevector", execution_id="x", statevector=[[0.5, 0.0], [0.5, 0.0]])

        from qentor.execution.trace import TraceBackendFault

        with self.assertRaises(TraceBackendFault):
            variational.evaluate(0.5, Broken(), lambda r, h: "never")  # type: ignore[arg-type]

    def test_an_invalid_angle_is_refused(self) -> None:
        for theta in (float("nan"), float("inf")):
            with self.assertRaises(variational.VariationalError):
                variational.ansatz(theta)

    def test_the_closed_form_of_the_circuit_is_in_no_shipped_function(self) -> None:
        text = Path(variational.__file__).read_text(encoding="utf-8") + Path(variational_api.__file__).read_text(encoding="utf-8")
        for needle in ("math.cos", "np.cos", "cos("):
            self.assertNotIn(needle, text.replace("parameter-shift", ""), needle)


class TestSweep(VariationalCase):
    def test_the_grid_is_even_inclusive_and_bounded(self) -> None:
        grid = variational.sweep_grid(0.0, 2 * PI, 5)
        self.assertEqual(len(grid), 5)
        self.assertEqual((grid[0], grid[-1]), (0.0, 2 * PI))
        steps = {round(b - a, 12) for a, b in zip(grid, grid[1:])}
        self.assertEqual(len(steps), 1)
        for args in ((1.0, 1.0, 5), (2.0, 1.0, 5), (0.0, 1.0, 2), (0.0, 1.0, 65), (-5 * PI, 1.0, 5), (0.0, float("nan"), 5)):
            with self.subTest(args=args):
                with self.assertRaises(variational.VariationalError):
                    variational.sweep_grid(*args)

    def test_every_point_is_a_recorded_backend_run_and_the_curve_has_the_right_shape(self) -> None:
        report = variational.run_sweep(0.0, 2 * PI, 25, AER, self.record)
        self.assertEqual(len(report.points), 25)
        self.assertEqual(len({p.result_id for p in report.points}), 25)
        for p in report.points:
            self.assertIsNotNone(self.store.get(p.result_id))
            self.assertAlmostEqual(p.expectation_z, math.cos(p.theta), places=9)
        values = [p.expectation_z for p in report.points]
        self.assertEqual(report.minimum_index, values.index(min(values)))
        self.assertEqual(report.maximum_index, values.index(max(values)))
        self.assertAlmostEqual(report.points[report.minimum_index].theta, PI, places=9)  # 25 points: the middle one is pi
        self.assertAlmostEqual(report.points[report.minimum_index].expectation_z, -1.0, places=9)
        self.assertAlmostEqual(report.points[report.maximum_index].expectation_z, 1.0, places=9)


class TestOptimizer(VariationalCase):
    def test_it_lowers_the_cost_using_only_backend_values(self) -> None:
        report = variational.run_optimization(0.8, 15, 0.6, AER, self.record)
        costs = [s.point.expectation_z for s in report.steps]
        self.assertEqual(len(report.steps), 16)
        self.assertGreater(costs[0], costs[-1])
        self.assertEqual(costs, sorted(costs, reverse=True))  # downhill at every step for this rate
        self.assertLess(costs[-1], -0.99)
        self.assertEqual(report.lowest_index, costs.index(min(costs)))
        for step in report.steps:
            self.assertAlmostEqual(step.gradient, 0.5 * (step.plus.expectation_z - step.minus.expectation_z), places=15)  # the parameter-shift rule
            self.assertAlmostEqual(step.plus.theta - step.point.theta, variational.SHIFT, places=12)
            self.assertAlmostEqual(step.point.theta - step.minus.theta, variational.SHIFT, places=12)
            self.assertAlmostEqual(step.gradient, -math.sin(step.point.theta), places=9)  # the TEST's independent physics

    def test_each_update_follows_the_gradient_the_backend_gave(self) -> None:
        report = variational.run_optimization(0.8, 6, 0.4, AER, self.record)
        for a, b in zip(report.steps, report.steps[1:]):
            self.assertAlmostEqual(b.point.theta, a.point.theta - 0.4 * a.gradient, places=12)

    def test_every_run_is_recorded(self) -> None:
        steps = 5
        variational.run_optimization(1.0, steps, 0.5, AER, self.record)
        rows = self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001
        self.assertEqual(rows, 3 * (steps + 1))

    def test_a_flat_start_does_not_move_and_says_why(self) -> None:
        report = variational.run_optimization(0.0, 4, 0.6, AER, self.record)
        self.assertEqual({s.point.theta for s in report.steps}, {0.0})
        self.assertTrue(all(abs(s.gradient) < 1e-9 for s in report.steps))
        self.assertTrue(report.converged)
        self.assertTrue(any("gradient of zero" in n for n in report.notes))

    def test_a_start_at_the_minimum_stays_there(self) -> None:
        report = variational.run_optimization(PI, 3, 0.6, AER, self.record)
        self.assertAlmostEqual(report.steps[-1].point.expectation_z, -1.0, places=9)
        self.assertTrue(report.converged)
        self.assertTrue(any("gradient of zero" in n for n in report.notes))  # the bottom is as flat as the top: the loop cannot move from either

    def test_too_few_steps_does_not_converge(self) -> None:
        self.assertFalse(variational.run_optimization(0.5, 1, 0.1, AER, self.record).converged)

    def test_limits(self) -> None:
        for args in ((0.5, 0, 0.5), (0.5, 26, 0.5), (0.5, 3, 0.0), (0.5, 3, 2.0), (0.5, 3, float("nan")), (5 * PI, 3, 0.5), (float("inf"), 3, 0.5)):
            with self.subTest(args=args):
                with self.assertRaises(variational.VariationalError):
                    variational.run_optimization(*args, AER, self.record)


class TestHttpSurface(VariationalCase):
    def sweep(self, **body):
        return variational_api.sweep_endpoint(variational_api.SweepRequest(**body))

    def optimize(self, **body):
        return variational_api.optimize_endpoint(variational_api.OptimizeRequest(**body))

    def test_a_sweep_carries_every_value_with_its_provenance(self) -> None:
        response = self.sweep(points=9)
        self.assertEqual(len(response.points), 9)
        self.assertIn("Educational", response.label)
        self.assertIn("not a chemistry calculation", response.label)
        self.assertIn("not a scalable VQE", response.label)
        self.assertIn("no quantum hardware", response.label)
        for point in response.points:
            record = self.store.get(point.result_id)
            self.assertEqual(point.provenance.result_id, point.result_id)
            self.assertEqual(point.provenance.circuit_hash, record.circuit_hash)
            self.assertEqual(point.provenance.provenance_class, "SIMULATION")
            self.assertEqual(point.expectation_z, z_expectation(record.payload["statevector"], 0, 1))
            self.assertEqual((point.bloch.x, point.bloch.y, point.bloch.z), bloch_coordinates(record.payload["statevector"]))
        summary = self.store.get(response.provenance.result_id)
        self.assertEqual(summary.backend, "variational-demo")
        self.assertEqual([r["result_id"] for r in summary.payload["runs"]], [p.result_id for p in response.points])
        self.assertEqual(response.minimum_index, [p.expectation_z for p in response.points].index(min(p.expectation_z for p in response.points)))
        self.assertEqual(response.provenance.provenance_class, "SIMULATION")

    def test_an_optimisation_names_the_three_runs_of_every_step(self) -> None:
        response = self.optimize(theta_start=0.8, steps=4, learning_rate=0.6)
        self.assertEqual(len(response.steps), 5)
        ids = [r.result_id for s in response.steps for r in (s.point, s.plus, s.minus)]
        self.assertEqual(len(ids), len(set(ids)))
        for s in response.steps:
            self.assertAlmostEqual(s.gradient, 0.5 * (s.plus.expectation_z - s.minus.expectation_z), places=15)
        self.assertEqual(response.shift, variational.SHIFT)
        summary = self.store.get(response.provenance.result_id)
        self.assertEqual({r["result_id"] for r in summary.payload["runs"]}, set(ids))

    def test_all_three_backends_agree_on_the_curve(self) -> None:
        results = {}
        for backend in ("qiskit-aer", "cirq", "pennylane"):
            try:
                results[backend] = [round(p.expectation_z, 9) for p in self.sweep(points=5, backend=backend).points]
            except HTTPException as exc:  # a backend that is not installed here is reported, never replaced
                self.assertEqual(exc.status_code, 503)
        self.assertTrue(results)
        first = next(iter(results.values()))
        for backend, values in results.items():
            for a, b in zip(first, values):
                self.assertAlmostEqual(a, b, places=6, msg=backend)

    def test_requests_that_carry_a_result_or_go_out_of_range_are_refused(self) -> None:
        import json

        bad_bodies = [
            ("/api/variational/sweep", {"points": 9, "expectation_z": [1, 0, -1]}),
            ("/api/variational/sweep", {"points": 9, "curve": "cos"}),
            ("/api/variational/sweep", {"points": 2}),
            ("/api/variational/sweep", {"points": 65}),
            ("/api/variational/sweep", {"theta_min": 3.0, "theta_max": 1.0}),
            ("/api/variational/sweep", {"theta_min": 0.0, "theta_max": 100.0}),
            ("/api/variational/sweep", {"backend": "ibm_brisbane"}),
            ("/api/variational/optimize", {"theta_start": 1.0, "expected_minimum": -1}),
            ("/api/variational/optimize", {"theta_start": 1.0, "steps": 26}),
            ("/api/variational/optimize", {"theta_start": 1.0, "steps": 0}),
            ("/api/variational/optimize", {"theta_start": 1.0, "learning_rate": 0}),
            ("/api/variational/optimize", {"theta_start": 1.0, "learning_rate": 5}),
            ("/api/variational/optimize", {"theta_start": 99.0}),
            ("/api/variational/optimize", {}),
        ]
        for path, body in bad_bodies:
            with self.subTest(path=path, body=body):
                status, _ = http("POST", path, json.dumps(body).encode())
                self.assertEqual(status, 422)

    def test_the_request_models_forbid_every_unknown_field(self) -> None:
        for model in (variational_api.SweepRequest, variational_api.OptimizeRequest):
            self.assertEqual(model.model_config.get("extra"), "forbid")
            for name in model.model_fields:
                self.assertFalse(any(w in name for w in ("expectation", "cost", "probab", "gradient", "result", "value")), name)

    def test_nothing_runs_for_a_refused_request(self) -> None:
        before = self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001
        with self.assertRaises(ValidationError):
            variational_api.SweepRequest(points=1)
        self.assertEqual(self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0], before)  # noqa: SLF001

    def test_a_backend_fault_is_reported_not_substituted(self) -> None:
        class Unavailable:
            name = "qiskit-aer"

            def run(self, circuit, mode, shots=None):  # noqa: ANN001
                raise AdapterUnavailable("not installed here")

        deps = app_module._reasoning_deps()  # noqa: SLF001
        deps.adapters = {**deps.adapters, "qiskit-aer": Unavailable()}  # type: ignore[assignment]
        with patch.object(reasoning_api, "deps", lambda: deps):
            with self.assertRaises(HTTPException) as caught:
                self.sweep(points=3)
        self.assertEqual((caught.exception.status_code, caught.exception.detail["code"]), (503, "VARIATIONAL_BACKEND_UNAVAILABLE"))

    def test_a_malformed_backend_state_is_a_502_with_no_numbers(self) -> None:
        class Broken:
            name = "qiskit-aer"

            def run(self, circuit, mode, shots=None):  # noqa: ANN001
                return ExecutionResult(backend_name="qiskit-aer", backend_version="x", execution_mode="statevector", execution_id="e", statevector=[[0.5, 0.0], [0.5, 0.0]])

        deps = app_module._reasoning_deps()  # noqa: SLF001
        deps.adapters = {**deps.adapters, "qiskit-aer": Broken()}  # type: ignore[assignment]
        with patch.object(reasoning_api, "deps", lambda: deps):
            with self.assertRaises(HTTPException) as caught:
                self.sweep(points=3)
        self.assertEqual(caught.exception.status_code, 502)

    def test_the_routes_are_registered_and_the_lab_capability_names_the_sweep(self) -> None:
        pairs = {(m, r.path) for r in app_module.app.routes for m in getattr(r, "methods", ())}
        self.assertIn(("POST", "/api/variational/sweep"), pairs)
        self.assertIn(("POST", "/api/variational/optimize"), pairs)


class TestChallenge(VariationalCase):
    def judge(self, circuit: Circuit):
        return app_module.submit_challenge("vqe-find-theta", ChallengeSubmitRequest(circuit=circuit))

    def check(self, response):
        return next(c for c in response.checks if c.id == "final.expectation_z")

    def test_the_reference_solution_passes_and_its_value_comes_from_the_backend(self) -> None:
        reference = CHALLENGE_BY_ID["vqe-find-theta"].reference_solution
        response = self.judge(reference)
        self.assertTrue(response.passed)
        check = self.check(response)
        self.assertEqual((check.passed, check.evaluated), (True, True))
        evidence = {e.name: e.value for e in check.evidence}
        record = self.store.get(check.result_id)
        self.assertEqual(evidence["expectation_z"], z_expectation(record.payload["statevector"], 0, 1))
        self.assertAlmostEqual(evidence["expectation_z"], -1.0, places=9)

    def test_the_angle_is_judged_by_the_state_it_prepares(self) -> None:
        for theta, passes in ((PI, True), (3.14159, True), (3 * PI, True), (-PI, True), (3.14, False), (PI / 2, False), (0.0, False)):
            with self.subTest(theta=theta):
                response = self.judge(ry(theta))
                self.assertEqual(self.check(response).passed, passes)
                self.assertEqual(response.passed, passes)
                self.assertAlmostEqual({e.name: e.value for e in self.check(response).evidence}["expectation_z"], math.cos(theta), places=9)

    def test_a_failing_circuit_is_a_normal_result_with_a_hint(self) -> None:
        response = self.judge(ry(1.0))
        self.assertFalse(response.passed)
        self.assertIsNotNone(response.next_hint)
        self.assertEqual(response.next_hint_index, 1)

    def test_other_gates_and_extra_gates_are_not_allowed(self) -> None:
        for circuit in (circ(1, [g("x", 0)]), circ(1, [g("h", 0)]), circ(1, [GateOp(gate=GateName.RY, targets=[0], params=[PI]), GateOp(gate=GateName.RY, targets=[0], params=[0.0])]), circ(1, [])):
            with self.subTest(ops=[o.gate.value for o in circuit.ops]):
                response = self.judge(circuit)
                self.assertFalse(response.passed)
                self.assertTrue(any(c.id.startswith("structure.") and not c.passed for c in response.checks))
                self.assertFalse(self.check(response).evaluated)  # nothing is judged until the structure is right

    def test_the_constraints_are_exactly_one_ry_gate_on_one_qubit(self) -> None:
        rules = CHALLENGE_BY_ID["vqe-find-theta"].constraints
        self.assertEqual(rules.allowed_gates, [GateName.RY])  # an X gate alone would also reach the lowest cost: only RY(theta) is the point
        self.assertEqual((rules.num_qubits, rules.max_ops, rules.min_gate_counts), (1, 1, {GateName.RY: 1}))

    def test_two_qubits_are_refused_by_the_structure(self) -> None:
        response = self.judge(circ(2, [GateOp(gate=GateName.RY, targets=[0], params=[PI])]))
        self.assertFalse(response.passed)

    def test_the_catalog_never_shows_the_target_or_the_reference(self) -> None:
        public = app_module.get_challenge_definition("vqe-find-theta")
        blob = public.model_dump_json()
        self.assertNotIn("reference_solution", blob)
        self.assertNotIn('"value"', blob)
        self.assertNotIn("misconception", blob)
        self.assertEqual([c.id for c in public.checks], ["final.expectation_z"])

    def test_the_check_has_no_target_circuit_so_nothing_can_be_matched_by_copying_one(self) -> None:
        check = CHALLENGE_BY_ID["vqe-find-theta"].checks[0]
        self.assertEqual((check.kind, check.observable, check.qubit, check.value), ("expectation_matches", "Z", 0, -1.0))
        self.assertFalse(hasattr(check, "target"))

    def test_a_check_value_outside_the_observables_range_cannot_be_defined(self) -> None:
        from qentor.challenges.models import ExpectationMatches

        with self.assertRaises(ValidationError):
            ExpectationMatches(id="x", label="x", hint_index=0, misconception="m", experiment="e", qubit=0, value=1.5)
        with self.assertRaises(ValidationError):
            ExpectationMatches(id="x", label="x", hint_index=0, misconception="m", experiment="e", qubit=0, value=-1.0, tolerance=0.5)


if __name__ == "__main__":
    unittest.main()
