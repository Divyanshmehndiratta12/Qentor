"""The reasoning engine's trust boundary: what a client cannot supply, what is refused, what stays stale, what the tutor cannot invent.

Each test pins one way the engine could have been made to say something the backend did not compute.
"""

from __future__ import annotations

import ast
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from qentor.api import app as app_module
from qentor.api import reasoning as reasoning_api
from qentor.api.schemas import TutorRequest
from qentor.challenges.content import circ, g
from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import GateName, GateOp
from qentor.tutor.llm import LLMDraft

from tests.asgi_driver import http
from tests.reasoning_case import BELL, BELL_MEASURED, REDUNDANT, SUPERPOSITION, ReasoningCase, cj

BACKEND = Path(__file__).resolve().parents[1]


def post(path: str, body: dict) -> tuple[int, dict]:
    status, raw = http("POST", path, json.dumps(body).encode())
    return status, json.loads(raw)


class TestClientCannotSupplyResults(unittest.TestCase):
    """These are refused by request validation, before any handler runs: there is no field a result could travel in."""

    base = {"circuit": cj(BELL)}

    def refused(self, body: dict) -> dict:
        status, payload = post("/api/reasoning/analyze", body)
        self.assertEqual(status, 422, payload)
        return payload

    def test_probabilities_cannot_be_sent_with_a_probability_request(self) -> None:
        target = {"kind": "basis_state", "bits": "11"}
        for extra in ({"probabilities": {"11": 1.0}}, {"theoretical_probability": 1.0}, {"expected": 0.5}, {"counts": {"11": 1024}}, {"result": {"11": 1.0}}):
            with self.subTest(extra=list(extra)):
                self.refused({"intent": "PROBABILITY", **self.base, "result_id": "res_x", "target": target, **extra})
        # nor inside the target
        self.refused({"intent": "PROBABILITY", **self.base, "result_id": "res_x", "target": {**target, "probability": 1.0}})

    def test_an_expected_optimisation_cannot_be_sent(self) -> None:
        for extra in ({"candidate_circuit": cj(circ(2, [])), "expected_op_count": 0}, {"equivalent": True}, {"verified": True}, {"operations_removed": 2}):
            with self.subTest(extra=list(extra)):
                self.refused({"intent": "OPTIMIZE", **self.base, **extra})

    def test_a_counterfactual_result_cannot_be_sent(self) -> None:
        modification = {"op": "remove_gate", "index": 0}
        for extra in (
            {"counterfactual_circuit": cj(circ(2, []))},
            {"expected_result": {"00": 1.0}},
            {"comparison": {"measurement": {}}},
            {"counterfactual_probabilities": {"00": 1.0}},
        ):
            with self.subTest(extra=list(extra)):
                self.refused({"intent": "WHAT_IF", **self.base, "modification": modification, **extra})

    def test_a_comparison_cannot_be_overridden(self) -> None:
        for extra in ({"measurement": {"comparable": True}}, {"fidelity": 1.0}, {"same_circuit": True}, {"state": {}}):
            with self.subTest(extra=list(extra)):
                self.refused({"intent": "COMPARE", **self.base, "circuit_b": cj(BELL), "result_id_a": "a", "result_id_b": "b", **extra})

    def test_a_trace_step_carries_no_value(self) -> None:
        ref = {"step_index": 0, "result_id": "r", "execution_id": "e", "circuit_hash": "h" * 64, "backend": "b", "backend_version": "v"}
        for extra in ({"statevector": [[1, 0]]}, {"probabilities": {"0": 1.0}}, {"bloch": {"x": 0, "y": 0, "z": 1}}):
            with self.subTest(extra=list(extra)):
                self.refused({"intent": "TRACE_CHANGE", **self.base, "trace_step": {**ref, **extra}})

    def test_an_unknown_intent_is_refused(self) -> None:
        self.refused({"intent": "RUN_PYTHON", **self.base, "code": "print(1)"})
        self.refused({**self.base})

    def test_the_request_models_forbid_every_unknown_field(self) -> None:
        for model in (
            reasoning_api.ProbabilityRequest,
            reasoning_api.OptimizeRequest,
            reasoning_api.WhatIfRequest,
            reasoning_api.TraceChangeRequest,
            reasoning_api.CompareRequest,
            reasoning_api.DebugAnalysisRequest,
            reasoning_api.WhatIfPreviewRequest,
        ):
            with self.subTest(model=model.__name__):
                self.assertEqual(model.model_config.get("extra"), "forbid")

    def test_no_request_field_is_named_like_a_result(self) -> None:
        banned = ("probab", "amplitude", "statevector", "count", "expected", "verdict", "equivalent", "fidelity", "state", "result_value")
        for model in (reasoning_api.ProbabilityRequest, reasoning_api.OptimizeRequest, reasoning_api.WhatIfRequest, reasoning_api.TraceChangeRequest, reasoning_api.CompareRequest, reasoning_api.DebugAnalysisRequest):
            for name in model.model_fields:
                if name.endswith("_hash"):
                    continue  # a circuit hash the client was shown, compared with the server's own: a staleness token, never believed
                with self.subTest(model=model.__name__, field=name):
                    self.assertFalse(any(word in name for word in banned), f"{model.__name__}.{name}")


