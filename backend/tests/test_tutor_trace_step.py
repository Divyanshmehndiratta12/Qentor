"""Step-aware tutoring (docs/AI_BOUNDARY.md): POST /api/tutor with a selected
execution-trace step.

The invariant these tests protect: the browser sends a step's IDENTITY (indices,
the operation, ids and hashes) — never a value — and the server verifies that
identity against the circuit and the provenance records it holds itself, then
builds every fact from those records. Real traces are generated through the real
``/api/execute/trace`` endpoint into the test store (real Aer), so each step
record is exactly what production writes; the LLM is always a test double.
"""

from __future__ import annotations

import json
import re
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import TraceRequest, TutorRequest
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord
from qentor.provenance.models import VerificationStatus as ExecutionStatus
from qentor.tutor import answer_step_aware_question, build_trace_step_context, resolve_lesson_context
from qentor.tutor.facts import build_fact_sheet
from qentor.tutor.llm import _TRACE_PROMPT_ADDENDUM, AnthropicAdapter, LLMDraft, LLMUnavailable, _system_prompt
from qentor.tutor.step_answers import answer_step_question, step_intent
from qentor.tutor.trace_context import GATE_NOTES, TraceContextError, TraceStepRef
from tests.test_api_tutor import TutorEndpointTestCase

H = GateOp(gate="h", targets=[0])
Z = GateOp(gate="z", targets=[0])
X = GateOp(gate="x", targets=[0])
CX = GateOp(gate="cx", controls=[0], targets=[1])
M = GateOp(gate="measure", targets=[0], clbits=[0])

HZ = Circuit(num_qubits=1, num_clbits=0, ops=[H, Z])
HZH_M = Circuit(num_qubits=1, num_clbits=1, ops=[H, Z, H, M])
BELL = Circuit(num_qubits=2, num_clbits=0, ops=[H, CX])

CHANGE = "Why did the state change here?"
GATE = "What did this gate do?"
BLOCH = "Why did the Bloch vector move?"
PREVIOUS = "What changed from the previous step?"

HI_BEFORE = "इस चरण से पहले:"
KN_BEFORE = "ಈ ಹಂತದ ಮೊದಲು:"
DECIMAL = re.compile(r"-?\d+\.\d+")


def ask(**kwargs):
    return app_module.tutor_endpoint(TutorRequest(**kwargs))


class RecordingLLM:
    name = "recording"

    def __init__(self, draft: LLMDraft | None = None, *, raises: Exception | None = None) -> None:
        self._draft, self._raises, self.calls = draft, raises, []

    def generate(self, question, facts, language="en", lesson_facts=None, trace_facts=None):
        self.calls.append({"question": question, "facts": list(facts), "language": language,
                           "lesson_facts": lesson_facts, "trace_facts": trace_facts})
        if self._raises is not None:
            raise self._raises
        return self._draft


