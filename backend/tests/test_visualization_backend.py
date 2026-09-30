"""What the server says a number IS, and what each step changed (1C).

* A statevector result carries THEORETICAL probabilities (|amplitude|² of the backend's own state); a shots result carries
  SAMPLED frequencies and the number of shots. The two are never called the same thing: not in the payload, not in the tutor's
  facts, and (frontend) not on screen.
* Each trace step carries what its operation changed relative to the step before it, computed by the server from the two
  backend statevectors — including the case a learner most needs to see: amplitudes that changed while every outcome
  probability stayed the same (a pure phase change).
"""

from __future__ import annotations

import math
import unittest

from qentor.api import app as app_module
from qentor.api.schemas import ExecuteRequest, TraceRequest, TutorRequest
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import ExecutionResult, theoretical_probabilities
from qentor.execution.step_changes import TOLERANCE, compute_step_change
from tests.test_api_tutor import TutorEndpointTestCase

S = math.sqrt(0.5)


def g(name, targets, controls=(), params=(), clbits=()):
    return GateOp(gate=name, targets=list(targets), controls=list(controls), params=list(params), clbits=list(clbits))


def circ(n, *ops, clbits=0):
    return Circuit(num_qubits=n, num_clbits=clbits, ops=list(ops))


BELL = circ(2, g("h", [0]), g("cx", [1], [0]))
BELL_MEASURED = circ(2, g("h", [0]), g("cx", [1], [0]), g("measure", [0], clbits=[0]), g("measure", [1], clbits=[1]), clbits=2)


class TestTheoreticalProbabilities(unittest.TestCase):
    def test_a_bell_state(self) -> None:
        p = theoretical_probabilities([[S, 0.0], [0.0, 0.0], [0.0, 0.0], [S, 0.0]])
        self.assertEqual(set(p), {"00", "11"})
        self.assertAlmostEqual(p["00"], 0.5, places=12)
        self.assertAlmostEqual(sum(p.values()), 1.0, places=12)

    def test_complex_amplitudes_use_the_squared_modulus(self) -> None:
        p = theoretical_probabilities([[S, 0.0], [0.0, S]])
        self.assertAlmostEqual(p["0"], 0.5, places=12)
        self.assertAlmostEqual(p["1"], 0.5, places=12)

    def test_keys_are_bitstrings_q_n_minus_1_to_q_0_at_full_width(self) -> None:
        state = [[0.0, 0.0]] * 8
        state[1] = [1.0, 0.0]  # index 1 = q0 set
        self.assertEqual(theoretical_probabilities(state), {"001": 1.0})
        state = [[0.0, 0.0]] * 8
        state[4] = [1.0, 0.0]  # index 4 = q2 set
        self.assertEqual(theoretical_probabilities(state), {"100": 1.0})

    def test_numerical_dust_is_left_out_and_real_outcomes_are_kept(self) -> None:
        p = theoretical_probabilities([[1.0, 0.0], [1e-7, 0.0]])  # 1e-14: dust
        self.assertEqual(set(p), {"0"})
        p = theoretical_probabilities([[math.sqrt(1 - 1e-8), 0.0], [1e-4, 0.0]])  # 1e-8: a real, tiny outcome
        self.assertEqual(set(p), {"0", "1"})

    def test_a_single_amplitude_state(self) -> None:
        self.assertEqual(theoretical_probabilities([[1.0, 0.0]]), {"0": 1.0})


class TestPayloadShape(unittest.TestCase):
    def test_a_statevector_payload_carries_theoretical_probabilities_and_no_shots(self) -> None:
        result = ExecutionResult(backend_name="b", backend_version="1", execution_mode="statevector", execution_id="e", statevector=[[S, 0.0], [S, 0.0]])
        payload = result.to_payload()
        self.assertEqual(set(payload), {"execution_id", "statevector", "theoretical_probabilities"})
        self.assertNotIn("probabilities", payload)  # that key means SAMPLED frequency, and there is no sample here

    def test_a_shots_payload_keeps_sampled_frequencies_and_reports_the_shots(self) -> None:
        result = ExecutionResult(
            backend_name="b", backend_version="1", execution_mode="shots", execution_id="e",
            counts={"00": 480, "11": 520}, probabilities={"00": 0.48, "11": 0.52},
        )
        payload = result.to_payload()
        self.assertEqual(set(payload), {"execution_id", "counts", "probabilities", "shots"})
        self.assertEqual(payload["shots"], 1000)
        self.assertNotIn("theoretical_probabilities", payload)