class TestProvenanceComesFromTheBackend(ReasoningCase):
    def test_a_result_that_does_not_exist_is_a_404(self) -> None:
        exc = self.refused({"intent": "PROBABILITY", "circuit": cj(BELL), "result_id": "res_nope", "target": {"kind": "most_likely"}})
        self.assertEqual((exc.status_code, exc.detail["code"]), (404, "REASONING_RESULT_NOT_FOUND"))

    def test_a_result_of_another_circuit_is_refused(self) -> None:
        run = self.run_circuit(SUPERPOSITION)
        exc = self.refused({"intent": "PROBABILITY", "circuit": cj(BELL), "result_id": run.result_id, "target": {"kind": "most_likely"}})
        self.assertEqual((exc.status_code, exc.detail["code"]), (422, "REASONING_RESULT_CIRCUIT_MISMATCH"))

    def test_an_analysis_record_is_not_a_run(self) -> None:
        run = self.run_circuit(BELL)
        analysis = self.probability(BELL, run.result_id, {"kind": "most_likely"})
        # the analysis record carries the same circuit hash; it holds no state, and must not be read as one
        exc = self.refused({"intent": "PROBABILITY", "circuit": cj(BELL), "result_id": analysis.analysis_id, "target": {"kind": "most_likely"}})
        self.assertEqual((exc.status_code, exc.detail["code"]), (422, "REASONING_RESULT_UNUSABLE"))

    def test_every_source_in_a_response_resolves_to_a_stored_record_with_the_same_identity(self) -> None:
        run = self.run_circuit(BELL_MEASURED, "shots", 300)
        responses = [
            self.probability(BELL_MEASURED, run.result_id, {"kind": "sampled_vs_theoretical"}),
            self.analyze({"intent": "OPTIMIZE", "circuit": cj(REDUNDANT)}),
            self.analyze({"intent": "WHAT_IF", "circuit": cj(BELL), "modification": {"op": "remove_gate", "index": 1}}),
        ]
        for response in responses:
            for source in response.sources:
                record = self.store.get(source.result_id)
                self.assertIsNotNone(record, source)
                self.assertEqual(
                    (source.circuit_hash, source.backend, source.backend_version, source.execution_mode, source.provenance_class, source.verification_status, source.execution_id),
                    (record.circuit_hash, record.backend, record.backend_version, record.execution_mode, record.provenance_class.value, record.verification_status.value, record.payload.get("execution_id")),
                )
            record = self.store.get(response.analysis_id)
            self.assertEqual(response.data, record.payload["data"])  # what was returned is what was stored

    def test_nothing_is_labelled_hardware(self) -> None:
        run = self.run_circuit(BELL)
        response = self.probability(BELL, run.result_id, {"kind": "most_likely"})
        self.assertEqual(response.provenance.provenance_class, "SIMULATION")
        self.assertTrue(all(s.provenance_class == "SIMULATION" for s in response.sources))

    def test_two_requests_make_two_analysis_records(self) -> None:
        run = self.run_circuit(BELL)
        first = self.probability(BELL, run.result_id, {"kind": "most_likely"})
        second = self.probability(BELL, run.result_id, {"kind": "most_likely"})
        self.assertNotEqual(first.analysis_id, second.analysis_id)