class TraceStepTestCase(TutorEndpointTestCase):
    """A patched temp store, a deterministic (no-LLM) tutor, and a helper that
    runs a REAL trace and hands back a step's identity."""

    def setUp(self) -> None:
        super().setUp()
        patcher = patch.object(app_module, "_llm_adapter", None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def trace(self, circuit: Circuit):
        return app_module.execute_trace(TraceRequest(circuit=circuit))

    def ref(self, trace, index: int, **overrides) -> dict:
        step = trace.steps[index]
        data = {
            "step_index": step.step_index,
            "operation_index": step.operation_index,
            "operation": step.operation.model_dump(mode="json") if step.operation else None,
            "result_id": step.provenance.result_id,
            "execution_id": step.execution_id,
            "circuit_hash": step.provenance.circuit_hash,
            "backend": step.provenance.backend,
            "backend_version": step.provenance.backend_version,
            "previous_result_id": trace.steps[index - 1].provenance.result_id if index > 0 else None,
        }
        data.update(overrides)
        return data

    def ask_step(self, circuit, trace, index, question=CHANGE, **kwargs):
        return ask(question=question, circuit=circuit, trace_step=self.ref(trace, index), **kwargs)


def amp(step, i) -> str:
    re_, im = step.statevector[i]
    return f"|{format(i, '0%db' % 1)}⟩ amplitude: {re_:.6f} + {im:.6f}i"


# --------------------------------------------------------------------------- #
# Request schema                                                              #
# --------------------------------------------------------------------------- #


class TestTraceStepSchema(unittest.TestCase):
    GOOD = {
        "step_index": 2, "operation_index": 1, "operation": Z.model_dump(mode="json"),
        "result_id": "res_b", "execution_id": "aer-1", "circuit_hash": "h", "backend": "qiskit-aer",
        "backend_version": "0.17.2", "previous_result_id": "res_a",
    }

    def test_a_valid_step_round_trips(self) -> None:
        ref = TraceStepRef.model_validate(self.GOOD)
        self.assertEqual((ref.step_index, ref.operation_index, ref.previous_result_id), (2, 1, "res_a"))

    def test_the_initial_state_has_no_operation_and_no_previous_step(self) -> None:
        ok = {**self.GOOD, "step_index": 0, "operation_index": None, "operation": None, "previous_result_id": None}
        TraceStepRef.model_validate(ok)
        for bad in ({"operation_index": 0}, {"operation": X.model_dump(mode="json")}, {"previous_result_id": "res_a"}):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                TraceStepRef.model_validate({**ok, **bad})

    def test_a_later_step_needs_its_operation_and_the_matching_operation_index(self) -> None:
        with self.assertRaises(ValidationError):
            TraceStepRef.model_validate({**self.GOOD, "operation": None})
        with self.assertRaises(ValidationError):
            TraceStepRef.model_validate({**self.GOOD, "operation_index": 5})

    def test_there_is_no_field_that_can_carry_a_quantum_value(self) -> None:
        for extra in ("statevector", "amplitudes", "probabilities", "bloch_vector", "bloch", "state", "counts", "verdict"):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                TraceStepRef.model_validate({**self.GOOD, extra: [[0.7, 0.0], [0.7, 0.0]]})
        self.assertEqual(
            set(TraceStepRef.model_fields),
            {"step_index", "operation_index", "operation", "result_id", "execution_id", "circuit_hash", "backend", "backend_version", "previous_result_id"},
        )

    def test_the_request_needs_the_circuit_a_step_was_traced_from(self) -> None:
        with self.assertRaises(ValidationError):
            TutorRequest(question="q", trace_step=self.GOOD)
        TutorRequest(question="q", circuit=HZ, trace_step=self.GOOD)  # result_id is optional with a step

    def test_a_step_alone_is_enough_context_but_nothing_alone_is_not(self) -> None:
        with self.assertRaises(ValidationError):
            TutorRequest(question="q")

    def test_without_a_step_the_result_and_circuit_still_travel_together(self) -> None:
        with self.assertRaises(ValidationError):
            TutorRequest(question="q", result_id="res_x", lesson_id="phase")
        with self.assertRaises(ValidationError):
            TutorRequest(question="q", circuit=HZ, lesson_id="phase")

    def test_extra_forbid_still_rejects_client_supplied_values_on_the_request(self) -> None:
        for extra in ("statevector", "bloch_vector", "amplitudes", "lesson_text"):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                TutorRequest.model_validate({"question": "q", "circuit": HZ.canonical_dict(), "trace_step": self.GOOD, extra: 1})


class TestStepRouter(unittest.TestCase):
    def test_the_three_step_intents(self) -> None:
        self.assertEqual(step_intent(CHANGE), "change")
        self.assertEqual(step_intent("What changed in this step?"), "change")
        self.assertEqual(step_intent(PREVIOUS), "change")
        self.assertEqual(step_intent(GATE), "gate")
        self.assertEqual(step_intent("What does this operation do?"), "gate")
        self.assertEqual(step_intent(BLOCH), "bloch")
        self.assertEqual(step_intent("Where is the Bloch sphere pointing now?"), "bloch")

    def test_bloch_beats_change_and_gate_beats_change(self) -> None:
        self.assertEqual(step_intent("Why did the Bloch vector change?"), "bloch")
        self.assertEqual(step_intent("What did this gate change?"), "gate")

    def test_questions_that_are_not_about_the_step_are_not_step_questions(self) -> None:
        for q in ("What was the result?", "What does this circuit do?", "What does each gate in this circuit do?",
                  "Explain my result", "Give me a hint", "Explain this concept", "Will this win me the lottery?"):
            with self.subTest(q=q):
                self.assertIsNone(step_intent(q))


# --------------------------------------------------------------------------- #
# Verified context, facts, provenance                                         #
# --------------------------------------------------------------------------- #


class TestVerifiedStepFacts(TraceStepTestCase):
    def test_the_step_facts_are_the_backends_records_for_exactly_that_step(self) -> None:
        circuit = HZ
        trace = self.trace(circuit)  # steps: initial, H, Z
        response = self.ask_step(circuit, trace, 2)

        s = [f for f in response.facts if f.id.startswith("S")]
        text = "\n".join(f.description for f in s)
        z_step, h_step = trace.steps[2], trace.steps[1]
        # identity
        self.assertIn("selected trace step 3 of 3: applies z(q0) (operation 2 of your circuit)", text)
        self.assertIn(z_step.provenance.result_id, text)
        self.assertIn(z_step.execution_id, text)
        self.assertIn(f"{z_step.provenance.backend} {z_step.provenance.backend_version}", text)
        # the state AFTER (this step's record) and BEFORE (the previous step's record), verbatim
        for i in (0, 1):
            re_, im = z_step.statevector[i]
            self.assertIn(f"after this step, |{i}⟩ amplitude: {re_:.6f} + {im:.6f}i", text)
            re_, im = h_step.statevector[i]
            self.assertIn(f"before this step, |{i}⟩ amplitude: {re_:.6f} + {im:.6f}i", text)
        # the interesting fact is really there: the backend's amplitude for |1> flipped sign
        self.assertLess(z_step.statevector[1][0], 0)
        self.assertGreater(h_step.statevector[1][0], 0)

    def test_the_bloch_facts_are_the_backends_own_function_of_the_steps_stored_state(self) -> None:
        trace = self.trace(HZ)
        response = self.ask_step(HZ, trace, 2)
        text = "\n".join(f.description for f in response.facts)
        for label, step in (("after", trace.steps[2]), ("before", trace.steps[1])):
            b = step.bloch_vector  # what /api/execute/trace itself reported for that step
            self.assertIn(f"{label} this step, Bloch vector (derived by the backend from this state): "
                          f"x = {b.x:.6f}, y = {b.y:.6f}, z = {b.z:.6f}", text)

    def test_a_multi_qubit_step_has_amplitudes_but_no_bloch_vector_and_says_why(self) -> None:
        trace = self.trace(BELL)  # initial, H, CX
        response = self.ask_step(BELL, trace, 2)
        kinds = {f.kind for f in response.facts if f.id.startswith("S")}
        text = "\n".join(f.description for f in response.facts)
        self.assertNotIn("trace_bloch", kinds)
        self.assertIn("no Bloch vector — the state has 2 qubits and a Bloch vector describes one qubit", text)
        self.assertIn("|00⟩ amplitude: 0.707107", text)
        self.assertIn("|11⟩ amplitude: 0.707107", text)
        self.assertTrue(all(b is None for b in [s.bloch_vector for s in trace.steps]))

    def test_the_initial_state_step(self) -> None:
        trace = self.trace(HZ)
        response = self.ask_step(HZ, trace, 0)
        text = "\n".join(f.description for f in response.facts if f.id.startswith("S"))
        self.assertIn("selected trace step 1 of 3: the initial state, before any operation", text)
        self.assertNotIn("before this step", text)
        self.assertNotIn("trace_gate_note", {f.kind for f in response.facts})
        self.assertIn("This is the initial state", response.answer)

    def test_a_terminal_measurement_is_not_a_step(self) -> None:
        trace = self.trace(HZ_H := HZH_M)
        self.assertEqual(len(trace.steps), 4)  # initial + h + z + h; the measure is stripped
        response = self.ask_step(HZH_M, trace, 3)
        self.assertIn("selected trace step 4 of 4", "\n".join(f.description for f in response.facts))
        with self.assertRaises(HTTPException) as ctx:  # "step 5" would be the measurement: it does not exist
            ask(question=CHANGE, circuit=HZH_M, trace_step={**self.ref(trace, 3), "step_index": 4, "operation_index": 3, "operation": M.model_dump(mode="json")})
        self.assertEqual(ctx.exception.detail["code"], "TUTOR_TRACE_STEP_MISMATCH")

    def test_the_gate_note_is_textbook_and_number_free(self) -> None:
        for gate, note in GATE_NOTES.items():
            self.assertFalse(DECIMAL.search(note), gate)
        trace = self.trace(HZ)
        gate_facts = [f for f in self.ask_step(HZ, trace, 2).facts if f.kind == "trace_gate_note"]
        self.assertEqual([f.description for f in gate_facts], [GATE_NOTES["z"]])

    def test_step_facts_are_s_prefixed_carry_the_steps_result_id_and_never_a_lesson_id(self) -> None:
        trace = self.trace(HZ)
        response = self.ask_step(HZ, trace, 2)
        s = [f for f in response.facts if f.id.startswith("S")]
        self.assertEqual([f.id for f in s], [f"S{i}" for i in range(1, len(s) + 1)])
        self.assertTrue(all(f.result_id == trace.steps[2].provenance.result_id for f in s))

    def test_provenance_of_a_step_only_answer_is_the_steps_own_record(self) -> None:
        trace = self.trace(HZ)
        response = self.ask_step(HZ, trace, 2)
        step = trace.steps[2]
        self.assertEqual(response.result_id, step.provenance.result_id)
        self.assertEqual(response.circuit_hash, step.provenance.circuit_hash)
        self.assertEqual((response.provenance_class, response.verification_status), ("SIMULATION", "VERIFIED"))
        self.assertEqual(
            response.trace_step.model_dump(),
            {"step_index": 2, "step_number": 3, "total_steps": 3, "operation_index": 1,
             "result_id": step.provenance.result_id, "circuit_hash": step.provenance.circuit_hash,
             "provenance_class": "SIMULATION", "verification_status": "VERIFIED"},
        )

    def test_with_a_lab_result_too_the_top_level_provenance_stays_the_results_and_the_step_is_separate(self) -> None:
        trace = self.trace(HZ)
        lab = self._insert_record(HZ, "statevector")
        response = ask(question=CHANGE, result_id=lab.result_id, circuit=HZ, trace_step=self.ref(trace, 2))
        self.assertEqual(response.result_id, lab.result_id)
        self.assertEqual(response.trace_step.result_id, trace.steps[2].provenance.result_id)
        kinds = {f.id[0] for f in response.facts}
        self.assertEqual(kinds, {"F", "S"})


class TestStepIdentityIsVerified(TraceStepTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.tr = self.trace(HZ)

    def _code(self, **ref_overrides) -> tuple[int, str]:
        with self.assertRaises(HTTPException) as ctx:
            ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2, **ref_overrides))
        return ctx.exception.status_code, ctx.exception.detail["code"]

    def test_unknown_step_result_id(self) -> None:
        self.assertEqual(self._code(result_id="res_does_not_exist"), (404, "TUTOR_TRACE_RESULT_NOT_FOUND"))

    def test_unknown_previous_result_id(self) -> None:
        self.assertEqual(self._code(previous_result_id="res_does_not_exist"), (404, "TUTOR_TRACE_RESULT_NOT_FOUND"))

    def test_a_result_id_from_a_different_step_of_the_same_trace(self) -> None:
        other = self.tr.steps[1]
        self.assertEqual(self._code(result_id=other.provenance.result_id), (422, "TUTOR_TRACE_STEP_MISMATCH"))

    def test_a_result_and_hash_that_agree_with_each_other_but_not_with_the_claimed_step(self) -> None:
        other = self.tr.steps[1]  # a real, consistent record — of step 1, claimed as step 2
        self.assertEqual(
            self._code(result_id=other.provenance.result_id, circuit_hash=other.provenance.circuit_hash,
                       execution_id=other.execution_id),
            (422, "TUTOR_TRACE_STEP_MISMATCH"),
        )

    def test_a_wrong_circuit_hash(self) -> None:
        self.assertEqual(self._code(circuit_hash="qc_" + "0" * 60), (422, "TUTOR_TRACE_STEP_MISMATCH"))

    def test_a_wrong_operation(self) -> None:
        self.assertEqual(self._code(operation=X.model_dump(mode="json")), (422, "TUTOR_TRACE_STEP_MISMATCH"))

    def test_a_wrong_execution_id_backend_or_version(self) -> None:
        for override in ({"execution_id": "aer-forged"}, {"backend": "cirq"}, {"backend_version": "9.9.9"}):
            with self.subTest(override=override):
                self.assertEqual(self._code(**override), (422, "TUTOR_TRACE_STEP_MISMATCH"))

    def test_a_step_index_past_the_end(self) -> None:
        self.assertEqual(self._code(step_index=3, operation_index=2), (422, "TUTOR_TRACE_STEP_MISMATCH"))

    def test_a_previous_step_that_is_not_the_one_before(self) -> None:
        self.assertEqual(self._code(previous_result_id=self.tr.steps[0].provenance.result_id), (422, "TUTOR_TRACE_STEP_MISMATCH"))

    def test_a_trace_of_a_different_circuit_does_not_fit_this_circuit(self) -> None:
        other = self.trace(BELL)
        with self.assertRaises(HTTPException) as ctx:
            ask(question=CHANGE, circuit=HZ, trace_step=self.ref(other, 1))
        self.assertEqual(ctx.exception.detail["code"], "TUTOR_TRACE_STEP_MISMATCH")

    def test_a_shots_run_is_not_a_trace_step(self) -> None:
        shots = self._insert_record(HZH_M, "shots", shots=200)
        with self.assertRaises(HTTPException) as ctx:
            ask(question=CHANGE, circuit=HZH_M, trace_step={
                "step_index": 0, "result_id": shots.result_id, "execution_id": shots.payload["execution_id"],
                "circuit_hash": shots.circuit_hash, "backend": shots.backend, "backend_version": shots.backend_version})
        self.assertEqual(ctx.exception.detail["code"], "TUTOR_TRACE_STEP_MISMATCH")

    def test_errors_are_structured_without_a_stack_trace(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2, circuit_hash="nope"))
        self.assertEqual(set(ctx.exception.detail), {"code", "message"})
        self.assertNotIn("Traceback", ctx.exception.detail["message"])

    def test_a_valid_lab_result_does_not_excuse_a_bad_step(self) -> None:
        lab = self._insert_record(HZ, "statevector")
        with self.assertRaises(HTTPException) as ctx:
            ask(question=CHANGE, result_id=lab.result_id, circuit=HZ, trace_step=self.ref(self.tr, 2, circuit_hash="nope"))
        self.assertEqual(ctx.exception.detail["code"], "TUTOR_TRACE_STEP_MISMATCH")

    def test_the_verification_itself_can_be_called_directly(self) -> None:
        record = self.store.get(self.tr.steps[2].provenance.result_id)
        previous = self.store.get(self.tr.steps[1].provenance.result_id)
        ctx = build_trace_step_context(TraceStepRef.model_validate(self.ref(self.tr, 2)), HZ, record, previous)
        self.assertTrue(ctx.usable)
        forged = TraceStepRef.model_validate(self.ref(self.tr, 2, circuit_hash="nope"))
        with self.assertRaises(TraceContextError):
            build_trace_step_context(forged, HZ, record, previous)