class TestOverTheApi(TutorEndpointTestCase):
    def test_execute_returns_theoretical_probabilities_for_every_backend_and_they_agree(self) -> None:
        results = {}
        for backend in ("qiskit-aer", "cirq", "pennylane"):
            response = app_module.execute(ExecuteRequest(circuit=BELL, mode="statevector", backend=backend))
            results[backend] = response.payload["theoretical_probabilities"]
            self.assertAlmostEqual(sum(results[backend].values()), 1.0, places=9, msg=backend)
        for backend, p in results.items():
            self.assertEqual(set(p), {"00", "11"}, backend)
            self.assertAlmostEqual(p["00"], 0.5, places=9, msg=backend)

    def test_the_probabilities_are_derived_from_the_statevector_that_is_returned(self) -> None:
        response = app_module.execute(ExecuteRequest(circuit=circ(2, g("h", [0]), g("ry", [1], params=[0.9])), mode="statevector"))
        expected = {format(i, "02b"): re * re + im * im for i, (re, im) in enumerate(response.payload["statevector"]) if re * re + im * im > 1e-12}
        self.assertEqual(response.payload["theoretical_probabilities"], expected)

    def test_shots_report_the_number_of_shots_and_the_frequencies_are_count_over_shots(self) -> None:
        response = app_module.execute(ExecuteRequest(circuit=BELL_MEASURED, mode="shots", shots=400))
        payload = response.payload
        self.assertEqual(payload["shots"], 400)
        self.assertEqual(sum(payload["counts"].values()), 400)
        for bits, count in payload["counts"].items():
            self.assertAlmostEqual(payload["probabilities"][bits], count / 400, places=12)
        self.assertNotIn("theoretical_probabilities", payload)

    def test_a_measured_circuits_statevector_run_is_collapsed_so_its_theoretical_distribution_is_one_outcome(self) -> None:
        """Pinned because the UI warns about it: the number is the collapsed state's, not the circuit's distribution."""
        response = app_module.execute(ExecuteRequest(circuit=BELL_MEASURED, mode="statevector"))
        self.assertEqual(len(response.payload["theoretical_probabilities"]), 1)
        self.assertAlmostEqual(list(response.payload["theoretical_probabilities"].values())[0], 1.0, places=9)


class TestWhatTheTutorIsToldItIs(TutorEndpointTestCase):
    def facts(self, circuit: Circuit, mode: str, shots: int | None = None):
        record = self._insert_record(circuit, mode, shots)
        return app_module.tutor_endpoint(TutorRequest(question="Explain my result", result_id=record.result_id, circuit=circuit)).facts

    def test_a_shots_result_is_a_sampled_frequency_never_a_probability(self) -> None:
        facts = [f for f in self.facts(BELL_MEASURED, "shots", 300) if f.kind == "probability"]
        self.assertTrue(facts)
        for fact in facts:
            self.assertIn("sampled frequency", fact.description)
            self.assertNotIn("probability", fact.description)
            self.assertRegex(fact.description, r"\(\d+ shots\)")

    def test_a_statevector_result_is_a_theoretical_probability(self) -> None:
        facts = self.facts(BELL, "statevector")
        theoretical = [f for f in facts if f.kind == "probability"]
        self.assertEqual([f.description for f in theoretical], ["outcome 00: theoretical probability 0.500000", "outcome 11: theoretical probability 0.500000"])
        self.assertTrue(any(f.kind == "amplitude" for f in facts))  # the amplitudes are still there

    def test_the_two_phrases_never_appear_in_the_wrong_mode(self) -> None:
        self.assertFalse(any("theoretical" in f.description for f in self.facts(BELL_MEASURED, "shots", 100)))
        self.assertFalse(any("sampled" in f.description for f in self.facts(BELL, "statevector")))