class TestInvalidModificationsAreRefused(ReasoningCase):
    def refuse(self, circuit, modification, code: str, status: int = 422) -> None:
        exc = self.refused({"intent": "WHAT_IF", "circuit": cj(circuit), "modification": modification})
        self.assertEqual((exc.status_code, self.code_of(exc)), (status, code), exc.detail)

    def test_an_operation_that_does_not_exist(self) -> None:
        self.refuse(BELL, {"op": "remove_gate", "index": 2}, "WHATIF_INDEX_OUT_OF_RANGE")
        self.refuse(BELL, {"op": "replace_gate", "index": 9, "gate": "x"}, "WHATIF_INDEX_OUT_OF_RANGE")
        self.refuse(BELL, {"op": "set_angle", "index": 5, "angle": 1.0}, "WHATIF_INDEX_OUT_OF_RANGE")
        self.refuse(BELL, {"op": "insert_gate", "index": 3, "gate": "x", "targets": [0]}, "WHATIF_INDEX_OUT_OF_RANGE")

    def test_a_replacement_of_the_wrong_kind(self) -> None:
        self.refuse(SUPERPOSITION, {"op": "replace_gate", "index": 0, "gate": "cx"}, "WHATIF_REPLACEMENT_INCOMPATIBLE")
        self.refuse(BELL, {"op": "replace_gate", "index": 1, "gate": "h"}, "WHATIF_REPLACEMENT_INCOMPATIBLE")
        swap = circ(2, [GateOp(gate=GateName.SWAP, targets=[0, 1])])
        self.refuse(swap, {"op": "replace_gate", "index": 0, "gate": "cx"}, "WHATIF_REPLACEMENT_UNSUPPORTED")
        measured = circ(1, [g("h", 0), GateOp(gate=GateName.MEASURE, targets=[0], clbits=[0])], num_clbits=1)
        self.refuse(measured, {"op": "replace_gate", "index": 1, "gate": "x"}, "WHATIF_REPLACEMENT_UNSUPPORTED")

    def test_angles_must_match_the_gate(self) -> None:
        self.refuse(SUPERPOSITION, {"op": "replace_gate", "index": 0, "gate": "rx"}, "WHATIF_ANGLE_REQUIRED")
        self.refuse(SUPERPOSITION, {"op": "replace_gate", "index": 0, "gate": "x", "angle": 1.0}, "WHATIF_ANGLE_NOT_ALLOWED")
        self.refuse(SUPERPOSITION, {"op": "insert_gate", "index": 0, "gate": "ry", "targets": [0]}, "WHATIF_ANGLE_REQUIRED")
        self.refuse(SUPERPOSITION, {"op": "insert_gate", "index": 0, "gate": "x", "targets": [0], "angle": 0.1}, "WHATIF_ANGLE_NOT_ALLOWED")

    def test_an_angle_can_only_be_set_on_a_gate_that_has_one(self) -> None:
        self.refuse(SUPERPOSITION, {"op": "set_angle", "index": 0, "angle": 1.0}, "WHATIF_NOT_A_ROTATION")

    def test_a_change_that_changes_nothing(self) -> None:
        self.refuse(SUPERPOSITION, {"op": "replace_gate", "index": 0, "gate": "h"}, "WHATIF_NO_CHANGE")
        rotation = circ(1, [GateOp(gate=GateName.RX, targets=[0], params=[0.5])])
        self.refuse(rotation, {"op": "set_angle", "index": 0, "angle": 0.5}, "WHATIF_NO_CHANGE")

    def test_a_gate_the_circuit_model_would_refuse(self) -> None:
        self.refuse(BELL, {"op": "insert_gate", "index": 0, "gate": "cx", "targets": [0], "controls": [0]}, "WHATIF_INVALID_GATE")
        self.refuse(BELL, {"op": "insert_gate", "index": 0, "gate": "cx", "targets": [1]}, "WHATIF_INVALID_GATE")  # no control
        self.refuse(BELL, {"op": "insert_gate", "index": 0, "gate": "x", "targets": [7]}, "WHATIF_INVALID_GATE")  # qubit outside the circuit
        self.refuse(BELL, {"op": "insert_gate", "index": 0, "gate": "h", "targets": [0, 1]}, "WHATIF_INVALID_GATE")

    def test_a_gate_after_a_measurement_is_refused(self) -> None:
        self.refuse(BELL_MEASURED, {"op": "insert_gate", "index": 4, "gate": "x", "targets": [0]}, "WHATIF_MID_CIRCUIT_MEASUREMENT")
        self.refuse(BELL_MEASURED, {"op": "insert_gate", "index": 3, "gate": "x", "targets": [0]}, "WHATIF_MID_CIRCUIT_MEASUREMENT")  # between the two measurements

    def test_a_circuit_that_already_measures_mid_circuit_is_refused(self) -> None:
        mid = circ(1, [GateOp(gate=GateName.MEASURE, targets=[0], clbits=[0]), g("h", 0)], num_clbits=1)
        self.refuse(mid, {"op": "remove_gate", "index": 1}, "WHATIF_MID_CIRCUIT_MEASUREMENT")

    def test_the_request_schema_refuses_what_is_not_a_modification(self) -> None:
        for modification in (
            {"op": "exec", "code": "__import__('os').system('id')"},
            {"op": "remove_gate", "index": -1},
            {"op": "remove_gate", "index": 10**9},
            {"op": "remove_gate", "index": 0, "python": "1+1"},
            {"op": "insert_gate", "index": 0, "gate": "measure", "targets": [0]},
            {"op": "insert_gate", "index": 0, "gate": "x", "targets": [0, 1, 2]},
            {"op": "insert_gate", "index": 0, "gate": "x", "targets": []},
            {"op": "set_angle", "index": 0, "angle": 1e9},
            {"op": "set_angle", "index": 0, "angle": "pi"},
            {"op": "replace_gate", "index": 0, "gate": "measure"},
            {"op": "replace_gate", "index": 0, "gate": "x; import os"},
        ):
            with self.subTest(modification=modification):
                status, payload = post("/api/reasoning/analyze", {"intent": "WHAT_IF", "circuit": cj(BELL), "modification": modification})
                self.assertEqual(status, 422, payload)

    def test_the_preview_refuses_the_same_things(self) -> None:
        status, payload = post("/api/reasoning/what-if/preview", {"circuit": cj(BELL), "modification": {"op": "remove_gate", "index": 9}})
        self.assertEqual((status, payload["detail"]["code"]), (422, "WHATIF_INDEX_OUT_OF_RANGE"))
        status, payload = post("/api/reasoning/what-if/preview", {"circuit": cj(BELL), "modification": {"op": "exec", "code": "1"}})
        self.assertEqual(status, 422)

    def test_a_refused_modification_runs_nothing(self) -> None:
        before = self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001
        self.refuse(BELL, {"op": "remove_gate", "index": 9}, "WHATIF_INDEX_OUT_OF_RANGE")
        self.assertEqual(self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0], before)  # noqa: SLF001


