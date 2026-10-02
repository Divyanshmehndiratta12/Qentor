"""The quantum reasoning engine: each intent, answered from backend runs, with provenance, through the real endpoint functions.

Every expected number is read from the stored provenance record the engine says it used (or written down from physics that is
independent of the engine: a Bell state is 1/2 and 1/2). None is hard-coded into a shipped module.
"""

from __future__ import annotations

import math
import unittest

from qentor.api import app as app_module
from qentor.api import reasoning as reasoning_api
from qentor.api.schemas import CodeRequest  # noqa: F401  (import check only: the schemas module still loads with the new fields)
from qentor.challenges.content import circ, g
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.provenance.models import ProvenanceClass

from tests.reasoning_case import BELL, BELL_MEASURED, REDUNDANT, SUPERPOSITION, ReasoningCase, cj


class TestProbability(ReasoningCase):
    def test_a_basis_state_probability_is_read_from_the_backends_statevector(self) -> None:
        run = self.run_circuit(BELL)
        response = self.probability(BELL, run.result_id, {"kind": "basis_state", "bits": "11"})
        item = response.data["items"][0]
        record = self.store.get(run.result_id)
        self.assertAlmostEqual(item["theoretical_probability"], record.payload["theoretical_probabilities"]["11"], places=12)
        self.assertAlmostEqual(item["theoretical_probability"], 0.5, places=9)
        self.assertIsNone(item["sampled_frequency"])
        self.assertEqual(response.status, "OK")
        self.assertEqual(response.intent, "PROBABILITY")

    def test_the_analysis_names_the_run_it_rests_on_with_full_provenance(self) -> None:
        run = self.run_circuit(BELL)
        response = self.probability(BELL, run.result_id, {"kind": "basis_state", "bits": "00"})
        source = response.sources[0]
        record = self.store.get(run.result_id)
        self.assertEqual(source.result_id, run.result_id)
        self.assertEqual(source.execution_id, record.payload["execution_id"])
        self.assertEqual(source.backend, record.backend)
        self.assertEqual(source.backend_version, record.backend_version)
        self.assertEqual(source.circuit_hash, circuit_hash(BELL))
        self.assertEqual(source.provenance_class, "SIMULATION")
        self.assertEqual(source.verification_status, "STATE_CHECKED")
        # and the analysis is itself a provenance record the tutor can be asked about
        analysis = self.store.get(response.analysis_id)
        self.assertEqual(analysis.backend, "reasoning-engine")
        self.assertEqual(analysis.provenance_class, ProvenanceClass.SIMULATION)
        self.assertEqual(response.provenance.result_id, response.analysis_id)

    def test_a_qubit_probability_sums_the_outcomes_with_that_bit(self) -> None:
        circuit = circ(2, [g("x", 1)])  # |10>: q1 = 1, q0 = 0
        run = self.run_circuit(circuit)
        one = self.probability(circuit, run.result_id, {"kind": "qubit_value", "qubit": 1, "value": 1}).data["items"][0]
        zero = self.probability(circuit, run.result_id, {"kind": "qubit_value", "qubit": 0, "value": 1}).data["items"][0]
        self.assertAlmostEqual(one["theoretical_probability"], 1.0, places=9)
        self.assertAlmostEqual(zero["theoretical_probability"], 0.0, places=9)

    def test_a_single_digit_on_a_register_is_answered_for_each_qubit(self) -> None:
        run = self.run_circuit(BELL)
        response = self.probability(BELL, run.result_id, {"kind": "each_qubit_value", "value": 1})
        self.assertEqual([i["qubit"] for i in response.data["items"]], [0, 1])
        for item in response.data["items"]:
            self.assertAlmostEqual(item["theoretical_probability"], 0.5, places=9)

    def test_the_most_likely_outcome_reports_a_tie_instead_of_choosing(self) -> None:
        run = self.run_circuit(BELL)
        response = self.probability(BELL, run.result_id, {"kind": "most_likely"})
        self.assertEqual({i["outcome"] for i in response.data["items"]}, {"00", "11"})
        self.assertTrue(any("tie" in n for n in response.data["notes"]))

    def test_the_most_likely_outcome_of_a_definite_state(self) -> None:
        circuit = circ(2, [g("x", 0)])
        run = self.run_circuit(circuit)
        response = self.probability(circuit, run.result_id, {"kind": "most_likely"})
        self.assertEqual([i["outcome"] for i in response.data["items"]], ["01"])

    def test_sampled_frequency_is_shown_beside_the_theoretical_probability(self) -> None:
        run = self.run_circuit(BELL_MEASURED, "shots", 2000)
        response = self.probability(BELL_MEASURED, run.result_id, {"kind": "sampled_vs_theoretical"})
        record = self.store.get(run.result_id)
        self.assertEqual({s.role for s in response.sources}, {"sampled", "theoretical"})
        rows = {i["outcome"]: i for i in response.data["items"]}
        for outcome, count in record.payload["counts"].items():
            self.assertEqual(rows[outcome]["sampled_count"], count)
            self.assertAlmostEqual(rows[outcome]["sampled_frequency"], count / 2000, places=12)
            self.assertAlmostEqual(rows[outcome]["theoretical_probability"], 0.5, places=9)
            self.assertAlmostEqual(rows[outcome]["difference"], abs(count / 2000 - 0.5), places=9)
        # two different runs: the shots run the learner made, and a statevector run the engine made and recorded
        theoretical = next(s for s in response.sources if s.role == "theoretical")
        self.assertEqual(self.store.get(theoretical.result_id).execution_mode, "statevector")
        self.assertNotEqual(theoretical.result_id, run.result_id)

    def test_sampled_versus_theoretical_without_a_shots_run_says_so(self) -> None:
        run = self.run_circuit(BELL)
        response = self.probability(BELL, run.result_id, {"kind": "sampled_vs_theoretical"})
        self.assertEqual(response.status, "NOT_APPLICABLE")
        self.assertIn("shots", response.reason)
        self.assertEqual(response.data["items"], [])

    def test_a_statevector_run_of_a_measured_circuit_is_not_used_as_its_theoretical_state(self) -> None:
        run = self.run_circuit(BELL_MEASURED)  # statevector mode of a circuit with measurements: collapsed, so not used
        response = self.probability(BELL_MEASURED, run.result_id, {"kind": "basis_state", "bits": "00"})
        theoretical = next(s for s in response.sources if s.role == "theoretical")
        self.assertNotEqual(theoretical.result_id, run.result_id)
        self.assertAlmostEqual(response.data["items"][0]["theoretical_probability"], 0.5, places=9)

    def test_a_shots_run_that_does_not_measure_qubit_k_into_bit_k_is_not_matched_to_basis_states(self) -> None:
        swapped = circ(2, [g("h", 0), g("cx", 1, control=0), GateOp(gate=GateName.MEASURE, targets=[0], clbits=[1]), GateOp(gate=GateName.MEASURE, targets=[1], clbits=[0])], num_clbits=2)
        run = self.run_circuit(swapped, "shots", 500)
        response = self.probability(swapped, run.result_id, {"kind": "basis_state", "bits": "11"})
        item = response.data["items"][0]
        self.assertIsNone(item["sampled_frequency"])
        self.assertTrue(any("classical bits" in n for n in response.data["notes"]))

    def test_the_bit_order_is_stated(self) -> None:
        run = self.run_circuit(BELL)
        response = self.probability(BELL, run.result_id, {"kind": "most_likely"})
        self.assertIn("q[1]…q[0]", response.data["bit_order"])
        self.assertTrue(any("q[1]…q[0]" in f.description for f in response.facts))

    def test_a_target_that_does_not_fit_the_circuit_is_refused(self) -> None:
        run = self.run_circuit(BELL)
        self.assertEqual(self.code_of(self.refused({"intent": "PROBABILITY", "circuit": cj(BELL), "result_id": run.result_id, "target": {"kind": "basis_state", "bits": "1"}})), "PROBABILITY_TARGET_INVALID")
        self.assertEqual(self.code_of(self.refused({"intent": "PROBABILITY", "circuit": cj(BELL), "result_id": run.result_id, "target": {"kind": "qubit_value", "qubit": 5, "value": 1}})), "PROBABILITY_TARGET_INVALID")

    def test_facts_quote_the_engines_numbers(self) -> None:
        run = self.run_circuit(SUPERPOSITION)
        response = self.probability(SUPERPOSITION, run.result_id, {"kind": "basis_state", "bits": "1"})
        probability_facts = [f for f in response.facts if f.kind == "probability"]
        self.assertEqual(len(probability_facts), 1)
        self.assertIn("0.500000", probability_facts[0].description)
        self.assertTrue(all(f.result_id == response.analysis_id for f in response.facts))
        self.assertIn("0.500000", response.answer)