class TestStepChange(unittest.TestCase):
    ZERO = [[1.0, 0.0], [0.0, 0.0]]
    PLUS = [[S, 0.0], [S, 0.0]]
    MINUS = [[S, 0.0], [-S, 0.0]]

    def change(self, a, b, n=1):
        return compute_step_change(a, b, n)

    def test_h_on_zero_changes_the_probabilities(self) -> None:
        c = self.change(self.ZERO, self.PLUS)
        self.assertEqual((c.kind, c.support_before, c.support_after, c.probabilities_changed, c.amplitudes_changed), ("probabilities_changed", 1, 2, 2, 2))
        self.assertEqual([b.basis for b in c.changed_basis_states], ["0", "1"])
        self.assertIn("Outcome probabilities changed on 2 basis states", c.summary)
        self.assertIn("2 basis states now have non-zero amplitude (was 1)", c.summary)

    def test_z_on_plus_changes_only_a_phase(self) -> None:
        c = self.change(self.PLUS, self.MINUS)
        self.assertEqual((c.kind, c.probabilities_changed, c.amplitudes_changed, c.support_before, c.support_after), ("phase_only", 0, 1, 2, 2))
        self.assertEqual([b.basis for b in c.changed_basis_states], ["1"])
        moved = c.changed_basis_states[0]
        self.assertEqual((moved.probability_before, moved.probability_after), (moved.probability_before, moved.probability_before))  # equal
        self.assertLess(moved.after[0], 0)
        self.assertIn("Only phases changed: 1 basis state picked up a phase", c.summary)
        self.assertIn("every outcome probability stayed the same", c.summary)

    def test_a_gate_that_does_nothing_here_is_unchanged(self) -> None:
        c = self.change(self.ZERO, self.ZERO)  # Z on |0>
        self.assertEqual((c.kind, c.amplitudes_changed, c.changed_basis_states), ("unchanged", 0, []))
        self.assertEqual(c.summary, "This operation left the state unchanged.")

    def test_s_on_plus_is_phase_only_and_x_on_zero_moves_probability(self) -> None:
        s_on_plus = [[S, 0.0], [0.0, S]]
        self.assertEqual(self.change(self.PLUS, s_on_plus).kind, "phase_only")
        c = self.change(self.ZERO, [[0.0, 0.0], [1.0, 0.0]])
        self.assertEqual((c.kind, c.support_before, c.support_after), ("probabilities_changed", 1, 1))
        self.assertIn("1 basis state now has non-zero amplitude", c.summary)

    def test_two_qubit_labels_are_full_width_bitstrings(self) -> None:
        before = [[1.0, 0.0], [0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]
        after = [[S, 0.0], [0.0, 0.0], [0.0, 0.0], [S, 0.0]]
        c = compute_step_change(before, after, 2)
        self.assertEqual([b.basis for b in c.changed_basis_states], ["00", "11"])

    def test_differences_below_the_tolerance_are_not_changes(self) -> None:
        nudged = [[1.0, 0.0], [TOLERANCE / 10, 0.0]]
        self.assertEqual(self.change(self.ZERO, nudged).kind, "unchanged")
        nudged = [[1.0, 0.0], [TOLERANCE * 10, 0.0]]
        self.assertNotEqual(self.change(self.ZERO, nudged).kind, "unchanged")

    def test_states_of_different_sizes_are_refused_not_compared(self) -> None:
        with self.assertRaises(ValueError):
            compute_step_change(self.ZERO, [[1.0, 0.0]] * 4, 1)

    def test_the_summary_is_only_words_and_counts(self) -> None:
        for after in (self.PLUS, self.MINUS, self.ZERO):
            summary = self.change(self.PLUS, after).summary
            self.assertNotRegex(summary, r"\d+\.\d+")  # no amplitude or probability value in the sentence


class TestTraceStepsCarryTheChange(TutorEndpointTestCase):
    def test_every_step_after_the_first_says_what_it_changed_and_the_first_says_nothing(self) -> None:
        trace = app_module.execute_trace(TraceRequest(circuit=circ(1, g("h", [0]), g("z", [0]), g("h", [0]))))
        self.assertIsNone(trace.steps[0].change)
        self.assertEqual([s.change.kind for s in trace.steps[1:]], ["probabilities_changed", "phase_only", "probabilities_changed"])
        self.assertEqual([s.change.amplitudes_changed for s in trace.steps[1:]], [2, 1, 2])

    def test_the_change_is_exactly_the_difference_of_the_two_returned_states(self) -> None:
        trace = app_module.execute_trace(TraceRequest(circuit=circ(2, g("h", [0]), g("cx", [1], [0]), g("z", [1]))))
        for step, previous in zip(trace.steps[1:], trace.steps):
            expected = compute_step_change(previous.statevector, step.statevector, 2)
            self.assertEqual(step.change, expected)
            for moved in step.change.changed_basis_states:
                index = int(moved.basis, 2)
                self.assertEqual(moved.after, step.statevector[index])
                self.assertEqual(moved.before, previous.statevector[index])

    def test_a_bell_step_and_a_z_step_read_correctly(self) -> None:
        trace = app_module.execute_trace(TraceRequest(circuit=circ(2, g("h", [0]), g("cx", [1], [0]), g("z", [0]))))
        self.assertEqual([s.change.kind for s in trace.steps[1:]], ["probabilities_changed", "probabilities_changed", "phase_only"])

    def test_the_tutor_is_told_the_same_thing_and_says_it_in_each_language(self) -> None:
        circuit = circ(1, g("h", [0]), g("z", [0]))
        trace = app_module.execute_trace(TraceRequest(circuit=circuit))
        step = trace.steps[2]
        ref = {
            "step_index": 2, "operation_index": 1, "operation": step.operation.model_dump(mode="json"),
            "result_id": step.provenance.result_id, "execution_id": step.execution_id, "circuit_hash": step.provenance.circuit_hash,
            "backend": step.provenance.backend, "backend_version": step.provenance.backend_version,
            "previous_result_id": trace.steps[1].provenance.result_id,
        }
        for language, label in (("en", "What changed:"), ("hi", "क्या बदला:"), ("kn", "ಏನು ಬದಲಾಯಿತು:")):
            response = app_module.tutor_endpoint(TutorRequest(question="Why did the state change here?", circuit=circuit, trace_step=ref, language=language))
            fact = next(f for f in response.facts if f.kind == "trace_change")
            self.assertIn("Only phases changed: 1 basis state picked up a phase", fact.description)
            self.assertIn(label, response.answer)
            self.assertIn(fact.id, response.answer)
            self.assertIn("Only phases changed", response.answer)  # the sentence itself is quoted verbatim


if __name__ == "__main__":
    unittest.main()