class TestResourceLimits(ReasoningCase):
    def refuse(self, circuit, modification, code: str) -> None:
        exc = self.refused({"intent": "WHAT_IF", "circuit": cj(circuit), "modification": modification})
        self.assertEqual((exc.status_code, self.code_of(exc)), (422, code), exc.detail)

    def test_an_insertion_that_would_make_the_circuit_too_long_is_refused(self) -> None:
        full = circ(1, [g("h", 0)] * 64)
        self.refuse(full, {"op": "insert_gate", "index": 0, "gate": "x", "targets": [0]}, "WHATIF_TOO_MANY_OPERATIONS")

    def test_a_circuit_at_the_limit_can_still_be_shortened(self) -> None:
        full = circ(1, [g("h", 0)] * 64)
        response = self.analyze({"intent": "WHAT_IF", "circuit": cj(full), "modification": {"op": "remove_gate", "index": 0}})
        self.assertEqual(response.data["counterfactual_op_count"], 63)

    def test_an_original_that_is_already_too_long_is_refused(self) -> None:
        self.refuse(circ(1, [g("h", 0)] * 65), {"op": "remove_gate", "index": 0}, "WHATIF_TOO_MANY_OPERATIONS")

    def test_too_many_qubits_is_refused_before_anything_runs(self) -> None:
        self.refuse(circ(9, [g("h", 0)]), {"op": "remove_gate", "index": 0}, "WHATIF_TOO_MANY_QUBITS")

    def test_a_what_if_makes_exactly_two_runs(self) -> None:
        before = self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001
        self.analyze({"intent": "WHAT_IF", "circuit": cj(BELL), "modification": {"op": "remove_gate", "index": 1}})
        runs = self.store._conn.execute("SELECT COUNT(*) FROM results WHERE execution_mode = 'statevector'").fetchone()[0]  # noqa: SLF001
        total = self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001
        self.assertEqual(runs, 2)
        self.assertEqual(total - before, 3)  # two runs and the analysis record

    def test_a_probability_question_on_a_statevector_run_makes_no_run_at_all(self) -> None:
        run = self.run_circuit(BELL)
        before = self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001
        self.probability(BELL, run.result_id, {"kind": "most_likely"})
        self.assertEqual(self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0] - before, 1)  # noqa: SLF001

    def test_the_backends_own_limits_still_apply(self) -> None:
        big = circ(17, [g("h", 0)])
        exc = self.refused({"intent": "OPTIMIZE", "circuit": cj(big)})
        self.assertEqual(exc.status_code, 422)


