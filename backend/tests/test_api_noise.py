"""``/api/noise/*`` through the real FastAPI stack and the real stores: the Noise Lab's ideal-versus-noisy comparison.

The contract these tests pin:

* the request carries a circuit and the learner's choices, never a result: no field for a count, a probability, a distance or a verdict, and
  an unknown field is refused;
* every number in a response is read back from a stored provenance record, and the ideal run, the noisy run and the comparison are three
  separate records with their own ids, the noisy one labelled ``noisy_shots`` and carrying the noise that produced it;
* every limit is enforced before a simulator exists, with a structured error that names the limit;
* a failed or malformed run is an error, never a substituted result, and a noise record cannot be explained, verified, debugged, exported,
  shared or compared as if it were an ordinary run.

Successful runs call the endpoint function directly (as ``test_sharing`` does) rather than through the ASGI worker thread, see docs/BUILD_STATE.md
(Qiskit worker-thread crash); everything that is refused before a simulator runs goes through the whole stack.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from qentor.api import app as app_module
from qentor.api import noise as noise_api
from qentor.api.guards import HEAVY_PREFIXES
from qentor.api.noise import NoiseCompareRequest
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.noise import NOISE_MAX_QUBITS, NOISE_MAX_SHOTS, NOISE_MODEL_SPECS
from qentor.provenance.models import ExecutionStatus, ProvenanceClass
from qentor.provenance.store import ProvenanceStore
from tests.asgi_driver import http


def g(name, targets, controls=(), params=(), clbits=()):
    return GateOp(gate=name, targets=list(targets), controls=list(controls), params=list(params), clbits=list(clbits))


def measured(n, *ops):
    return Circuit(num_qubits=n, num_clbits=n, ops=[*ops, *[g("measure", [q], clbits=[q]) for q in range(n)]])


BELL = measured(2, g("h", [0]), g("cx", [1], [0]))
UNMEASURED = Circuit(num_qubits=2, num_clbits=0, ops=[g("h", [0]), g("cx", [1], [0])])


def circuit_json(c: Circuit) -> dict:
    return json.loads(c.model_dump_json(by_alias=True))


class NoiseApiCase(unittest.TestCase):
    def setUp(self) -> None:
        try:
            AerAdapter().run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable in this environment: {exc}")
        self._tmp = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmp.name) / "noise.db")
        self._patch = patch.object(app_module, "_store", self.store)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self.store.close()
        self._tmp.cleanup()

    def compare(self, circuit: Circuit = BELL, **fields):
        return noise_api.compare_endpoint(NoiseCompareRequest(circuit=circuit, **fields))

    def refused(self, circuit: Circuit = BELL, **fields) -> HTTPException:
        with self.assertRaises(HTTPException) as ctx:
            self.compare(circuit, **fields)
        return ctx.exception

    def post(self, body: dict) -> tuple[int, dict]:
        status, raw = http("POST", "/api/noise/compare", json.dumps(body).encode())
        return status, json.loads(raw)


class TestCatalog(unittest.TestCase):
    def test_the_catalog_is_the_servers_table_not_a_second_copy(self) -> None:
        status, raw = http("GET", "/api/noise/models")
        self.assertEqual(status, 200)
        body = json.loads(raw)
        self.assertEqual([m["name"] for m in body["models"]], [n.value for n in NOISE_MODEL_SPECS])
        for entry in body["models"]:
            spec = NOISE_MODEL_SPECS[next(n for n in NOISE_MODEL_SPECS if n.value == entry["name"])]
            self.assertEqual((entry["min_strength"], entry["max_strength"], entry["default_strength"]), (spec.min_strength, spec.max_strength, spec.default_strength))
            self.assertEqual(entry["expect"], list(spec.expect))

    def test_the_catalog_states_the_limits_and_that_this_is_simulated_noise(self) -> None:
        body = json.loads(http("GET", "/api/noise/models")[1])
        self.assertEqual(body["limits"]["max_qubits"], NOISE_MAX_QUBITS)
        self.assertEqual(body["limits"]["max_shots"], NOISE_MAX_SHOTS)
        self.assertEqual(body["limits"]["simulation_method"], "density_matrix")
        self.assertEqual(body["backend"], "qiskit-aer")
        self.assertIn("Not a real device", body["label"])

    def test_noise_requests_are_gated_like_every_other_heavy_request(self) -> None:
        self.assertIn("/api/noise/", HEAVY_PREFIXES)


class TestIdealOnly(NoiseApiCase):
    def test_the_none_model_runs_only_the_ideal_simulation(self) -> None:
        r = self.compare(noise_model="none", shots=500, seed=3)
        self.assertIsNone(r.noisy)
        self.assertIsNone(r.comparison)
        self.assertEqual(r.noise.model, "none")
        self.assertEqual(sum(r.ideal.counts.values()), 500)
        self.assertEqual(set(r.ideal.counts), {"00", "11"})

    def test_the_ideal_run_is_an_ordinary_shots_record(self) -> None:
        r = self.compare(noise_model="none", shots=200, seed=3)
        record = self.store.get(r.ideal.provenance.result_id)
        self.assertEqual(record.execution_mode, "shots")
        self.assertEqual(record.provenance_class, ProvenanceClass.SIMULATION)
        self.assertEqual(record.verification_status, ExecutionStatus.STATE_CHECKED)
        self.assertNotIn("noise", record.payload)
        self.assertEqual(record.circuit_hash, circuit_hash(BELL))

    def test_it_says_it_is_simulated(self) -> None:
        r = self.compare(noise_model="none", shots=100)
        self.assertIn("Simulated noise", r.label)
        self.assertEqual(r.backend, "qiskit-aer")
        self.assertEqual(r.ideal.provenance.provenance_class, "SIMULATION")


class TestIdealVersusNoisy(NoiseApiCase):
    def setUp(self) -> None:
        super().setUp()
        self.r = self.compare(noise_model="depolarizing", noise_strength=0.1, shots=2000, seed=21)

    def test_there_are_three_separate_records_with_their_own_ids(self) -> None:
        ids = [self.r.ideal.provenance.result_id, self.r.noisy.provenance.result_id, self.r.comparison.provenance.result_id]
        self.assertEqual(len(set(ids)), 3)
        for result_id in ids:
            self.assertIsNotNone(self.store.get(result_id))

    def test_the_noisy_record_says_what_it_is(self) -> None:
        record = self.store.get(self.r.noisy.provenance.result_id)
        self.assertEqual(record.execution_mode, "noisy_shots")
        self.assertEqual(record.provenance_class, ProvenanceClass.SIMULATION)  # never hardware
        self.assertEqual(record.verification_status, ExecutionStatus.STATE_CHECKED)
        self.assertEqual(record.backend, "qiskit-aer")
        noise = record.payload["noise"]
        self.assertEqual((noise["model"], noise["strength"], noise["seed"], noise["simulation_method"]), ("depolarizing", 0.1, 21, "density_matrix"))
        self.assertEqual(noise["applies_to"], "gates")

    def test_the_response_counts_are_the_stored_counts(self) -> None:
        for block in (self.r.ideal, self.r.noisy):
            record = self.store.get(block.provenance.result_id)
            self.assertEqual(block.counts, record.payload["counts"])
            self.assertEqual(block.probabilities, record.payload["probabilities"])
            self.assertEqual(block.shots, record.payload["shots"])
            self.assertEqual(block.execution_id, record.payload["execution_id"])

    def test_the_two_runs_are_runs_of_the_same_circuit_with_the_same_shots(self) -> None:
        self.assertEqual(self.r.ideal.provenance.circuit_hash, circuit_hash(BELL))
        self.assertEqual(self.r.noisy.provenance.circuit_hash, circuit_hash(BELL))
        self.assertEqual((self.r.ideal.shots, self.r.noisy.shots), (2000, 2000))

    def test_the_noisy_run_really_differs_from_the_ideal_one(self) -> None:
        self.assertEqual(set(self.r.ideal.counts), {"00", "11"})
        self.assertTrue({"01", "10"} & set(self.r.noisy.counts), "depolarizing noise at 0.1 puts shots on outcomes the Bell pair never gives")
        self.assertNotEqual(self.r.ideal.counts, self.r.noisy.counts)

    def test_the_noisy_blocks_carry_their_noise_and_the_ideal_block_carries_none(self) -> None:
        self.assertIsNone(self.r.ideal.noise)
        self.assertEqual((self.r.noisy.noise.model, self.r.noisy.noise.strength, self.r.noisy.noise.seed), ("depolarizing", 0.1, 21))
        self.assertEqual(self.r.noise.label, "Depolarizing gate noise")

    def test_the_comparison_is_a_third_record_that_names_both_runs(self) -> None:
        record = self.store.get(self.r.comparison.provenance.result_id)
        self.assertEqual(record.execution_mode, "noise_comparison")
        self.assertEqual(record.backend, "noise-comparison")
        self.assertTrue(record.circuit_hash.startswith("noise_"))
        self.assertEqual(record.payload["ideal_result_id"], self.r.ideal.provenance.result_id)
        self.assertEqual(record.payload["noisy_result_id"], self.r.noisy.provenance.result_id)
        self.assertEqual(record.payload["circuit_hash"], circuit_hash(BELL))
        self.assertEqual(record.payload["noise"]["model"], "depolarizing")

    def test_every_comparison_number_is_the_stored_one(self) -> None:
        record = self.store.get(self.r.comparison.provenance.result_id)
        self.assertEqual(self.r.comparison.metrics.model_dump(mode="json"), record.payload["metrics"])
        self.assertEqual([row.model_dump(mode="json") for row in self.r.comparison.rows], record.payload["rows"])
        self.assertEqual([line.model_dump(mode="json") for line in self.r.comparison.explanation], record.payload["explanation"])

    def test_the_metrics_follow_from_the_two_stored_count_tables(self) -> None:
        ideal, noisy, shots = self.r.ideal.counts, self.r.noisy.counts, 2000
        outcomes = set(ideal) | set(noisy)
        tvd = sum(abs(ideal.get(o, 0) - noisy.get(o, 0)) for o in outcomes) / (2 * shots)
        self.assertAlmostEqual(self.r.comparison.metrics.total_variation_distance, tvd, places=12)
        self.assertEqual(self.r.comparison.metrics.new_outcomes, sorted(o for o in noisy if o not in ideal))

    def test_the_explanation_comes_from_the_comparison_and_never_claims_hardware(self) -> None:
        text = " ".join(line.text for line in self.r.comparison.explanation)
        self.assertIn("Depolarizing gate noise", text)
        self.assertIn("seed 21", text)
        for word in ("hardware", "fidelity", "success"):
            self.assertNotIn(word, text.lower())
        self.assertIn("not a real device", self.r.label.lower())

    def test_the_same_seed_reproduces_both_runs_and_makes_new_records(self) -> None:
        again = self.compare(noise_model="depolarizing", noise_strength=0.1, shots=2000, seed=21)
        self.assertEqual(again.ideal.counts, self.r.ideal.counts)
        self.assertEqual(again.noisy.counts, self.r.noisy.counts)
        self.assertNotEqual(again.noisy.provenance.result_id, self.r.noisy.provenance.result_id)

    def test_a_different_strength_gives_a_different_noisy_run_and_the_same_ideal_run(self) -> None:
        stronger = self.compare(noise_model="depolarizing", noise_strength=0.3, shots=2000, seed=21)
        self.assertEqual(stronger.ideal.counts, self.r.ideal.counts)
        self.assertNotEqual(stronger.noisy.counts, self.r.noisy.counts)
        self.assertGreater(stronger.comparison.metrics.total_variation_distance, self.r.comparison.metrics.total_variation_distance)

    def test_a_missing_strength_uses_the_models_default_and_says_so(self) -> None:
        r = self.compare(noise_model="bit_flip", shots=200, seed=1)
        self.assertEqual(r.noise.strength, NOISE_MODEL_SPECS[next(n for n in NOISE_MODEL_SPECS if n.value == "bit_flip")].default_strength)

    def test_a_missing_seed_is_chosen_and_recorded_so_the_run_can_be_repeated(self) -> None:
        r = self.compare(noise_model="depolarizing", noise_strength=0.1, shots=500)
        again = self.compare(noise_model="depolarizing", noise_strength=0.1, shots=500, seed=r.noise.seed)
        self.assertEqual(again.noisy.counts, r.noisy.counts)

    def test_readout_error_changes_only_what_is_read_out(self) -> None:
        r = self.compare(circuit=measured(1), noise_model="readout_error", noise_strength=0.2, shots=3000, seed=2)
        self.assertEqual(set(r.ideal.counts), {"0"})
        self.assertEqual(r.noisy.noise.applies_to, "measurement")
        self.assertTrue(0.16 < r.noisy.probabilities["1"] < 0.24)

    def test_every_model_gives_a_comparison(self) -> None:
        for name in ("depolarizing", "bit_flip", "phase_flip", "amplitude_damping", "readout_error"):
            with self.subTest(model=name):
                r = self.compare(noise_model=name, shots=300, seed=4)
                self.assertEqual(r.noisy.noise.model, name)
                self.assertEqual(r.noisy.provenance.execution_mode, "noisy_shots")


class TestRefusals(NoiseApiCase):
    def code(self, exc: HTTPException) -> str:
        return exc.detail["code"]

    def test_a_strength_outside_the_models_range_is_refused_with_the_limit(self) -> None:
        exc = self.refused(noise_model="depolarizing", noise_strength=0.4)
        self.assertEqual((exc.status_code, self.code(exc)), (422, "NOISE_STRENGTH_OUT_OF_RANGE"))
        self.assertEqual((exc.detail["limit"], exc.detail["requested"]), (0.3, 0.4))
        self.assertEqual(self.store.list_by_circuit_hash(circuit_hash(BELL)), [], "a refused request stored nothing")

    def test_none_with_a_strength_is_refused(self) -> None:
        self.assertEqual(self.code(self.refused(noise_model="none", noise_strength=0.1)), "NOISE_STRENGTH_NOT_ALLOWED")

    def test_too_many_qubits_for_a_noisy_run(self) -> None:
        exc = self.refused(measured(NOISE_MAX_QUBITS + 1), noise_model="depolarizing", shots=100)
        self.assertEqual((exc.status_code, self.code(exc)), (422, "NOISE_TOO_MANY_QUBITS"))
        self.assertEqual(exc.detail["limit"], NOISE_MAX_QUBITS)

    def test_a_circuit_without_a_measurement_is_refused(self) -> None:
        self.assertEqual(self.code(self.refused(UNMEASURED, noise_model="depolarizing")), "NOISE_NEEDS_MEASUREMENT")

    def test_another_backend_is_refused_not_emulated(self) -> None:
        for backend in ("cirq", "pennylane", "ibm_brisbane", ""):
            with self.subTest(backend=backend):
                exc = self.refused(noise_model="depolarizing", backend=backend)
                self.assertEqual((exc.status_code, self.code(exc)), (422, "NOISE_BACKEND_UNSUPPORTED"))
                self.assertIn("nothing was run or substituted", exc.detail["message"])

    def test_an_over_long_circuit_hits_the_ordinary_operation_limit(self) -> None:
        long = measured(1, *[g("h", [0]) for _ in range(501)])
        exc = self.refused(long, noise_model="depolarizing")
        self.assertEqual(exc.status_code, 422)
        self.assertEqual(self.code(exc), "CIRCUIT_TOO_MANY_OPERATIONS")

    def test_a_refusal_runs_no_simulator(self) -> None:
        with patch.object(noise_api, "run_noisy_shots") as noisy, patch.object(AerAdapter, "run") as ideal:
            self.refused(noise_model="depolarizing", noise_strength=0.4)
            self.refused(measured(NOISE_MAX_QUBITS + 1), noise_model="depolarizing")
            self.refused(UNMEASURED, noise_model="depolarizing")
            self.refused(noise_model="depolarizing", backend="cirq")
        noisy.assert_not_called()
        ideal.assert_not_called()


class TestMalformedRequestsThroughTheWholeStack(unittest.TestCase):
    def post(self, body) -> tuple[int, dict]:
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        status, out = http("POST", "/api/noise/compare", raw)
        return status, json.loads(out)

    def base(self, **extra) -> dict:
        return {"circuit": circuit_json(BELL), "noise_model": "depolarizing", "noise_strength": 0.1, "shots": 100, **extra}

    def test_an_unknown_noise_model_is_a_schema_error(self) -> None:
        status, body = self.post(self.base(noise_model="coherent_overrotation"))
        self.assertEqual(status, 422)
        self.assertIn("noise_model", json.dumps(body))

    def test_no_client_field_can_carry_a_result(self) -> None:
        for field, value in (
            ("counts", {"00": 1}), ("probabilities", {"00": 1.0}), ("noisy_counts", {"01": 5}), ("ideal_counts", {"00": 100}),
            ("total_variation_distance", 0.0), ("result", {}), ("verdict", "pass"), ("statevector", [[1, 0]]),
        ):
            with self.subTest(field=field):
                status, body = self.post(self.base(**{field: value}))
                self.assertEqual(status, 422, body)
                self.assertIn("extra", json.dumps(body).lower())

    def test_bounds_the_schema_states(self) -> None:
        for patch_ in ({"shots": 0}, {"shots": -1}, {"shots": NOISE_MAX_SHOTS + 1}, {"noise_strength": -0.1}, {"noise_strength": 1.5}, {"seed": -1}, {"seed": 2**31}):
            with self.subTest(**patch_):
                self.assertEqual(self.post(self.base(**patch_))[0], 422)

    def test_wrong_types(self) -> None:
        for patch_ in ({"shots": "many"}, {"shots": 1.5}, {"noise_strength": "high"}, {"seed": "x"}, {"noise_model": 3}, {"noise_model": None}):
            with self.subTest(**patch_):
                self.assertEqual(self.post(self.base(**patch_))[0], 422)

    def test_a_missing_or_malformed_circuit(self) -> None:
        self.assertEqual(self.post({"noise_model": "depolarizing"})[0], 422)
        self.assertEqual(self.post(self.base(circuit={"ops": "nope"}))[0], 422)
        self.assertEqual(self.post(b"not json")[0], 422)
        self.assertEqual(self.post(b"[]")[0], 422)

    def test_a_circuit_over_the_noisy_qubit_limit_is_refused_by_the_whole_stack(self) -> None:
        status, body = self.post(self.base(circuit=circuit_json(measured(NOISE_MAX_QUBITS + 1))))
        self.assertEqual(status, 422)
        self.assertEqual(body["detail"]["code"], "NOISE_TOO_MANY_QUBITS")

    def test_python_cannot_be_smuggled_in_as_a_model_or_a_circuit(self) -> None:
        for model in ("__import__('os').system('true')", "depolarizing; rm -rf /", "eval(1)"):
            self.assertEqual(self.post(self.base(noise_model=model))[0], 422)

    def test_get_on_the_compare_path_is_not_allowed(self) -> None:
        self.assertIn(http("GET", "/api/noise/compare")[0], (404, 405))  # a POST-only path answers no GET with a result


class TestFailuresAreNotHidden(NoiseApiCase):
    def test_a_failed_noisy_run_is_an_error_record_and_a_400(self) -> None:
        with patch.object(noise_api, "run_noisy_shots", side_effect=AdapterExecutionError("Aer ran out of memory")):
            exc = self.refused(noise_model="depolarizing", shots=100, seed=1)
        self.assertEqual((exc.status_code, exc.detail["code"]), (400, "NOISE_NOISY_RUN_FAILED"))
        records = self.store.list_by_circuit_hash(circuit_hash(BELL))
        errors = [r for r in records if r.verification_status == ExecutionStatus.ERROR and r.execution_mode == "noisy_shots"]
        self.assertEqual(len(errors), 1, "the failure is recorded, as an ERROR noisy_shots record with no counts")
        self.assertNotIn("counts", errors[0].payload)
        self.assertEqual(errors[0].payload["noise"]["model"], "depolarizing")
        self.assertEqual([r for r in records if r.execution_mode == "noisy_shots" and r.verification_status == ExecutionStatus.STATE_CHECKED], [])

    def test_an_unavailable_simulator_is_a_503_with_no_result(self) -> None:
        with patch.object(noise_api, "run_noisy_shots", side_effect=AdapterUnavailable("blocked")):
            exc = self.refused(noise_model="depolarizing", shots=100, seed=1)
        self.assertEqual((exc.status_code, exc.detail["code"]), (503, "NOISE_BACKEND_UNAVAILABLE"))

    def test_a_noisy_result_that_fails_the_state_check_is_a_502_and_is_never_shown(self) -> None:
        real = noise_api.run_noisy_shots

        def broken(circuit, shots, config):
            result = real(circuit, shots, config)
            result.counts = {"00": 1}  # the counts no longer add up to the shots
            return result

        with patch.object(noise_api, "run_noisy_shots", broken):
            exc = self.refused(noise_model="depolarizing", shots=100, seed=1)
        self.assertEqual(exc.status_code, 502)
        self.assertEqual(exc.detail["code"], "EXECUTION_STATE_INVALID")

    def test_a_noisy_run_that_does_not_add_up_is_stored_as_failed_not_as_checked(self) -> None:
        real = noise_api.run_noisy_shots

        def broken(circuit, shots, config):
            result = real(circuit, shots, config)
            result.counts = {"00": 1}
            return result

        with patch.object(noise_api, "run_noisy_shots", broken):
            self.refused(noise_model="depolarizing", shots=100, seed=1)
        noisy = [r for r in self.store.list_by_circuit_hash(circuit_hash(BELL)) if r.execution_mode == "noisy_shots"]
        self.assertEqual([r.verification_status for r in noisy], [ExecutionStatus.FAILED])
        self.assertNotIn("counts", noisy[0].payload)  # a result that failed its check keeps none of its numbers


class TestNoiseRecordsAreNotOrdinaryRuns(NoiseApiCase):
    """A noise record is stored like any result but is not 'a run of a circuit': the features that read one by id say so and do nothing with it."""

    def setUp(self) -> None:
        super().setUp()
        r = self.compare(noise_model="depolarizing", noise_strength=0.1, shots=200, seed=5)
        self.noisy_id = r.noisy.provenance.result_id
        self.comparison_id = r.comparison.provenance.result_id
        self.circuit = circuit_json(BELL)

    def assertRefused(self, status: int, body: dict) -> None:
        self.assertEqual(status, 422, body)
        self.assertEqual(body["detail"]["code"], "NOISE_RESULT_NOT_SUPPORTED_HERE")
        self.assertIn("simulated-noise result", body["detail"]["message"])

    def call(self, path: str, body: dict) -> tuple[int, dict]:
        status, raw = http("POST", path, json.dumps(body).encode())
        return status, json.loads(raw)

    def test_the_tutor_does_not_explain_a_noisy_run_as_if_it_were_ideal(self) -> None:
        for rid in (self.noisy_id, self.comparison_id):
            self.assertRefused(*self.call("/api/tutor", {"question": "what happened?", "circuit": self.circuit, "result_id": rid}))

    def test_the_bell_verifier_refuses_a_noisy_run(self) -> None:
        self.assertRefused(*self.call("/api/verify/bell-state", {"circuit": self.circuit, "result_id": self.noisy_id}))

    def test_export_does_not_attach_a_noisy_run(self) -> None:
        self.assertRefused(*self.call("/api/export/circuit", {"circuit": self.circuit, "result_id": self.noisy_id}))

    def test_a_noisy_run_cannot_be_shared_as_the_run_of_a_circuit(self) -> None:
        self.assertRefused(*self.call("/api/experiments", {"circuit": self.circuit, "result_id": self.noisy_id}))

    def test_the_experiment_comparison_does_not_take_a_noisy_run(self) -> None:
        r = self.compare(noise_model="none", shots=100, seed=1)
        self.assertRefused(
            *self.call("/api/compare/experiments", {"result_id_a": r.ideal.provenance.result_id, "circuit_a": self.circuit, "result_id_b": self.noisy_id, "circuit_b": self.circuit})
        )

    def test_the_debugger_does_not_take_a_noisy_run(self) -> None:
        self.assertRefused(*self.call("/api/debug", {"circuit": self.circuit, "result_id": self.noisy_id}))

    def test_the_comparison_tutor_only_knows_experiment_comparisons(self) -> None:
        status, body = self.call("/api/tutor/comparison", {"comparison_id": self.comparison_id, "question": "why?"})
        self.assertEqual(status, 404)

    def test_the_reasoning_engine_does_not_read_a_noisy_run_as_a_measurement(self) -> None:
        status, body = self.call("/api/reasoning/analyze", {"intent": "PROBABILITY", "circuit": self.circuit, "result_id": self.noisy_id, "target": {"kind": "most_likely"}})
        self.assertEqual(status, 422, body)
        self.assertEqual(body["detail"]["code"], "REASONING_RESULT_UNUSABLE")


if __name__ == "__main__":
    unittest.main()