class TestOptimization(ReasoningCase):
    def test_a_redundant_circuit_gets_a_verified_shorter_candidate(self) -> None:
        response = self.analyze({"intent": "OPTIMIZE", "circuit": cj(REDUNDANT)})
        data = response.data
        self.assertEqual(response.status, "OK")
        self.assertEqual((data["original_op_count"], data["candidate_op_count"], data["operations_removed"]), (3, 1, 2))
        self.assertEqual(data["optimization_status"], "VERIFIED_SHORTER")
        self.assertEqual(data["equivalence"]["status"], "EQUIVALENT")
        self.assertEqual(data["equivalence"]["method"], "qiskit.quantum_info.Operator.equiv")
        self.assertTrue(data["rewrites"])
        self.assertTrue(all(note["explanation"] for note in data["rewrites"]))
        self.assertEqual(data["original_circuit_hash"], circuit_hash(REDUNDANT))
        candidate = Circuit.model_validate(data["candidate_circuit"])
        self.assertEqual(data["candidate_circuit_hash"], circuit_hash(candidate))
        self.assertEqual(len(candidate.ops), 1)
        self.assertIn("OPENQASM 3", data["original_qasm"])

    def test_the_candidate_carries_its_own_provenance(self) -> None:
        response = self.analyze({"intent": "OPTIMIZE", "circuit": cj(REDUNDANT)})
        candidate = next(s for s in response.sources if s.role == "candidate")
        record = self.store.get(candidate.result_id)
        self.assertEqual(record.circuit_hash, response.data["candidate_circuit_hash"])
        self.assertEqual(candidate.provenance_class, "SIMULATION")
        self.assertEqual(response.data["candidate_result_id"], candidate.result_id)

    def test_no_improvement_is_an_explicit_result_with_no_candidate_circuit(self) -> None:
        response = self.analyze({"intent": "OPTIMIZE", "circuit": cj(BELL)})
        self.assertEqual(response.status, "NO_IMPROVEMENT")
        self.assertIn("no rewrite rule matched", response.reason)
        self.assertIsNone(response.data["candidate_circuit"])
        self.assertIsNone(response.data["candidate_circuit_hash"])
        self.assertEqual(response.data["operations_removed"], 0)
        self.assertEqual(response.data["original_op_count"], len(BELL.ops))
        self.assertIn("no safe improvement", response.answer)

    def test_the_answer_says_the_checker_not_the_tutor_decided(self) -> None:
        response = self.analyze({"intent": "OPTIMIZE", "circuit": cj(REDUNDANT)})
        self.assertIn("checker", response.answer)
        self.assertIn("equivalent", " ".join(f.description for f in response.facts))

    def test_a_circuit_over_the_equivalence_limit_is_refused_not_guessed(self) -> None:
        big = circ(11, [g("h", 0)])
        exc = self.refused({"intent": "OPTIMIZE", "circuit": cj(big)})
        self.assertEqual(exc.status_code, 422)
        self.assertEqual(exc.detail["code"], "CIRCUIT_TOO_MANY_QUBITS")

    def test_a_rotation_pair_is_merged_and_an_inverse_pair_cancelled(self) -> None:
        circuit = circ(1, [GateOp(gate=GateName.RZ, targets=[0], params=[0.25]), GateOp(gate=GateName.RZ, targets=[0], params=[0.5]), g("s", 0), g("sdg", 0)])
        response = self.analyze({"intent": "OPTIMIZE", "circuit": cj(circuit)})
        self.assertEqual(response.status, "OK")
        self.assertEqual(response.data["candidate_op_count"], 1)
        self.assertEqual(response.data["candidate_circuit"]["ops"][0]["params"], [0.75])