class TestStaleCircuits(ReasoningCase):
    def test_a_what_if_for_a_circuit_that_changed_since_the_preview_is_refused(self) -> None:
        preview = reasoning_api.what_if_preview_endpoint(
            reasoning_api.WhatIfPreviewRequest.model_validate({"circuit": cj(BELL), "modification": {"op": "remove_gate", "index": 1}})
        )
        changed = circ(2, [g("h", 0), g("cx", 1, control=0), g("z", 1)])
        exc = self.refused(
            {
                "intent": "WHAT_IF",
                "circuit": cj(changed),
                "modification": {"op": "remove_gate", "index": 1},
                "expected_circuit_hash": preview.original_circuit_hash,
                "counterfactual_circuit_hash": preview.counterfactual_circuit_hash,
            }
        )
        self.assertEqual((exc.status_code, self.code_of(exc)), (409, "REASONING_STALE_CIRCUIT"))

    def test_a_changed_original_is_caught_even_when_it_yields_the_same_counterfactual(self) -> None:
        # Removing operation 1 of BELL and of this circuit both leave "h on q0": only the ORIGINAL's hash tells them apart.
        shown = reasoning_api.what_if_preview_endpoint(
            reasoning_api.WhatIfPreviewRequest.model_validate({"circuit": cj(BELL), "modification": {"op": "remove_gate", "index": 1}})
        )
        changed = circ(2, [g("h", 0), g("x", 1)])
        self.assertEqual(
            circuit_hash(circ(2, [g("h", 0)])),
            shown.counterfactual_circuit_hash,
        )
        exc = self.refused(
            {
                "intent": "WHAT_IF",
                "circuit": cj(changed),
                "modification": {"op": "remove_gate", "index": 1},
                "expected_circuit_hash": shown.original_circuit_hash,
                "counterfactual_circuit_hash": shown.counterfactual_circuit_hash,
            }
        )
        self.assertEqual((exc.status_code, self.code_of(exc)), (409, "REASONING_STALE_CIRCUIT"))

    def test_a_counterfactual_hash_the_server_does_not_build_is_refused(self) -> None:
        exc = self.refused(
            {
                "intent": "WHAT_IF",
                "circuit": cj(BELL),
                "modification": {"op": "remove_gate", "index": 1},
                "counterfactual_circuit_hash": circuit_hash(circ(2, [g("x", 0)])),
            }
        )
        self.assertEqual((exc.status_code, self.code_of(exc)), (409, "REASONING_STALE_CIRCUIT"))

    def test_a_matching_hash_is_accepted_and_changes_nothing(self) -> None:
        response = self.analyze({"intent": "WHAT_IF", "circuit": cj(BELL), "modification": {"op": "remove_gate", "index": 1}, "expected_circuit_hash": circuit_hash(BELL)})
        self.assertEqual(response.status, "OK")

    def test_every_other_intent_detects_a_stale_circuit_too(self) -> None:
        run = self.run_circuit(BELL)
        stale = circuit_hash(SUPERPOSITION)
        trace = self.trace(BELL)
        bodies = [
            {"intent": "PROBABILITY", "circuit": cj(BELL), "result_id": run.result_id, "target": {"kind": "most_likely"}},
            {"intent": "OPTIMIZE", "circuit": cj(BELL)},
            {"intent": "TRACE_CHANGE", "circuit": cj(BELL), "trace_step": self.step_ref(trace, 1)},
            {"intent": "COMPARE", "circuit": cj(BELL), "circuit_b": cj(BELL), "result_id_a": run.result_id, "result_id_b": run.result_id},
            {"intent": "DEBUG", "circuit": cj(BELL), "result_id": run.result_id},
        ]
        for body in bodies:
            with self.subTest(intent=body["intent"]):
                exc = self.refused({**body, "expected_circuit_hash": stale})
                self.assertEqual((exc.status_code, self.code_of(exc)), (409, "REASONING_STALE_CIRCUIT"))

    def test_a_stale_request_runs_nothing(self) -> None:
        before = self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001
        self.refused({"intent": "OPTIMIZE", "circuit": cj(REDUNDANT), "expected_circuit_hash": circuit_hash(BELL)})
        self.assertEqual(self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0], before)  # noqa: SLF001


