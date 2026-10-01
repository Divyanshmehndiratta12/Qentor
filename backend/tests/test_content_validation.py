"""The content validation layer (``qentor.content.validation``): the shipped lessons and challenges pass every check, and each
check FAILS, naming the exact culprit, when the content is broken.

Broken catalogs are built with ``model_copy`` / ``model_construct`` (which skip pydantic validation), because the point is that
the validator judges what the content SAYS and does not lean on the models having refused it earlier. The shipped content is
never edited: every variant is a copy.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import re
import unittest
from pathlib import Path
from typing import get_args
from unittest.mock import patch

from qentor.api import app as app_module
from qentor.challenges import CHALLENGES, CHALLENGE_BY_ID
from qentor.circuit.model import Circuit, GateName, GateOp
from qentor.content import ContentReport, Problem, validate_content
from qentor.content import validation as validation_module
from qentor.content.validation import (
    CAPABILITY_ROUTES,
    check_challenge_references,
    check_concept_checks,
    check_lab_capabilities,
    check_linked_circuits_execute,
    check_linked_circuits_static,
    check_prerequisites,
    check_registry,
    check_section_ids,
)
from qentor.execution.adapter import AdapterExecutionError, AdapterUnavailable, ExecutionResult
from qentor.execution.aer import AerAdapter
from qentor.execution.capabilities import SUPPORTED_GATES
from qentor.lessons import LESSONS, ConceptCheckSection, InteractiveLabSection
from qentor.lessons.models import LabCapability
from qentor.lessons.registry import LESSON_BY_ID

ROOT = Path(__file__).resolve().parents[2]
ROUTES = {(method, route.path) for route in app_module.app.routes for method in getattr(route, "methods", None) or ()}
DECIMAL_OR_PERCENT = re.compile(r"\d+\.\d+|\d+\s?%")


def aer_or_skip(test: unittest.TestCase) -> AerAdapter:
    adapter = AerAdapter()
    try:
        adapter.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
    except AdapterUnavailable as exc:
        test.skipTest(f"qiskit-aer unavailable: {exc}")
    return adapter


def replace_lesson(lessons, lesson_id, **update):
    return [l.model_copy(update=update) if l.id == lesson_id else l for l in lessons]


def replace_section(lessons, lesson_id, section_id, **update):
    def patched(lesson):
        return lesson.model_copy(update={"sections": [s.model_copy(update=update) if s.id == section_id else s for s in lesson.sections]})

    return [patched(l) if l.id == lesson_id else l for l in lessons]


def problem_text(report_or_list) -> str:
    problems = report_or_list.problems if isinstance(report_or_list, ContentReport) else report_or_list
    return "\n".join(str(p) for p in problems)


def unvalidated_circuit(num_qubits, ops) -> Circuit:
    return Circuit.model_construct(schema_="qentor.circuit/1", num_qubits=num_qubits, num_clbits=0, ops=ops)


def raw_op(gate, targets, controls=(), params=()):
    return GateOp.model_construct(gate=gate, targets=list(targets), controls=list(controls), params=list(params), clbits=[])


def without_entanglement() -> list:
    """The challenge catalog minus the entanglement lesson's challenge: a lesson with none, for the failure-path tests (every
    shipped lesson now has one)."""
    return [c for c in CHALLENGES if c.lesson_id != "entanglement"]


class TestTheShippedContentPassesEveryCheck(unittest.TestCase):
    def test_the_whole_catalog_validates_clean(self) -> None:
        aer_or_skip(self)
        report = validate_content(known_routes=ROUTES)
        self.assertTrue(report.ok, "\n" + str(report))
        self.assertEqual(report.skipped, [])

    def test_it_looked_at_everything_so_a_pass_is_not_vacuous(self) -> None:
        aer_or_skip(self)
        report = validate_content(known_routes=ROUTES)
        self.assertEqual(report.checked["lessons"], 13)
        self.assertEqual(report.checked["sections"], sum(len(l.sections) for l in LESSONS))
        self.assertEqual(report.checked["concept_checks"], 26)
        self.assertEqual(report.checked["labs"], 13)
        self.assertEqual(report.checked["linked_circuits"], 13)
        self.assertEqual(report.checked["circuits_executed"], 13)
        self.assertEqual(report.checked["challenges"], 15)

    def test_every_lesson_has_valid_prerequisites(self) -> None:
        self.assertEqual(check_prerequisites(list(LESSONS)), [])
        ids = {l.id for l in LESSONS}
        for lesson in LESSONS:
            self.assertTrue(set(lesson.prerequisite_lesson_ids) <= ids, lesson.id)
            self.assertNotIn(lesson.id, lesson.prerequisite_lesson_ids)
        self.assertTrue(any(l.prerequisite_lesson_ids for l in LESSONS))  # the graph is not empty

    def test_every_section_id_is_unique_within_its_lesson(self) -> None:
        self.assertEqual(check_section_ids(list(LESSONS)), [])
        for lesson in LESSONS:
            ids = [s.id for s in lesson.sections]
            self.assertEqual(len(ids), len(set(ids)), lesson.id)

    def test_every_concept_check_is_graded_and_has_an_explanation(self) -> None:
        self.assertEqual(check_concept_checks(list(LESSONS)), [])  # strict: no prompt-only checks allowed
        checks = [(l, s) for l in LESSONS for s in l.sections if isinstance(s, ConceptCheckSection)]
        self.assertEqual(len(checks), 26)
        for lesson, section in checks:
            self.assertTrue(section.explanation and section.explanation.strip(), (lesson.id, section.id))
            self.assertIn(section.correct_option_id, [o.id for o in section.options], (lesson.id, section.id))

    def test_every_linked_circuit_uses_only_supported_gates(self) -> None:
        self.assertEqual(check_linked_circuits_static(list(LESSONS)), [])
        for lesson in LESSONS:
            self.assertIsNotNone(lesson.linked_circuit, lesson.id)
            used = {op.gate for op in lesson.linked_circuit.ops}
            for backend, supported in SUPPORTED_GATES.items():
                self.assertTrue(used <= supported, (lesson.id, backend, used - supported))

    def test_every_linked_circuit_executes_on_aer(self) -> None:
        adapter = aer_or_skip(self)
        problems, skipped, ran = check_linked_circuits_execute(list(LESSONS), adapter)
        self.assertEqual((problems, skipped), ([], []), problem_text(problems))
        self.assertEqual(ran, 13)

    def test_every_lab_capability_exists_and_is_served(self) -> None:
        self.assertEqual(check_lab_capabilities(list(LESSONS), known_routes=ROUTES), [])
        declared = set(get_args(LabCapability))
        self.assertEqual(declared, set(CAPABILITY_ROUTES))
        for lesson in LESSONS:
            for section in lesson.sections:
                if isinstance(section, InteractiveLabSection):
                    self.assertIn(section.capability, declared, lesson.id)
                    self.assertIn(CAPABILITY_ROUTES[section.capability], ROUTES, (lesson.id, section.capability))

    def test_every_challenge_reference_is_valid_or_its_lesson_says_why_there_is_none(self) -> None:
        self.assertEqual(check_challenge_references(list(LESSONS), list(CHALLENGES)), [])
        ids = {l.id for l in LESSONS}
        referenced = {c.lesson_id for c in CHALLENGES}
        self.assertTrue(referenced <= ids)
        # Sprint 2 gave bloch-sphere and entanglement a challenge each: every lesson now has one, so none may still claim it has none.
        self.assertEqual({l.id for l in LESSONS if l.id not in referenced}, set())
        for lesson in LESSONS:
            self.assertIsNone(lesson.no_challenge_reason, f"{lesson.id} has a challenge, so it should not claim it has none")

    def test_the_reasons_are_plain_text_like_the_rest_of_the_lesson_prose(self) -> None:
        for lesson in LESSONS:
            if lesson.no_challenge_reason:
                self.assertFalse(DECIMAL_OR_PERCENT.search(lesson.no_challenge_reason), lesson.id)

    def test_the_registry_is_consistent(self) -> None:
        self.assertEqual(check_registry(list(LESSONS), list(CHALLENGES), lesson_index=LESSON_BY_ID, challenge_index=CHALLENGE_BY_ID), [])
        self.assertEqual([l.id for l in LESSONS], list(LESSON_BY_ID))
        self.assertEqual([c.id for c in CHALLENGES], list(CHALLENGE_BY_ID))

    def test_the_lab_capability_type_the_browser_knows_is_the_one_the_server_declares(self) -> None:
        source = (ROOT / "web" / "src" / "api" / "client.ts").read_text(encoding="utf-8")
        match = re.search(r"export type LabCapability\s*=\s*([^\n]+)", source)
        self.assertIsNotNone(match, "client.ts no longer declares LabCapability")
        self.assertEqual(set(re.findall(r"'([a-z_]+)'", match.group(1))), set(get_args(LabCapability)))

    def test_validating_does_not_change_the_content(self) -> None:
        aer_or_skip(self)
        before = ([l.model_dump() for l in LESSONS], [c.model_dump() for c in CHALLENGES])
        validate_content(known_routes=ROUTES)
        self.assertEqual(before, ([l.model_dump() for l in LESSONS], [c.model_dump() for c in CHALLENGES]))


class TestPrerequisitesFailMeaningfully(unittest.TestCase):
    def test_an_unknown_prerequisite_is_named(self) -> None:
        broken = replace_lesson(LESSONS, "phase", prerequisite_lesson_ids=["superposition", "quantum-annealing"])
        found = check_prerequisites(broken)
        self.assertEqual([p.code for p in found], ["PREREQUISITE_UNKNOWN"])
        self.assertIn("'phase'", str(found[0]))
        self.assertIn("quantum-annealing", str(found[0]))

    def test_a_lesson_that_requires_itself(self) -> None:
        found = check_prerequisites(replace_lesson(LESSONS, "phase", prerequisite_lesson_ids=["phase"]))
        self.assertEqual([p.code for p in found], ["PREREQUISITE_SELF"])
        self.assertEqual(found[0].lesson_id, "phase")

    def test_a_repeated_prerequisite(self) -> None:
        found = check_prerequisites(replace_lesson(LESSONS, "phase", prerequisite_lesson_ids=["superposition", "superposition"]))
        self.assertEqual([p.code for p in found], ["PREREQUISITE_DUPLICATE"])

    def test_a_cycle_is_reported_as_a_path_a_reader_can_follow(self) -> None:
        # superposition <- qubits-measurement; make qubits-measurement need phase, and phase needs superposition already
        broken = replace_lesson(LESSONS, "qubits-measurement", prerequisite_lesson_ids=["phase"])
        found = check_prerequisites(broken)
        cycles = [p for p in found if p.code == "PREREQUISITE_CYCLE"]
        self.assertEqual(len(cycles), 1)
        for lesson_id in ("qubits-measurement", "superposition", "phase"):
            self.assertIn(lesson_id, cycles[0].message)
        self.assertIn("->", cycles[0].message)

    def test_an_acyclic_catalog_has_no_cycle_even_with_shared_prerequisites(self) -> None:
        self.assertEqual([p for p in check_prerequisites(list(LESSONS)) if p.code == "PREREQUISITE_CYCLE"], [])


class TestSectionIdsFailMeaningfully(unittest.TestCase):
    def test_a_duplicate_section_id_is_named_with_its_lesson(self) -> None:
        lesson = LESSON_BY_ID["phase"]
        broken = replace_lesson(LESSONS, "phase", sections=[*lesson.sections, lesson.sections[0]])
        found = check_section_ids(broken)
        self.assertEqual([p.code for p in found], ["SECTION_ID_DUPLICATE"])
        self.assertEqual((found[0].lesson_id, found[0].section_id), ("phase", lesson.sections[0].id))

    def test_a_blank_section_id(self) -> None:
        broken = replace_section(LESSONS, "phase", "s1", id="  ")
        self.assertIn("SECTION_ID_BLANK", {p.code for p in check_section_ids(broken)})


class TestConceptChecksFailMeaningfully(unittest.TestCase):
    def test_a_missing_explanation_names_the_check(self) -> None:
        for blank in (None, "", "   "):
            with self.subTest(explanation=blank):
                found = check_concept_checks(replace_section(LESSONS, "phase", "s5", explanation=blank))
                self.assertEqual([p.code for p in found], ["CONCEPT_CHECK_NO_EXPLANATION"])
                self.assertEqual((found[0].lesson_id, found[0].section_id), ("phase", "s5"))

    def test_a_key_that_is_not_an_option(self) -> None:
        found = check_concept_checks(replace_section(LESSONS, "phase", "s5", correct_option_id="zzz"))
        self.assertEqual([p.code for p in found], ["CONCEPT_CHECK_KEY_NOT_AN_OPTION"])
        self.assertIn("zzz", found[0].message)

    def test_a_missing_key(self) -> None:
        found = check_concept_checks(replace_section(LESSONS, "phase", "s5", correct_option_id=None))
        self.assertEqual([p.code for p in found], ["CONCEPT_CHECK_KEY_NOT_AN_OPTION"])

    def test_too_few_duplicate_or_blank_options(self) -> None:
        section = next(s for s in LESSON_BY_ID["phase"].sections if s.id == "s5")
        one = replace_section(LESSONS, "phase", "s5", options=section.options[:1], correct_option_id=section.options[0].id)
        self.assertIn("CONCEPT_CHECK_TOO_FEW_OPTIONS", {p.code for p in check_concept_checks(one)})
        dup = replace_section(LESSONS, "phase", "s5", options=[section.options[0], section.options[0].model_copy(update={"text": "again"})])
        self.assertIn("CONCEPT_CHECK_OPTION_ID_DUPLICATE", {p.code for p in check_concept_checks(dup)})
        blank = replace_section(LESSONS, "phase", "s5", options=[section.options[0].model_copy(update={"text": " "}), *section.options[1:]])
        self.assertIn("CONCEPT_CHECK_OPTION_BLANK", {p.code for p in check_concept_checks(blank)})

    def test_a_prompt_only_check_is_refused_unless_the_policy_allows_it(self) -> None:
        prompt_only = replace_section(LESSONS, "phase", "s5", question=None, options=None, correct_option_id=None, explanation=None)
        found = check_concept_checks(prompt_only)
        self.assertEqual([p.code for p in found], ["CONCEPT_CHECK_NOT_GRADED"])
        self.assertEqual(check_concept_checks(prompt_only, allow_prompt_only=True), [])

    def test_the_aggregate_reports_it_too(self) -> None:
        report = validate_content(replace_section(LESSONS, "phase", "s5", explanation=""), list(CHALLENGES), execute=False)
        self.assertFalse(report.ok)
        self.assertIn("CONCEPT_CHECK_NO_EXPLANATION", report.codes())
        self.assertIn("lesson 'phase', section 's5'", problem_text(report))


class TestLinkedCircuitsFailMeaningfully(unittest.TestCase):
    def test_a_circuit_that_references_a_gate_the_model_does_not_have(self) -> None:
        broken = replace_lesson(LESSONS, "phase", linked_circuit=unvalidated_circuit(2, [raw_op("cy", [1], [0])]))
        found = check_linked_circuits_static(broken)
        self.assertEqual([p.code for p in found], ["LINKED_CIRCUIT_UNKNOWN_GATE"])
        self.assertEqual(found[0].lesson_id, "phase")
        self.assertIn("'cy'", found[0].message)
        self.assertIn("does not have", found[0].message)

    def test_a_circuit_with_an_operand_outside_the_register(self) -> None:
        broken = replace_lesson(LESSONS, "phase", linked_circuit=unvalidated_circuit(1, [raw_op(GateName.H, [3])]))
        found = check_linked_circuits_static(broken)
        self.assertEqual([p.code for p in found], ["LINKED_CIRCUIT_INVALID"])
        self.assertEqual(found[0].lesson_id, "phase")
        self.assertIn("not a valid canonical circuit", found[0].message)

    def test_a_circuit_with_the_wrong_arity(self) -> None:
        broken = replace_lesson(LESSONS, "phase", linked_circuit=unvalidated_circuit(2, [raw_op(GateName.CX, [1])]))  # cx with no control
        self.assertEqual([p.code for p in check_linked_circuits_static(broken)], ["LINKED_CIRCUIT_INVALID"])

    def test_a_gate_a_backend_cannot_run_is_named_with_the_backend(self) -> None:
        without_z = frozenset(g for g in GateName if g is not GateName.Z)
        with patch.dict(SUPPORTED_GATES, {"cirq": without_z}):
            found = check_linked_circuits_static(list(LESSONS))
        codes = {p.code for p in found}
        self.assertEqual(codes, {"LINKED_CIRCUIT_GATE_UNSUPPORTED"})
        self.assertEqual({p.lesson_id for p in found}, {l.id for l in LESSONS if any(op.gate is GateName.Z for op in l.linked_circuit.ops)})
        for p in found:
            self.assertIn("'cirq'", p.message)
            self.assertIn("z", p.message)

    def test_a_circuit_on_a_backend_missing_from_the_table_fails_every_gate(self) -> None:
        with patch.dict(SUPPORTED_GATES, {"aer-2": frozenset()}):
            found = check_linked_circuits_static(replace_lesson([LESSON_BY_ID["phase"]], "phase"))
        self.assertTrue(any("'aer-2'" in p.message for p in found))

    def test_the_aggregate_reports_a_broken_circuit_by_lesson(self) -> None:
        broken = replace_lesson(LESSONS, "bell-state", linked_circuit=unvalidated_circuit(2, [raw_op("teleport", [0, 1])]))
        report = validate_content(broken, list(CHALLENGES), execute=False)
        self.assertFalse(report.ok)
        self.assertIn("lesson 'bell-state'", problem_text(report))
        self.assertIn("'teleport'", problem_text(report))

    def test_a_circuit_the_backend_cannot_run_is_reported_with_the_backend_message(self) -> None:
        class Failing:
            name = "qiskit-aer"

            def run(self, circuit, mode, shots=None):
                raise AdapterExecutionError("simulated failure: bad circuit")

        problems, skipped, ran = check_linked_circuits_execute(list(LESSONS), Failing())
        self.assertEqual(ran, 0)
        self.assertEqual({p.code for p in problems}, {"LINKED_CIRCUIT_EXECUTION_FAILED"})
        self.assertEqual({p.lesson_id for p in problems}, {l.id for l in LESSONS})
        self.assertTrue(all("simulated failure: bad circuit" in p.message for p in problems))

    def test_a_backend_that_throws_something_unexpected_is_a_finding_not_a_crash(self) -> None:
        class Exploding:
            name = "qiskit-aer"

            def run(self, circuit, mode, shots=None):
                raise RuntimeError("boom")

        problems, _, _ = check_linked_circuits_execute([LESSON_BY_ID["phase"]], Exploding())
        self.assertEqual([p.code for p in problems], ["LINKED_CIRCUIT_EXECUTION_FAILED"])
        self.assertIn("RuntimeError", problems[0].message)

    def test_a_result_that_is_not_a_well_formed_state_is_reported(self) -> None:
        class Sloppy:
            name = "qiskit-aer"

            def run(self, circuit, mode, shots=None):
                n = 2**circuit.num_qubits
                return ExecutionResult(
                    backend_name="qiskit-aer", backend_version="x", execution_mode="statevector", execution_id="e",
                    statevector=[[0.9, 0.0]] * n if mode == "statevector" else None, counts={"0": 1} if mode == "shots" else None,
                )

        problems, _, ran = check_linked_circuits_execute([LESSON_BY_ID["phase"]], Sloppy())
        self.assertEqual(ran, 1)
        self.assertEqual([p.code for p in problems], ["LINKED_CIRCUIT_RESULT_INVALID"])
        self.assertIn("squared norm", problems[0].message)

    def test_an_unavailable_simulator_is_skipped_not_passed_and_not_failed(self) -> None:
        class Gone:
            name = "qiskit-aer"

            def run(self, circuit, mode, shots=None):
                raise AdapterUnavailable("no simulator here")

        report = validate_content(list(LESSONS), list(CHALLENGES), adapter=Gone(), known_routes=ROUTES)
        self.assertTrue(report.ok, str(report))
        self.assertEqual(len(report.skipped), 1)
        self.assertIn("no simulator here", report.skipped[0])
        self.assertEqual(report.checked["circuits_executed"], 0)

    def test_a_circuit_over_the_run_limits_is_reported(self) -> None:
        aer = aer_or_skip(self)
        broken = replace_lesson(LESSONS, "phase", linked_circuit=unvalidated_circuit(30, []))
        problems, _, _ = check_linked_circuits_execute(broken, aer)
        over = [p for p in problems if p.code == "LINKED_CIRCUIT_OVER_LIMIT"]
        self.assertEqual([p.lesson_id for p in over], ["phase"])
        self.assertIn("30-qubit", over[0].message)

    def test_a_circuit_with_a_measurement_in_the_middle_still_runs(self) -> None:
        aer = aer_or_skip(self)
        mid = Circuit(num_qubits=1, num_clbits=1, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="measure", targets=[0], clbits=[0]), GateOp(gate="x", targets=[0])])
        problems, skipped, ran = check_linked_circuits_execute(replace_lesson([LESSON_BY_ID["phase"]], "phase", linked_circuit=mid), aer)
        self.assertEqual((problems, skipped, ran), ([], [], 1))

    def test_a_lesson_linking_a_cp_circuit_passes_and_really_runs(self) -> None:
        aer = aer_or_skip(self)
        cp_circuit = Circuit(num_qubits=2, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="h", targets=[1]), GateOp(gate="cp", targets=[1], controls=[0], params=[0.5])])
        lessons = replace_lesson([LESSON_BY_ID["phase"]], "phase", linked_circuit=cp_circuit)
        self.assertEqual(check_linked_circuits_static(lessons), [])
        self.assertEqual(check_linked_circuits_execute(lessons, aer)[0], [])

    def test_a_lesson_with_no_linked_circuit_is_not_asked_to_run_one(self) -> None:
        aer = aer_or_skip(self)
        self.assertEqual(check_linked_circuits_execute([LESSON_BY_ID["phase"].model_copy(update={"linked_circuit": None})], aer), ([], [], 0))


class TestLabCapabilitiesFailMeaningfully(unittest.TestCase):
    def lab_id(self, lesson_id: str) -> str:
        return next(s.id for s in LESSON_BY_ID[lesson_id].sections if isinstance(s, InteractiveLabSection))

    def test_a_capability_the_platform_does_not_have(self) -> None:
        broken = replace_section(LESSONS, "phase", self.lab_id("phase"), capability="teleport")
        found = check_lab_capabilities(broken)
        self.assertEqual([p.code for p in found], ["LAB_CAPABILITY_UNKNOWN"])
        self.assertEqual(found[0].lesson_id, "phase")
        self.assertIn("'teleport'", found[0].message)
        for real in get_args(LabCapability):
            self.assertIn(real, found[0].message)

    def test_a_capability_whose_route_is_not_registered(self) -> None:
        routes = ROUTES - {("POST", "/api/verify/bell-state")}
        found = check_lab_capabilities(list(LESSONS), known_routes=routes)
        self.assertEqual([p.code for p in found], ["LAB_CAPABILITY_ENDPOINT_MISSING"])
        self.assertEqual(found[0].lesson_id, "bell-state")
        self.assertIn("/api/verify/bell-state", found[0].message)

    def test_a_lab_with_no_circuit_to_run(self) -> None:
        broken = replace_lesson(LESSONS, "phase", linked_circuit=None)
        found = check_lab_capabilities(broken)
        self.assertEqual([p.code for p in found], ["LAB_WITHOUT_CIRCUIT"])

    def test_a_declared_capability_with_no_route_entry_is_itself_a_problem(self) -> None:
        with patch.dict(validation_module.CAPABILITY_ROUTES, clear=False):
            del validation_module.CAPABILITY_ROUTES["optimize"]
            found = check_lab_capabilities(list(LESSONS))
        self.assertIn("LAB_CAPABILITY_NO_ROUTE", {p.code for p in found})
        self.assertIn("optimize", problem_text(found))

    def test_a_route_entry_for_a_capability_nobody_declared(self) -> None:
        with patch.dict(validation_module.CAPABILITY_ROUTES, {"quantum_magic": ("POST", "/api/magic")}):
            found = check_lab_capabilities(list(LESSONS))
        self.assertIn("LAB_CAPABILITY_NOT_DECLARED", {p.code for p in found})

    def test_the_route_table_matches_the_real_api(self) -> None:
        self.assertTrue(set(CAPABILITY_ROUTES.values()) <= ROUTES)


class TestChallengeReferencesFailMeaningfully(unittest.TestCase):
    def test_a_challenge_naming_a_lesson_that_does_not_exist(self) -> None:
        broken = [c.model_copy(update={"lesson_id": "no-such-lesson"}) if c.id == "create-bell" else c for c in CHALLENGES]
        found = check_challenge_references(list(LESSONS), broken)
        self.assertIn("CHALLENGE_LESSON_UNKNOWN", {p.code for p in found})
        text = problem_text(found)
        self.assertIn("'create-bell'", text)
        self.assertIn("'no-such-lesson'", text)
        # ...and the lesson that just lost its only challenge is now missing one
        self.assertIn("CHALLENGE_MISSING", {p.code for p in found})

    def test_a_lesson_with_no_challenge_and_no_explanation(self) -> None:
        found = check_challenge_references(replace_lesson(LESSONS, "entanglement", no_challenge_reason=None), without_entanglement())
        self.assertEqual([p.code for p in found], ["CHALLENGE_MISSING"])
        self.assertEqual(found[0].lesson_id, "entanglement")
        self.assertIn("no_challenge_reason", found[0].message)

    def test_a_blank_explanation_is_not_an_explanation(self) -> None:
        found = check_challenge_references(replace_lesson(LESSONS, "entanglement", no_challenge_reason="   "), without_entanglement())
        self.assertEqual([p.code for p in found], ["CHALLENGE_REASON_BLANK"])

    def test_a_lesson_without_a_challenge_is_fine_when_it_says_why(self) -> None:
        found = check_challenge_references(
            replace_lesson(LESSONS, "entanglement", no_challenge_reason="Its lab has no single circuit to build."), without_entanglement()
        )
        self.assertEqual(found, [])

    def test_an_explanation_that_contradicts_an_existing_challenge_is_stale(self) -> None:
        found = check_challenge_references(replace_lesson(LESSONS, "phase", no_challenge_reason="Nothing to build here."), list(CHALLENGES))
        self.assertEqual([p.code for p in found], ["CHALLENGE_REASON_STALE"])
        self.assertEqual(found[0].lesson_id, "phase")
        self.assertIn("create-minus", found[0].message)
        self.assertIn("phase-change", found[0].message)

    def test_a_challenge_circuit_with_a_gate_no_backend_can_run(self) -> None:
        without_s = frozenset(g for g in GateName if g is not GateName.S)
        with patch.dict(SUPPORTED_GATES, {"pennylane": without_s}):
            found = check_challenge_references(list(LESSONS), list(CHALLENGES))
        unsupported = [p for p in found if p.code == "CHALLENGE_GATE_UNSUPPORTED"]
        for p in unsupported:
            self.assertIn("'pennylane'", p.message)
            self.assertIn("s", p.message)

    def test_a_challenge_circuit_with_an_unknown_gate(self) -> None:
        challenge = next(c for c in CHALLENGES if c.id == "create-bell")
        bad_ref = unvalidated_circuit(2, [raw_op("cy", [1], [0])])
        found = check_challenge_references(list(LESSONS), [challenge.model_copy(update={"reference_solution": bad_ref})])
        self.assertIn("CHALLENGE_UNKNOWN_GATE", {p.code for p in found})
        self.assertIn("reference solution", problem_text(found))


class TestRegistryConsistencyFailsMeaningfully(unittest.TestCase):
    def test_a_duplicate_lesson_id(self) -> None:
        found = check_registry([*LESSONS, LESSON_BY_ID["phase"]], list(CHALLENGES))
        self.assertEqual([p.code for p in found], ["LESSON_ID_DUPLICATE"])
        self.assertIn("'phase'", found[0].message)

    def test_a_duplicate_challenge_id(self) -> None:
        found = check_registry(list(LESSONS), [*CHALLENGES, CHALLENGES[0]])
        self.assertEqual([p.code for p in found], ["CHALLENGE_ID_DUPLICATE"])

    def test_a_lookup_table_that_disagrees_with_the_catalog(self) -> None:
        stale = dict(LESSON_BY_ID)
        del stale["phase"]
        found = check_registry(list(LESSONS), list(CHALLENGES), lesson_index=stale)
        self.assertEqual([p.code for p in found], ["REGISTRY_LESSON_INDEX_MISMATCH"])
        self.assertIn("phase", found[0].message)

    def test_a_lookup_table_holding_another_object(self) -> None:
        swapped = {**LESSON_BY_ID, "phase": LESSON_BY_ID["phase"].model_copy()}
        found = check_registry(list(LESSONS), list(CHALLENGES), lesson_index=swapped)
        self.assertEqual([p.code for p in found], ["REGISTRY_LESSON_INDEX_STALE"])

    def test_a_challenge_lookup_table_that_disagrees(self) -> None:
        found = check_registry(list(LESSONS), list(CHALLENGES), challenge_index={"only-one": CHALLENGES[0]})
        self.assertEqual([p.code for p in found], ["REGISTRY_CHALLENGE_INDEX_MISMATCH"])


class TestTheReportAndTheCommand(unittest.TestCase):
    def test_a_problem_reads_as_a_sentence_with_its_location(self) -> None:
        self.assertEqual(str(Problem("X", "went wrong", "phase", "s5")), "[X] lesson 'phase', section 's5': went wrong")
        self.assertEqual(str(Problem("X", "went wrong", "phase")), "[X] lesson 'phase': went wrong")
        self.assertEqual(str(Problem("X", "went wrong")), "[X] went wrong")

    def test_a_clean_report_says_so_and_a_dirty_one_lists_each_problem(self) -> None:
        clean = validate_content(execute=False)
        self.assertIn("no problems found", str(clean))
        self.assertIn("not requested", str(clean))
        dirty = validate_content(replace_lesson(LESSONS, "phase", prerequisite_lesson_ids=["x"]), list(CHALLENGES), execute=False)
        self.assertIn("PREREQUISITE_UNKNOWN", str(dirty))
        self.assertFalse(dirty.ok)

    def test_several_problems_are_all_reported_not_just_the_first(self) -> None:
        broken = replace_lesson(LESSONS, "phase", prerequisite_lesson_ids=["x"])
        broken = replace_section(broken, "bell-state", "s5", explanation="")
        broken = replace_lesson(broken, "entanglement", no_challenge_reason=None)
        report = validate_content(broken, without_entanglement(), execute=False)
        self.assertTrue({"PREREQUISITE_UNKNOWN", "CONCEPT_CHECK_NO_EXPLANATION", "CHALLENGE_MISSING"} <= report.codes())

    def test_the_command_exits_zero_on_the_shipped_content_and_one_on_broken_content(self) -> None:
        aer_or_skip(self)
        spec = importlib.util.spec_from_file_location("validate_content_script", ROOT / "backend" / "scripts" / "validate_content.py")
        script = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(script)
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            self.assertEqual(script.main(["validate_content.py"]), 0)
        self.assertIn("no problems found", printed.getvalue())
        self.assertTrue(set(CAPABILITY_ROUTES.values()) <= script.registered_routes())

        broken = replace_lesson(LESSONS, "phase", prerequisite_lesson_ids=["x"])
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed), patch.object(
            script, "validate_content", lambda **kw: validate_content(broken, list(CHALLENGES), execute=False)
        ):
            self.assertEqual(script.main(["validate_content.py", "--no-run"]), 1)
        self.assertIn("PREREQUISITE_UNKNOWN", printed.getvalue())


if __name__ == "__main__":
    unittest.main()