def _counterfactual(circuit: Circuit, ops) -> Circuit:
    return Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=ops)


class TestWhatIf(ReasoningCase):
    def what_if(self, circuit: Circuit, modification: dict, **extra):
        return self.analyze({"intent": "WHAT_IF", "circuit": cj(circuit), "modification": modification, **extra})

    def test_removing_a_gate_builds_the_counterfactual_and_compares_two_runs(self) -> None:
        response = self.what_if(SUPERPOSITION, {"op": "remove_gate", "index": 0})
        expected = _counterfactual(SUPERPOSITION, [])
        self.assertEqual(response.data["counterfactual_circuit_hash"], circuit_hash(expected))
        self.assertEqual(response.data["original_circuit_hash"], circuit_hash(SUPERPOSITION))
        self.assertEqual({s.role for s in response.sources}, {"original", "counterfactual"})
        measurement = response.data["comparison"]["measurement"]
        self.assertTrue(measurement["comparable"])
        self.assertAlmostEqual(measurement["total_variation_distance"], 0.5, places=9)  # {0: 0.5, 1: 0.5} against {0: 1}
        self.assertEqual(response.data["comparison"]["circuit"]["equivalence_status"], "NOT_EQUIVALENT")
        self.assertAlmostEqual(response.data["comparison"]["state"]["fidelity"], 0.5, places=9)

    def test_each_run_is_a_recorded_statevector_run_of_its_own_circuit(self) -> None:
        response = self.what_if(SUPERPOSITION, {"op": "insert_gate", "index": 1, "gate": "z", "targets": [0]})
        by_role = {s.role: self.store.get(s.result_id) for s in response.sources}
        self.assertEqual(by_role["original"].circuit_hash, circuit_hash(SUPERPOSITION))
        self.assertEqual(by_role["counterfactual"].circuit_hash, response.data["counterfactual_circuit_hash"])
        for record in by_role.values():
            self.assertEqual(record.execution_mode, "statevector")

    def test_replacing_a_gate(self) -> None:
        response = self.what_if(SUPERPOSITION, {"op": "replace_gate", "index": 0, "gate": "x"})
        expected = _counterfactual(SUPERPOSITION, [g("x", 0)])
        self.assertEqual(response.data["counterfactual_circuit_hash"], circuit_hash(expected))
        self.assertIn("replace operation 0", response.data["description"])

    def test_replacing_a_rotation_by_another_rotation_keeps_the_angle(self) -> None:
        circuit = circ(1, [GateOp(gate=GateName.RX, targets=[0], params=[0.5])])
        response = self.what_if(circuit, {"op": "replace_gate", "index": 0, "gate": "ry"})
        self.assertEqual(response.data["counterfactual_circuit_hash"], circuit_hash(circ(1, [GateOp(gate=GateName.RY, targets=[0], params=[0.5])])))

    def test_changing_an_angle(self) -> None:
        circuit = circ(1, [GateOp(gate=GateName.RY, targets=[0], params=[math.pi / 2])])
        response = self.what_if(circuit, {"op": "set_angle", "index": 0, "angle": math.pi})
        self.assertEqual(response.data["counterfactual_circuit_hash"], circuit_hash(circ(1, [GateOp(gate=GateName.RY, targets=[0], params=[math.pi])])))
        rows = {r["outcome"]: r for r in response.data["comparison"]["measurement"]["rows"]}
        self.assertAlmostEqual(rows["1"]["b"], 1.0, places=9)  # RY(pi) |0> = |1>

    def test_inserting_a_gate_keeps_every_other_operation_in_order(self) -> None:
        response = self.what_if(BELL, {"op": "insert_gate", "index": 1, "gate": "z", "targets": [0]})
        expected = _counterfactual(BELL, [BELL.ops[0], g("z", 0), BELL.ops[1]])
        self.assertEqual(response.data["counterfactual_circuit_hash"], circuit_hash(expected))
        self.assertEqual(response.data["counterfactual_op_count"], 3)

    def test_a_change_that_does_not_change_the_operator_is_reported_equivalent(self) -> None:
        circuit = circ(1, [g("h", 0), g("z", 0), g("z", 0)])
        # H Z Z is H: removing both Z gates, one at a time, the first leaves H Z (not the same), the second then leaves H
        first = self.what_if(circuit, {"op": "remove_gate", "index": 2})
        self.assertEqual(first.data["comparison"]["circuit"]["equivalence_status"], "NOT_EQUIVALENT")
        # replacing the first Z by an S followed by... is not allowed; instead insert a gate pair's worth of identity by RZ(0)
        zero = circ(1, [g("h", 0), GateOp(gate=GateName.RZ, targets=[0], params=[0.5])])
        same = self.what_if(zero, {"op": "set_angle", "index": 1, "angle": 0.5 + 2 * math.pi})
        # RZ(theta) and RZ(theta + 2 pi) differ by a global phase of -1 only
        self.assertEqual(same.data["comparison"]["circuit"]["equivalence_status"], "EQUIVALENT")
        self.assertAlmostEqual(same.data["comparison"]["state"]["fidelity"], 1.0, places=9)

    def test_a_measured_circuit_is_compared_on_its_state_before_the_measurements(self) -> None:
        response = self.what_if(BELL_MEASURED, {"op": "remove_gate", "index": 1})
        original = next(s for s in response.sources if s.role == "original")
        record = self.store.get(original.result_id)
        stripped = Circuit(num_qubits=2, num_clbits=2, ops=list(BELL.ops))  # the terminal measurements are stripped for the state comparison
        self.assertEqual(record.circuit_hash, circuit_hash(stripped))
        self.assertIn("OPENQASM 3", response.data["counterfactual_qasm"])

    def test_the_facts_are_the_comparisons_numbers_and_say_what_changed(self) -> None:
        response = self.what_if(SUPERPOSITION, {"op": "remove_gate", "index": 0})
        text = " ".join(f.description for f in response.facts)
        self.assertIn("what-if change: remove operation 0", text)
        self.assertIn("total variation distance", text)
        self.assertIn("not equivalent", text)
        self.assertNotIn("not reported", text)  # an outcome absent from a run is probability zero there
        self.assertIn("0.500000", text)

    def test_the_preview_shows_the_counterfactual_before_anything_runs(self) -> None:
        before = self.row_count()
        preview = reasoning_api.what_if_preview_endpoint(
            reasoning_api.WhatIfPreviewRequest.model_validate({"circuit": cj(BELL), "modification": {"op": "remove_gate", "index": 1}})
        )
        self.assertEqual(self.row_count(), before)  # nothing ran, nothing was stored
        self.assertEqual(preview.original_circuit_hash, circuit_hash(BELL))
        self.assertEqual(preview.counterfactual_circuit_hash, circuit_hash(preview.counterfactual_circuit))
        self.assertEqual((preview.original_op_count, preview.counterfactual_op_count), (2, 1))
        self.assertEqual([c.kind for c in preview.changes], ["kept", "removed"])
        self.assertIn("OPENQASM 3", preview.counterfactual_qasm)
        # and the analysis the learner then confirms builds exactly the circuit that was previewed
        response = self.what_if(
            BELL,
            {"op": "remove_gate", "index": 1},
            expected_circuit_hash=preview.original_circuit_hash,
            counterfactual_circuit_hash=preview.counterfactual_circuit_hash,
        )
        self.assertEqual(response.data["counterfactual_circuit_hash"], preview.counterfactual_circuit_hash)

    def row_count(self) -> int:
        return self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001 - a test counting rows