class FakeLLM:
    name = "fake"

    def __init__(self, draft: LLMDraft) -> None:
        self.draft = draft
        self.seen: list = []

    def generate(self, question, facts, language="en", lesson_facts=None, trace_facts=None):  # noqa: ANN001
        self.seen.append(list(facts))
        return self.draft


class TestTutorCannotInventFacts(ReasoningCase):
    def ask(self, circuit, run, question: str, llm: FakeLLM, language: str = "en"):
        with patch.object(app_module, "_llm_adapter", llm):
            return app_module.tutor_endpoint(TutorRequest(result_id=run.result_id, circuit=circuit, question=question, language=language))

    def test_an_invented_probability_never_reaches_the_answer(self) -> None:
        run = self.run_circuit(BELL)
        llm = FakeLLM(LLMDraft(answer="The probability of 11 is 0.75 (R4).", cited_fact_ids=["R4"]))
        response = self.ask(BELL, run, "What is the probability of 11?", llm)
        self.assertTrue(llm.seen, "the model was never consulted")
        self.assertTrue(response.used_fallback_template)
        self.assertNotIn("0.75", response.answer)
        self.assertIn("0.500000", response.answer)

    def test_a_probability_the_engine_did_compute_may_be_restated(self) -> None:
        run = self.run_circuit(BELL)
        llm = FakeLLM(LLMDraft(answer="The probability of 11 is 0.500000 (R4).", cited_fact_ids=["R4"]))
        response = self.ask(BELL, run, "What is the probability of 11?", llm)
        self.assertFalse(response.used_fallback_template)
        self.assertEqual(response.answer, "The probability of 11 is 0.500000 (R4).")

    def test_an_invented_equivalence_verdict_is_rejected(self) -> None:
        run = self.run_circuit(BELL)
        llm = FakeLLM(LLMDraft(answer="Your circuit is equivalent to a shorter one and verified optimal (R2).", cited_fact_ids=["R2"]))
        response = self.ask(BELL, run, "Can you optimize this circuit?", llm)
        self.assertTrue(response.used_fallback_template)
        self.assertNotIn("verified optimal", response.answer)
        self.assertIn("no safe improvement", response.answer)

    def test_a_citation_of_a_fact_that_does_not_exist_is_rejected(self) -> None:
        run = self.run_circuit(BELL)
        llm = FakeLLM(LLMDraft(answer="The probability of 11 is 0.500000 (R99).", cited_fact_ids=["R99"]))
        response = self.ask(BELL, run, "What is the probability of 11?", llm)
        self.assertTrue(response.used_fallback_template)

    def test_an_invented_candidate_circuit_size_is_rejected(self) -> None:
        run = self.run_circuit(REDUNDANT)
        llm = FakeLLM(LLMDraft(answer="Optimizing removes 5 operations, leaving 1 (R3).", cited_fact_ids=["R3"]))
        response = self.ask(REDUNDANT, run, "Please optimize this", llm)
        self.assertTrue(response.used_fallback_template)
        self.assertNotIn("removes 5", response.answer)
        self.assertIn("3 operations before, 1 after", response.answer)

    def test_the_model_is_given_only_engine_facts_never_a_client_number(self) -> None:
        run = self.run_circuit(BELL)
        llm = FakeLLM(LLMDraft(answer="x", cited_fact_ids=[]))
        self.ask(BELL, run, "What is the probability of 11?", llm)
        facts = llm.seen[0]
        self.assertTrue(facts and all(f.id.startswith("R") for f in facts))
        self.assertTrue(all(f.result_id for f in facts))

    def test_the_debug_prose_may_not_carry_an_invented_number_either(self) -> None:
        run = self.run_circuit(BELL)
        response = self.ask(BELL, run, "debug my circuit", FakeLLM(LLMDraft(answer="n/a", cited_fact_ids=[])))
        self.assertTrue(response.facts)
        self.assertTrue(response.used_fallback_template)


