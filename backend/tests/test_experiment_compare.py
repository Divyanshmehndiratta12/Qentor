"""Experiment comparison (Phase D): two real executions compared on the server, and the tutor asked about the difference."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import ComparisonTutorRequest, ExecuteRequest, ExperimentCompareRequest
from qentor.challenges.content import circ, g, m
from qentor.circuit.hashing import circuit_hash
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.provenance.store import ProvenanceStore
from qentor.tutor.claims import find_violations
from qentor.tutor.comparison import answer_comparison, answer_comparison_question, build_comparison_facts
from qentor.tutor.llm import LLMDraft, LLMUnavailable
from qentor.verification.equivalence import EquivalenceStatus
from qentor.verification.experiment_compare import (
    compare_experiments,
    compare_measurements,
    compare_result_states,
    diff_circuits,
    outcome_values,
)

S = 0.5**0.5
PLUS = {"statevector": [[S, 0.0], [S, 0.0]], "theoretical_probabilities": {"0": 0.5, "1": 0.5}}
I_PLUS = {"statevector": [[0.0, S], [0.0, S]]}  # |+> times i
MINUS = {"statevector": [[S, 0.0], [-S, 0.0]]}
H = circ(1, [g("h", 0)])
X = circ(1, [g("x", 0)])
BELL = circ(2, [g("h", 0), g("cx", 1, 0)])


class TestCircuitDiff(unittest.TestCase):
    def test_identical_circuits(self) -> None:
        d = diff_circuits(BELL, BELL)
        self.assertTrue(d.same_circuit)
        self.assertEqual([c.tag for c in d.changes], ["equal"])
        self.assertEqual(d.equivalence_status, EquivalenceStatus.EQUIVALENT)

    def test_a_replaced_gate(self) -> None:
        d = diff_circuits(H, X)
        self.assertFalse(d.same_circuit)
        self.assertEqual([(c.tag, c.a_ops, c.b_ops) for c in d.changes], [("replace", ["h(q0)"], ["x(q0)"])])
        self.assertEqual(d.equivalence_status, EquivalenceStatus.NOT_EQUIVALENT)

    def test_an_inserted_and_a_deleted_gate(self) -> None:
        ins = diff_circuits(circ(2, [g("h", 0)]), BELL)
        self.assertEqual([c.tag for c in ins.changes], ["equal", "insert"])
        self.assertEqual(ins.changes[1].b_ops, ["cx(control=q0, target=q1)"])
        dele = diff_circuits(BELL, circ(2, [g("h", 0)]))
        self.assertEqual([c.tag for c in dele.changes], ["equal", "delete"])

    def test_equivalent_but_different_circuits(self) -> None:
        hzh = circ(1, [g("h", 0), g("z", 0), g("h", 0)])
        d = diff_circuits(hzh, X)
        self.assertFalse(d.same_circuit)
        self.assertEqual(d.equivalence_status, EquivalenceStatus.EQUIVALENT)

    def test_different_widths_are_unverifiable_not_guessed(self) -> None:
        d = diff_circuits(H, circ(2, [g("h", 0)]))
        self.assertEqual(d.equivalence_status, EquivalenceStatus.UNVERIFIABLE)
        self.assertEqual((d.num_qubits_a, d.num_qubits_b), (1, 2))

    def test_an_angle_is_part_of_the_operation(self) -> None:
        from qentor.circuit.model import Circuit

        a = Circuit(num_qubits=1, num_clbits=0, ops=[{"gate": "rx", "targets": [0], "params": [0.5]}])
        b = Circuit(num_qubits=1, num_clbits=0, ops=[{"gate": "rx", "targets": [0], "params": [0.6]}])
        d = diff_circuits(a, b)
        self.assertEqual(d.changes[0].tag, "replace")
        self.assertEqual((d.changes[0].a_ops, d.changes[0].b_ops), (["rx(q0, angle=0.500000)"], ["rx(q0, angle=0.600000)"]))


class TestMeasurementDiff(unittest.TestCase):
    SHOTS = {"probabilities": {"0": 0.46, "1": 0.54}, "counts": {"0": 46, "1": 54}, "shots": 100}

    def test_kinds_are_read_from_the_record(self) -> None:
        self.assertEqual(outcome_values(self.SHOTS)[1], "sampled_frequency")
        self.assertEqual(outcome_values(PLUS)[1], "theoretical_probability")
        self.assertEqual(outcome_values({"statevector": PLUS["statevector"]})[1], "theoretical_probability")
        self.assertIsNone(outcome_values({"error": "x"}))

    def test_two_statevector_runs_identical(self) -> None:
        d = compare_measurements(PLUS, PLUS)
        self.assertTrue(d.comparable)
        self.assertEqual(d.total_variation_distance, 0.0)
        self.assertEqual(d.max_difference, 0.0)
        self.assertIsNone(d.note)

    def test_sampled_versus_theoretical_is_labelled(self) -> None:
        d = compare_measurements(PLUS, self.SHOTS)
        self.assertEqual((d.kind_a, d.kind_b), ("theoretical_probability", "sampled_frequency"))
        self.assertIn("sampling", d.note)
        self.assertAlmostEqual(d.max_difference, 0.04)
        self.assertAlmostEqual(d.total_variation_distance, 0.04)
        self.assertAlmostEqual(d.rows[0].difference, 0.04)

    def test_an_outcome_only_one_run_reported_is_absent_not_zero(self) -> None:
        d = compare_measurements({"theoretical_probabilities": {"0": 1.0}}, PLUS)
        row = next(r for r in d.rows if r.outcome == "1")
        self.assertIsNone(row.a)
        self.assertEqual(row.b, 0.5)
        self.assertIsNone(row.difference)
        self.assertAlmostEqual(d.total_variation_distance, 0.5)

    def test_different_label_widths_are_not_comparable(self) -> None:
        d = compare_measurements(PLUS, {"theoretical_probabilities": {"00": 1.0}})
        self.assertFalse(d.comparable)
        self.assertIn("different lengths", d.reason)
        self.assertEqual(d.rows, [])

    def test_a_run_with_no_values_is_not_comparable(self) -> None:
        d = compare_measurements(PLUS, {"error": "boom"})
        self.assertFalse(d.comparable)


class TestStateDiff(unittest.TestCase):
    def test_same_state_up_to_global_phase(self) -> None:
        d = compare_result_states(PLUS, I_PLUS)
        self.assertTrue(d.comparable)
        self.assertAlmostEqual(d.fidelity, 1.0)
        self.assertAlmostEqual(d.max_probability_difference, 0.0)
        self.assertGreater(d.max_amplitude_difference, 0.5, "amplitudes are not phase-blind")
        self.assertIn("global phase", d.note)

    def test_orthogonal_states(self) -> None:
        self.assertAlmostEqual(compare_result_states(PLUS, MINUS).fidelity, 0.0)

    def test_a_shots_run_has_no_state(self) -> None:
        d = compare_result_states(PLUS, {"counts": {"0": 1}, "probabilities": {"0": 1.0}})
        self.assertFalse(d.comparable)
        self.assertIsNone(d.fidelity)

    def test_different_sizes(self) -> None:
        d = compare_result_states(PLUS, {"statevector": [[1.0, 0.0]] + [[0.0, 0.0]] * 3})
        self.assertFalse(d.comparable)


class ApiCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = ProvenanceStore(Path(self._tmp.name) / "cmp.db")
        self._patches = [patch.object(app_module, "_store", self.store), patch.object(app_module, "_llm_adapter", None)]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        self.store.close()
        self._tmp.cleanup()

    def run_circuit(self, circuit, mode="statevector", shots=None, backend="qiskit-aer"):
        return app_module.execute(ExecuteRequest(circuit=circuit, mode=mode, shots=shots, backend=backend))

    def compare(self, a, ra, b, rb):
        return app_module.compare_experiments_endpoint(
            ExperimentCompareRequest(result_id_a=ra.result_id, circuit_a=a, result_id_b=rb.result_id, circuit_b=b)
        )


class TestCompareEndpoint(ApiCase):
    def test_the_same_circuit_on_two_backends_agrees(self) -> None:
        r = self.compare(BELL, self.run_circuit(BELL), BELL, self.run_circuit(BELL, backend="cirq"))
        self.assertEqual((r.a.provenance.backend, r.b.provenance.backend), ("qiskit-aer", "cirq"))
        self.assertTrue(r.circuit.same_circuit)
        self.assertAlmostEqual(r.state.fidelity, 1.0, places=6)
        self.assertAlmostEqual(r.measurement.total_variation_distance, 0.0, places=6)

    def test_different_circuits_show_the_difference_everywhere(self) -> None:
        r = self.compare(H, self.run_circuit(H), X, self.run_circuit(X))
        self.assertFalse(r.circuit.same_circuit)
        self.assertEqual(r.circuit.equivalence_status, EquivalenceStatus.NOT_EQUIVALENT)
        self.assertAlmostEqual(r.state.fidelity, 0.5)
        self.assertAlmostEqual(r.measurement.total_variation_distance, 0.5)

    def test_statevector_against_shots(self) -> None:
        hm = circ(1, [g("h", 0), m(0, 0)], 1)
        r = self.compare(hm, self.run_circuit(hm, "shots", 200), H, self.run_circuit(H))
        self.assertEqual((r.measurement.kind_a, r.measurement.kind_b), ("sampled_frequency", "theoretical_probability"))
        self.assertFalse(r.state.comparable)
        self.assertEqual(r.a.shots, 200)
        self.assertIsNone(r.b.shots)

    def test_the_comparison_is_its_own_provenance_record(self) -> None:
        ra, rb = self.run_circuit(H), self.run_circuit(X)
        r = self.compare(H, ra, X, rb)
        rec = self.store.get(r.comparison_id)
        self.assertEqual(rec.backend, "experiment-comparison")
        self.assertEqual(rec.execution_mode, "comparison")
        self.assertEqual(rec.payload["a"]["result_id"], ra.result_id)
        self.assertEqual(rec.payload["b"]["result_id"], rb.result_id)
        self.assertEqual(r.provenance.result_id, r.comparison_id)
        self.assertEqual(r.a.provenance.result_id, ra.result_id)

    def test_unknown_run_is_404(self) -> None:
        ra = self.run_circuit(H)
        with self.assertRaises(HTTPException) as c:
            app_module.compare_experiments_endpoint(
                ExperimentCompareRequest(result_id_a=ra.result_id, circuit_a=H, result_id_b="res_nope", circuit_b=X)
            )
        self.assertEqual(c.exception.status_code, 404)

    def test_a_circuit_that_did_not_produce_the_run_is_422(self) -> None:
        ra, rb = self.run_circuit(H), self.run_circuit(X)
        with self.assertRaises(HTTPException) as c:
            self.compare(X, ra, X, rb)  # A's record is H's run
        self.assertEqual(c.exception.detail["code"], "COMPARISON_CIRCUIT_MISMATCH")

    def test_a_failed_run_is_refused(self) -> None:
        failed = ProvenanceRecord.new(
            circuit_hash=circuit_hash(H), backend="qiskit-aer", backend_version="1", execution_mode="statevector",
            provenance_class=ProvenanceClass.SIMULATION, verification_status=ExecutionStatus.FAILED, payload={"error": "bad"},
        )
        self.store.insert(failed)
        rb = self.run_circuit(X)
        with self.assertRaises(HTTPException) as c:
            app_module.compare_experiments_endpoint(
                ExperimentCompareRequest(result_id_a=failed.result_id, circuit_a=H, result_id_b=rb.result_id, circuit_b=X)
            )
        self.assertEqual(c.exception.detail["code"], "COMPARISON_RESULT_UNUSABLE")

    def test_a_hardware_run_is_refused_not_compared_as_a_simulation(self) -> None:
        hw = ProvenanceRecord.new(
            circuit_hash=circuit_hash(H), backend="ibm", backend_version="1", execution_mode="shots",
            provenance_class=ProvenanceClass.RECORDED_HARDWARE, verification_status=ExecutionStatus.STATE_CHECKED,
            payload={"probabilities": {"0": 1.0}, "counts": {"0": 1}},
        )
        self.store.insert(hw)
        rb = self.run_circuit(H)
        with self.assertRaises(HTTPException) as c:
            app_module.compare_experiments_endpoint(
                ExperimentCompareRequest(result_id_a=hw.result_id, circuit_a=H, result_id_b=rb.result_id, circuit_b=H)
            )
        self.assertEqual(c.exception.detail["code"], "COMPARISON_CLASS_UNSUPPORTED")

    def test_the_request_has_no_field_for_a_number_or_verdict(self) -> None:
        ra = self.run_circuit(H)
        base = dict(result_id_a=ra.result_id, circuit_a=H.model_dump(by_alias=True), result_id_b=ra.result_id, circuit_b=H.model_dump(by_alias=True))
        for field in ("fidelity", "probabilities", "statevector", "verdict", "same"):
            with self.subTest(field=field), self.assertRaises(ValidationError):
                ExperimentCompareRequest.model_validate({**base, field: 1})


class FakeLLM:
    name = "fake"

    def __init__(self, answer=None, raises=None):
        self.answer, self.raises = answer, raises

    def generate(self, question, facts, language="en", lesson_facts=None, trace_facts=None):
        if self.raises:
            raise self.raises
        return LLMDraft(answer=self.answer, cited_fact_ids=["X1"])


class TestTutorAboutTheDifference(ApiCase):
    def setUp(self) -> None:
        super().setUp()
        self.cmp = self.compare(H, self.run_circuit(H), X, self.run_circuit(X))
        self.record = self.store.get(self.cmp.comparison_id)
        self.facts = build_comparison_facts(self.record)

    def ask(self, question, llm=None):
        with patch.object(app_module, "_llm_adapter", llm):
            return app_module.tutor_comparison_endpoint(ComparisonTutorRequest(comparison_id=self.cmp.comparison_id, question=question))

    def test_facts_are_x_ids_read_from_the_record_and_carry_its_id(self) -> None:
        self.assertTrue(all(f.id.startswith("X") for f in self.facts))
        self.assertTrue(all(f.result_id == self.cmp.comparison_id for f in self.facts))
        kinds = {f.kind for f in self.facts}
        self.assertEqual(kinds, {"comparison_identity", "comparison_circuit", "comparison_measurement", "comparison_state"})
        text = " ".join(f.description for f in self.facts)
        self.assertIn("run A applies h(q0) where run B applies x(q0)", text)
        self.assertIn("state fidelity between the two runs 0.500000", text)

    def test_a_general_question_gets_the_headline_of_each_part(self) -> None:
        r = self.ask("What is different between these two runs?")
        self.assertTrue(r.used_fallback_template)
        self.assertIn("not equivalent", r.answer)
        self.assertIn("total variation distance", r.answer)
        self.assertIn("state fidelity", r.answer)
        self.assertEqual(r.result_id, self.cmp.comparison_id)

    def test_specific_questions_get_the_matching_facts(self) -> None:
        self.assertIn("run A applies h(q0)", self.ask("which gates changed?").answer)
        self.assertIn("outcome 0", self.ask("how do the outcome probabilities differ").answer)
        self.assertIn("fidelity", self.ask("what is the fidelity?").answer)
        self.assertIn("qiskit-aer", self.ask("which backend was each run on?").answer)

    def test_the_deterministic_answer_makes_only_supported_claims(self) -> None:
        for q in ("What is different?", "which gates changed?", "compare the states"):
            answer = answer_comparison_question(q, self.facts)
            self.assertEqual(find_violations(answer, self.facts), [], answer)

    def test_a_guarded_llm_answer_is_used(self) -> None:
        r = self.ask("why?", FakeLLM("Run A applies h(q0) where run B applies x(q0) (X4)."))
        self.assertFalse(r.used_fallback_template)

    def test_an_llm_that_invents_a_number_or_verdict_is_replaced_by_the_template(self) -> None:
        for bad in ("The two runs agree to 0.99 fidelity.", "Your circuits are verified equivalent."):
            with self.subTest(bad=bad):
                r = self.ask("why?", FakeLLM(bad))
                self.assertTrue(r.used_fallback_template)
                self.assertNotIn("0.99", r.answer)

    def test_an_unavailable_llm_falls_back(self) -> None:
        self.assertTrue(self.ask("why?", FakeLLM(raises=LLMUnavailable("timeout"))).used_fallback_template)

    def test_unknown_or_wrong_kind_of_record_is_404(self) -> None:
        for cid in ("res_nope", self.run_circuit(H).result_id):
            with self.subTest(cid=cid), self.assertRaises(HTTPException) as c:
                app_module.tutor_comparison_endpoint(ComparisonTutorRequest(comparison_id=cid, question="why"))
            self.assertEqual(c.exception.status_code, 404)

    def test_equivalent_circuits_license_the_word_equivalent(self) -> None:
        hzh = circ(1, [g("h", 0), g("z", 0), g("h", 0)])
        cmp = self.compare(hzh, self.run_circuit(hzh), X, self.run_circuit(X))
        facts = build_comparison_facts(self.store.get(cmp.comparison_id))
        answer, fallback = answer_comparison("are they the same?", facts, FakeLLM("The two circuits are equivalent up to a global phase (X4)."))
        self.assertFalse(fallback)


if __name__ == "__main__":
    unittest.main()