class TestTraceChange(ReasoningCase):
    def test_a_step_reports_before_operation_after_and_probability_changes(self) -> None:
        trace = self.trace(BELL)
        response = self.analyze({"intent": "TRACE_CHANGE", "circuit": cj(BELL), "trace_step": self.step_ref(trace, 2)})
        data = response.data
        self.assertEqual(response.status, "OK")
        self.assertEqual(data["operation"]["gate"], "cx")
        self.assertEqual((data["step_number"], data["total_steps"]), (3, 3))
        moved = {row["outcome"]: row for row in data["probability_changes"]}
        self.assertEqual(set(moved), {"01", "11"})
        self.assertAlmostEqual(moved["01"]["before"], 0.5, places=9)
        self.assertAlmostEqual(moved["01"]["after"], 0.0, places=9)
        self.assertAlmostEqual(moved["11"]["difference"], 0.5, places=9)
        self.assertEqual(data["change_kind"], "probabilities_changed")

    def test_the_numbers_come_from_the_two_step_records(self) -> None:
        trace = self.trace(BELL)
        response = self.analyze({"intent": "TRACE_CHANGE", "circuit": cj(BELL), "trace_step": self.step_ref(trace, 2)})
        after = self.store.get(trace.steps[2].provenance.result_id).payload["theoretical_probabilities"]
        before = self.store.get(trace.steps[1].provenance.result_id).payload["theoretical_probabilities"]
        self.assertEqual(response.data["after_probabilities"], after)
        self.assertEqual(response.data["before_probabilities"], before)
        self.assertEqual({s.role for s in response.sources}, {"step", "previous_step"})

    def test_per_qubit_reduced_states_show_the_entanglement(self) -> None:
        trace = self.trace(BELL)
        response = self.analyze({"intent": "TRACE_CHANGE", "circuit": cj(BELL), "trace_step": self.step_ref(trace, 2)})
        before, after = response.data["before_qubits"], response.data["after_qubits"]
        self.assertTrue(all(q["status"] == "OK" for q in (*before, *after)))
        self.assertFalse(any(q["entangled_with_rest"] for q in before))
        self.assertTrue(all(q["entangled_with_rest"] for q in after))
        self.assertAlmostEqual(after[0]["purity"], 0.5, places=9)

    def test_a_phase_only_step_says_no_probability_changed(self) -> None:
        circuit = circ(1, [g("h", 0), g("z", 0)])
        trace = self.trace(circuit)
        response = self.analyze({"intent": "TRACE_CHANGE", "circuit": cj(circuit), "trace_step": self.step_ref(trace, 2)})
        self.assertEqual(response.data["change_kind"], "phase_only")
        self.assertEqual(response.data["probability_changes"], [])
        self.assertIn("no outcome probability changed", " ".join(f.description for f in response.facts))

    def test_the_initial_state_has_no_change_to_explain(self) -> None:
        trace = self.trace(BELL)
        response = self.analyze({"intent": "TRACE_CHANGE", "circuit": cj(BELL), "trace_step": self.step_ref(trace, 0)})
        self.assertEqual(response.status, "INITIAL_STATE")
        self.assertIn("no change to explain", response.reason)
        self.assertIsNone(response.data["operation"])

    def test_a_step_that_is_not_this_circuits_is_refused(self) -> None:
        trace = self.trace(BELL)
        ref = self.step_ref(trace, 2)
        exc = self.refused({"intent": "TRACE_CHANGE", "circuit": cj(SUPERPOSITION), "trace_step": ref})
        self.assertEqual(exc.status_code, 422)
        self.assertEqual(exc.detail["code"], "TUTOR_TRACE_STEP_MISMATCH")