# --------------------------------------------------------------------------- #
# Deterministic answers                                                       #
# --------------------------------------------------------------------------- #


class TestDeterministicStepAnswers(TraceStepTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.tr = self.trace(HZ)

    def _facts(self, response) -> str:
        return " ".join(f.description for f in response.facts)

    def test_explain_change_quotes_before_and_after_and_the_bloch_vectors(self) -> None:
        r = self.ask_step(HZ, self.tr, 2, CHANGE)
        self.assertTrue(r.used_fallback_template)
        for label in ("Before this step:", "After this step:", "Bloch vector before this step:", "Bloch vector after this step:"):
            self.assertIn(label, r.answer)
        before, after = self.tr.steps[1].statevector[1], self.tr.steps[2].statevector[1]
        self.assertIn(f"|1⟩ amplitude: {before[0]:.6f} + {before[1]:.6f}i", r.answer)
        self.assertIn(f"|1⟩ amplitude: {after[0]:.6f} + {after[1]:.6f}i", r.answer)
        self.assertIn("applies z(q0)", r.answer)

    def test_no_number_in_any_step_answer_is_absent_from_the_step_facts(self) -> None:
        for question in (CHANGE, GATE, BLOCH, PREVIOUS):
            for index in (0, 1, 2):
                answer = self.ask_step(HZ, self.tr, index, question).answer
                facts = self._facts(self.ask_step(HZ, self.tr, index, question))
                for number in DECIMAL.findall(answer):
                    self.assertIn(number, facts, f"{question!r} step {index}: {number}")

    def test_the_answer_states_no_difference_or_other_derived_number(self) -> None:
        answer = self.ask_step(HZ, self.tr, 2, CHANGE).answer
        stored = {f"{v:.6f}" for step in self.tr.steps for amp_ in step.statevector for v in amp_}
        stored |= {f"{c:.6f}" for step in self.tr.steps if step.bloch_vector for c in (step.bloch_vector.x, step.bloch_vector.y, step.bloch_vector.z)}
        for number in DECIMAL.findall(answer):
            self.assertIn(number.lstrip("+"), stored)

    def test_explain_gate_gives_the_gate_note_the_operation_and_the_states(self) -> None:
        answer = self.ask_step(HZ, self.tr, 2, GATE).answer
        self.assertIn("What this gate does in general:", answer)
        self.assertIn(GATE_NOTES["z"], answer)
        self.assertIn("applies z(q0)", answer)
        self.assertIn("After this step:", answer)

    def test_explain_bloch_change_quotes_the_backends_vectors(self) -> None:
        r = self.ask_step(HZ, self.tr, 2, BLOCH)
        b0, b1 = self.tr.steps[1].bloch_vector, self.tr.steps[2].bloch_vector
        self.assertIn(f"x = {b0.x:.6f}, y = {b0.y:.6f}, z = {b0.z:.6f}", r.answer)
        self.assertIn(f"x = {b1.x:.6f}, y = {b1.y:.6f}, z = {b1.z:.6f}", r.answer)

    def test_a_bloch_question_about_a_two_qubit_step_is_honest_and_still_shows_the_state(self) -> None:
        tr = self.trace(BELL)
        answer = self.ask_step(BELL, tr, 2, BLOCH).answer
        self.assertIn("no Bloch vector", answer)
        self.assertIn("|11⟩ amplitude: 0.707107", answer)
        self.assertNotIn("x =", answer)

    def test_insufficient_facts_are_reported_not_filled_in(self) -> None:
        # a step record that exists and matches, but whose run did not succeed
        prefix = Circuit(num_qubits=1, num_clbits=0, ops=[H])
        bad = ProvenanceRecord.new(
            circuit_hash=circuit_hash(prefix), backend="qiskit-aer", backend_version="0.17.2", execution_mode="statevector",
            provenance_class=ProvenanceClass.SIMULATION, verification_status=ExecutionStatus.ERROR,
            payload={"execution_id": "aer-bad", "error": "boom"},
        )
        self.store.insert(bad)
        ref = {**self.ref(self.tr, 1), "result_id": bad.result_id, "execution_id": "aer-bad", "previous_result_id": self.tr.steps[0].provenance.result_id}
        answer = ask(question=CHANGE, circuit=HZ, trace_step=ref).answer
        self.assertIn("don't have enough verified backend facts", answer)
        # no quantum value at all (the only decimals are the backend's own VERSION, e.g. 0.17.2)
        self.assertFalse(re.search(r"\d+\.\d{6}", answer), answer)
        self.assertNotIn("amplitude:", answer)
        self.assertNotIn("Bloch vector", answer)

    def test_a_step_without_a_previous_record_says_there_is_nothing_to_compare(self) -> None:
        ref = self.ref(self.tr, 2, previous_result_id=None)
        answer = ask(question=CHANGE, circuit=HZ, trace_step=ref).answer
        self.assertIn("previous step's state was not available", answer)
        self.assertNotIn("Before this step:", answer)
        self.assertIn("After this step:", answer)

    def test_hindi_and_kannada_localise_only_the_wrapper(self) -> None:
        for language, marker in (("hi", HI_BEFORE), ("kn", KN_BEFORE)):
            r = self.ask_step(HZ, self.tr, 2, CHANGE, language=language)
            self.assertIn(marker, r.answer)
            self.assertNotIn("Before this step:", r.answer)
            # facts, ids, gate names, numbers: verbatim
            self.assertIn("applies z(q0)", r.answer)
            self.assertIn("(S1)", r.answer)
            after = self.tr.steps[2].statevector[1]
            self.assertIn(f"|1⟩ amplitude: {after[0]:.6f} + {after[1]:.6f}i", r.answer)

    def test_the_initial_state_in_hindi(self) -> None:
        self.assertIn("प्रारंभिक अवस्था", self.ask_step(HZ, self.tr, 0, CHANGE, language="hi").answer)

    def test_a_non_step_question_with_a_step_but_no_result_points_at_what_can_be_asked(self) -> None:
        answer = self.ask_step(HZ, self.tr, 2, "Will this win me the lottery?").answer
        self.assertIn("What changed in this step?", answer)

    def test_a_non_step_question_falls_back_to_the_existing_result_answer_unchanged(self) -> None:
        lab = self._insert_record(HZ, "statevector")
        with_step = ask(question="What was the result?", result_id=lab.result_id, circuit=HZ, trace_step=self.ref(self.tr, 2))
        without = ask(question="What was the result?", result_id=lab.result_id, circuit=HZ)
        self.assertEqual(with_step.answer, without.answer)
        self.assertEqual([f.description for f in with_step.facts if f.id.startswith("F")], [f.description for f in without.facts])

    def test_the_whole_circuit_question_is_not_hijacked_by_a_selected_step(self) -> None:
        lab = self._insert_record(HZ, "statevector")
        q = "What does each gate in this circuit do?"
        self.assertEqual(
            ask(question=q, result_id=lab.result_id, circuit=HZ, trace_step=self.ref(self.tr, 2)).answer,
            ask(question=q, result_id=lab.result_id, circuit=HZ).answer,
        )

    def test_a_failed_lab_result_is_not_explained_but_the_step_still_is(self) -> None:
        failed = self._insert_failed_record(HZ)
        step_answer = ask(question=CHANGE, result_id=failed.result_id, circuit=HZ, trace_step=self.ref(self.tr, 2)).answer
        self.assertIn("After this step:", step_answer)
        result_answer = ask(question="What was the result?", result_id=failed.result_id, circuit=HZ, trace_step=self.ref(self.tr, 2)).answer
        self.assertIn("did not succeed", result_answer)

    def test_lesson_context_and_a_step_coexist_a_step_question_wins_a_lesson_question_stays_a_lesson_question(self) -> None:
        step_answer = ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2), lesson_id="phase", section_id="s1")
        self.assertIn("After this step:", step_answer.answer)
        self.assertEqual((step_answer.lesson_id, step_answer.trace_step.step_number), ("phase", 3))
        lesson_answer = ask(question="Explain this concept", circuit=HZ, trace_step=self.ref(self.tr, 2), lesson_id="phase", section_id="s1")
        self.assertTrue(lesson_answer.answer.startswith("About this part of the lesson:"))
        self.assertEqual({f.id[0] for f in lesson_answer.facts}, {"S", "L"})

    def test_answers_are_deterministic(self) -> None:
        a = self.ask_step(HZ, self.tr, 2, CHANGE)
        b = self.ask_step(HZ, self.tr, 2, CHANGE)
        self.assertEqual((a.answer, [f.description for f in a.facts]), (b.answer, [f.description for f in b.facts]))