class TestImportGraph(unittest.TestCase):
    def imports(self, path: Path) -> set[str]:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        names: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                names.add(node.module)
        return names

    def test_the_engine_never_imports_the_tutor_the_log_writer_or_the_api(self) -> None:
        files = list((BACKEND / "qentor" / "reasoning").rglob("*.py"))
        self.assertTrue(files)
        for path in files:
            for name in self.imports(path):
                with self.subTest(file=path.name, imports=name):
                    self.assertFalse(name.startswith(("qentor.tutor", "qentor.api", "qentor.provenance.store", "qentor.provenance.attempts", "qentor.classroom")), f"{path.name} imports {name}")

    def test_the_tutor_modules_for_reasoning_never_reach_the_log_writer(self) -> None:
        for name in ("intents.py", "reasoning_facts.py"):
            imported = self.imports(BACKEND / "qentor" / "tutor" / name)
            self.assertNotIn("qentor.provenance.store", imported)
            self.assertNotIn("qentor.provenance.attempts", imported)

    def test_the_engine_does_not_execute_code(self) -> None:
        banned = {"exec", "eval", "compile", "__import__", "subprocess", "os.system"}
        for path in (BACKEND / "qentor" / "reasoning").rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and node.id in banned:
                    self.fail(f"{path.name} uses {node.id}")
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    modules = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
                    self.assertFalse({m.split(".")[0] for m in modules} & {"subprocess", "ctypes", "importlib"}, f"{path.name} imports {modules}")


class TestRoutes(unittest.TestCase):
    def test_the_routes_are_registered(self) -> None:
        pairs = {(method, route.path) for route in app_module.app.routes for method in getattr(route, "methods", ())}
        self.assertIn(("POST", "/api/reasoning/analyze"), pairs)
        self.assertIn(("POST", "/api/reasoning/what-if/preview"), pairs)


if __name__ == "__main__":
    unittest.main()