class TestCompare(ReasoningCase):
    def test_comparison_reuses_the_experiment_comparison_and_names_both_runs(self) -> None:
        other = circ(2, [g("h", 0)])
        a, b = self.run_circuit(BELL), self.run_circuit(other)
        response = self.analyze(
            {"intent": "COMPARE", "circuit": cj(BELL), "circuit_b": cj(other), "result_id_a": a.result_id, "result_id_b": b.result_id}
        )
        self.assertEqual({s.role: s.result_id for s in response.sources}, {"run_a": a.result_id, "run_b": b.result_id})
        comparison = self.store.get(response.data["comparison_id"])
        self.assertEqual(comparison.backend, "experiment-comparison")
        self.assertEqual(response.data["measurement"], comparison.payload["measurement"])
        self.assertEqual(response.data["circuit"]["equivalence_status"], "NOT_EQUIVALENT")
        self.assertTrue(any("fidelity" in f.description for f in response.facts))
        self.assertTrue(all(f.id.startswith("R") for f in response.facts))

    def test_a_run_of_another_circuit_is_refused(self) -> None:
        a, b = self.run_circuit(BELL), self.run_circuit(SUPERPOSITION)
        exc = self.refused({"intent": "COMPARE", "circuit": cj(SUPERPOSITION), "circuit_b": cj(SUPERPOSITION), "result_id_a": a.result_id, "result_id_b": b.result_id})
        self.assertEqual(exc.status_code, 422)
        self.assertEqual(exc.detail["code"], "COMPARISON_CIRCUIT_MISMATCH")