# --------------------------------------------------------------------------- #
# LLM path                                                                    #
# --------------------------------------------------------------------------- #


class TestStepAwareLLM(TraceStepTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.tr = self.trace(HZ)

    def _patch(self, llm) -> None:
        patcher = patch.object(app_module, "_llm_adapter", llm)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_llm_receives_trace_facts_separately_from_lesson_and_result_facts(self) -> None:
        lab = self._insert_record(HZ, "statevector")
        llm = RecordingLLM(LLMDraft(answer="Z flipped a sign (S1).", cited_fact_ids=["S1"]))
        self._patch(llm)

        response = ask(question=CHANGE, result_id=lab.result_id, circuit=HZ, trace_step=self.ref(self.tr, 2), lesson_id="phase", section_id="s1")

        self.assertFalse(response.used_fallback_template)
        (call,) = llm.calls
        self.assertTrue(all(f.id.startswith("S") for f in call["trace_facts"]))
        self.assertTrue(all(f.id.startswith("L") for f in call["lesson_facts"]))
        self.assertTrue(all(f.id.startswith("F") for f in call["facts"]))
        self.assertEqual(call["language"], "en")

    def test_a_step_only_request_passes_no_lesson_facts_and_no_result_facts(self) -> None:
        llm = RecordingLLM(LLMDraft(answer="ok (S1).", cited_fact_ids=["S1"]))
        self._patch(llm)
        ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2))
        (call,) = llm.calls
        self.assertIsNone(call["lesson_facts"])
        self.assertEqual(call["facts"], [])
        self.assertGreater(len(call["trace_facts"]), 3)

    def test_the_step_facts_the_llm_gets_are_exactly_the_verified_ones(self) -> None:
        llm = RecordingLLM(LLMDraft(answer="ok (S1).", cited_fact_ids=["S1"]))
        self._patch(llm)
        response = ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2))
        sent = [(f.id, f.description) for f in llm.calls[0]["trace_facts"]]
        self.assertEqual(sent, [(f.id, f.description) for f in response.facts if f.id.startswith("S")])

    def test_a_number_the_llm_invents_never_reaches_the_answer(self) -> None:
        llm = RecordingLLM(LLMDraft(answer="The |1⟩ amplitude became −0.123456 (S5).", cited_fact_ids=["S5"]))
        self._patch(llm)
        response = ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2))
        self.assertTrue(response.used_fallback_template)
        self.assertNotIn("0.123456", response.answer)
        self.assertIn("After this step:", response.answer)  # the deterministic step answer instead

    def test_a_derived_difference_is_an_invented_number_and_is_rejected(self) -> None:
        # the backend's before/after amplitudes are 0.707107; "1.414214" (their difference) is nowhere in the facts
        llm = RecordingLLM(LLMDraft(answer="The amplitude changed by 1.414214 (S1).", cited_fact_ids=["S1"]))
        self._patch(llm)
        response = ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2))
        self.assertTrue(response.used_fallback_template)
        self.assertNotIn("1.414214", response.answer)

    def test_quoting_a_step_fact_number_verbatim_is_accepted(self) -> None:
        after = self.tr.steps[2].statevector[1]
        quote = f"{after[0]:.6f}"
        llm = RecordingLLM(LLMDraft(answer=f"Z made the |1⟩ amplitude {quote} (S5).", cited_fact_ids=["S5"]))
        self._patch(llm)
        response = ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2))
        self.assertFalse(response.used_fallback_template)
        self.assertIn(quote, response.answer)

    def test_a_citation_to_a_fact_that_does_not_exist_is_rejected(self) -> None:
        self._patch(RecordingLLM(LLMDraft(answer="Trust me (S99).", cited_fact_ids=["S99"])))
        response = ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2))
        self.assertTrue(response.used_fallback_template)
        self.assertNotIn("Trust me", response.answer)

    def test_a_provider_failure_falls_back_to_the_deterministic_step_answer(self) -> None:
        self._patch(RecordingLLM(raises=LLMUnavailable("down")))
        response = ask(question=CHANGE, circuit=HZ, trace_step=self.ref(self.tr, 2))
        self.assertTrue(response.used_fallback_template)
        self.assertIn("Before this step:", response.answer)

    def test_an_unusable_step_is_never_sent_to_the_llm(self) -> None:
        prefix = Circuit(num_qubits=1, num_clbits=0, ops=[H])
        bad = ProvenanceRecord.new(
            circuit_hash=circuit_hash(prefix), backend="qiskit-aer", backend_version="0.17.2", execution_mode="statevector",
            provenance_class=ProvenanceClass.SIMULATION, verification_status=ExecutionStatus.ERROR, payload={"execution_id": "aer-bad"},
        )
        self.store.insert(bad)
        llm = RecordingLLM(LLMDraft(answer="should not be reached", cited_fact_ids=[]))
        self._patch(llm)
        response = ask(question=CHANGE, circuit=HZ, trace_step={**self.ref(self.tr, 1), "result_id": bad.result_id, "execution_id": "aer-bad"})
        self.assertEqual(llm.calls, [])
        self.assertNotEqual(response.answer, "should not be reached")

    def test_a_request_without_a_step_still_uses_the_original_call_shape(self) -> None:
        calls: list[tuple] = []

        class Legacy:  # an adapter written before trace_facts existed
            name = "legacy"

            def generate(self, question, facts, language="en"):
                calls.append((question, language))
                return LLMDraft(answer="Trust me (F999).", cited_fact_ids=["F999"])

        self._patch(Legacy())
        record = self._insert_record(HZ, "statevector")
        ask(question="What was the result?", result_id=record.result_id, circuit=HZ)
        self.assertEqual(len(calls), 1)


class TestAdapterRequestBody(unittest.TestCase):
    def _body(self, *args, **kwargs):
        captured: dict = {}

        def fake_urlopen(request, timeout=None):
            captured["body"] = json.loads(request.data.decode("utf-8"))
            response = MagicMock()
            response.read.return_value = json.dumps({"content": [{"text": json.dumps({"answer": "ok", "cited_fact_ids": []})}]}).encode()
            response.__enter__.return_value = response
            return response

        with patch("qentor.tutor.llm.urllib.request.urlopen", fake_urlopen):
            AnthropicAdapter(api_key="sk-fake").generate(*args, **kwargs)
        return captured["body"]

    def _facts(self):
        from qentor.tutor.models import TutorFact

        return (
            [TutorFact(id="S1", kind="trace_step", description="selected trace step 3 of 3: applies z(q0)"),
             TutorFact(id="S2", kind="trace_amplitude", description="after this step, |1⟩ amplitude: -0.707107 + 0.000000i")],
            [TutorFact(id="L1", kind="lesson_overview", description="lesson overview")],
            [TutorFact(id="F1", kind="circuit_summary", description="1-qubit circuit: h(q0), z(q0)")],
        )

    def test_the_prompt_has_all_five_blocks_in_order_and_the_language(self) -> None:
        trace, lesson, result = self._facts()
        body = self._body(CHANGE, result, "hi", lesson_facts=lesson, trace_facts=trace)
        content = body["messages"][0]["content"]
        order = [content.index(k) for k in ("LESSON CONTEXT:", "TRACE STEP CONTEXT:", "QUANTUM RESULT FACTS:", "USER QUESTION:", "LANGUAGE:")]
        self.assertEqual(order, sorted(order))
        self.assertIn("S2: after this step, |1⟩ amplitude: -0.707107 + 0.000000i", content)
        self.assertIn("LANGUAGE: Hindi", content)

    def test_a_step_without_a_lesson_or_result_says_no_result_is_attached(self) -> None:
        trace, _, _ = self._facts()
        content = self._body(CHANGE, [], "en", trace_facts=trace)["messages"][0]["content"]
        self.assertNotIn("LESSON CONTEXT", content)
        self.assertIn("TRACE STEP CONTEXT:", content)
        self.assertIn("no executed result is attached", content)

    def test_the_system_prompt_restates_the_trust_rules_for_step_context(self) -> None:
        trace, _, _ = self._facts()
        system = self._body(CHANGE, [], "en", trace_facts=trace)["system"]
        self.assertTrue(system.endswith(_TRACE_PROMPT_ADDENDUM))
        for phrase in ("TRACE STEP CONTEXT", "Quantum values come ONLY from these facts", "Do not calculate a new result",
                       "do not invent or estimate any amplitude, probability or Bloch coordinate", "If the facts are not enough"):
            self.assertIn(phrase, system)
        # ...on top of the original rules, which are never dropped
        self.assertIn("must never invent a probability", system)
        self.assertIn("Cite every fact", system)

    def test_without_a_step_nothing_changes(self) -> None:
        _, lesson, result = self._facts()
        self.assertNotIn("TRACE STEP", self._body(CHANGE, result, "en")["system"])
        self.assertNotIn("TRACE STEP", self._body(CHANGE, result, "en", lesson_facts=lesson)["messages"][0]["content"])
        self.assertEqual(_system_prompt("en"), self._body(CHANGE, result, "en")["system"])