class TestDebug(ReasoningCase):
    def test_the_debug_report_is_given_the_engines_evidence(self) -> None:
        circuit = circ(3, [g("h", 0), g("h", 0), g("cx", 1, control=0)])
        run = self.run_circuit(circuit)
        report = app_module.debug_endpoint(app_module.DebugRequest(circuit=circuit, result_id=run.result_id))
        texts = " ".join(e.text for e in report.engine_evidence)
        self.assertIn("shorter circuit", texts)
        self.assertIn("Qubit 2 is not used", texts)
        self.assertIn("no measurement", texts)
        self.assertTrue(report.analysis_id)
        self.assertTrue(all(e.fact_ids and e.fact_ids[0].startswith("R") for e in report.engine_evidence))
        self.assertTrue(any(f.id.startswith("R") for f in report.facts))
        analysis = self.store.get(report.analysis_id)
        self.assertEqual(analysis.payload["intent"], "DEBUG")

    def test_the_reports_other_sections_are_unchanged_by_the_evidence(self) -> None:
        run = self.run_circuit(BELL)
        report = app_module.debug_endpoint(app_module.DebugRequest(circuit=BELL, result_id=run.result_id))
        self.assertEqual({e.text.split(":")[0] for e in report.evidence}, {"Outcome 00", "Outcome 11"})

    def test_the_debug_intent_returns_the_report_and_its_analysis(self) -> None:
        run = self.run_circuit(REDUNDANT)
        response = self.analyze({"intent": "DEBUG", "circuit": cj(REDUNDANT), "result_id": run.result_id})
        self.assertEqual(response.intent, "DEBUG")
        self.assertIsNotNone(response.debug)
        self.assertEqual(response.debug.analysis_id, response.analysis_id)
        self.assertTrue(response.data["optimization"]["status"] == "OK")
        self.assertEqual(response.data["optimization"]["operations_removed"], 2)

    def test_evidence_is_best_effort(self) -> None:
        big = circ(11, [g("h", 0)])  # over the equivalence limit: the engine cannot analyse it, the debugger still answers
        run = self.run_circuit(big)
        report = app_module.debug_endpoint(app_module.DebugRequest(circuit=big, result_id=run.result_id))
        self.assertEqual(report.engine_evidence, [])
        self.assertIsNone(report.analysis_id)
        self.assertTrue(report.evidence)


if __name__ == "__main__":
    unittest.main()