class TestNothingIsCalculatedHere(unittest.TestCase):
    def test_the_step_modules_do_no_quantum_arithmetic(self) -> None:
        from pathlib import Path

        tutor = Path(__file__).resolve().parents[1] / "qentor" / "tutor"
        for name in ("step_answers.py", "trace_context.py"):
            source = (tutor / name).read_text(encoding="utf-8")
            code = re.sub(r'"""[\s\S]*?"""', "", source)
            for forbidden in ("math.sqrt", "cmath", "numpy", "np.", "abs(", "atan", "acos"):
                self.assertNotIn(forbidden, code, f"{name} uses {forbidden}")
            # the only exponentiation is the integer length check `2**num_qubits`
            self.assertEqual([m for m in re.findall(r"\w+\*\*\w+", code)], ["2**num_qubits"] if name == "trace_context.py" else [], name)
        # the only arithmetic on an amplitude is the support filter already used by facts.py
        self.assertEqual(len(re.findall(r"re \* re \+ im \* im", (tutor / "trace_context.py").read_text(encoding="utf-8"))), 1)

    def test_the_tutor_package_still_cannot_reach_the_provenance_writer(self) -> None:
        from pathlib import Path

        tutor = Path(__file__).resolve().parents[1] / "qentor" / "tutor"
        for path in tutor.glob("*.py"):
            self.assertNotIn("provenance.store", path.read_text(encoding="utf-8"), path.name)


if __name__ == "__main__":
    unittest.main()
