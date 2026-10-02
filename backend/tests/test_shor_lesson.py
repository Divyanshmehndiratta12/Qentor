"""Lesson 18 (Shor's algorithm, order-finding intuition, ONE fixed instance): structure, prose trust, every statement the text makes checked on
the real backends (test-only), the server-graded checks, the tutor in three languages and the validated "no challenge" reason."""

from __future__ import annotations

import json
import math
import re
import unittest
from fractions import Fraction

from qentor.api import app as app_module
from qentor.challenges import CHALLENGES
from qentor.circuit.model import Circuit, GateOp
from qentor.content.validation import validate_content
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.cirq_adapter import CirqAdapter
from qentor.execution.limits import check_run_limits
from qentor.execution.pennylane_adapter import PennyLaneAdapter
from qentor.execution.trace import split_terminal_measurements, trace_circuit
from qentor.lessons import (
    LESSONS,
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    ReflectionSection,
    get_lesson,
    public_lesson,
)
from qentor.lessons.content_shor import (
    SHOR_CONTROLLED_POWERS,
    SHOR_CONTROLLED_TIMES_2,
    SHOR_CONTROLLED_TIMES_4,
    SHOR_LESSON_ID,
    SHOR_PREPARE,
)
from qentor.lessons.grading import grade_concept_check
from qentor.tutor import answer_lesson_aware_question, resolve_lesson_context
from qentor.verification.agreement import compare_all, compare_states
from qentor.verification.multi_input_harness import (
    OverallStatus,
    TestCaseSpec,
    project_distribution,
    run_multi_input_test,
)
from tests.test_tutor_lesson import DECIMAL, EXPLAIN, HI_EXPLAIN, HINT, KN_EXPLAIN, SIMPLER

ID = SHOR_LESSON_ID
LESSON = get_lesson(ID)
AER = AerAdapter()
N, BASE = 15, 2
SHAPE = ["explanation"] * 4 + ["concept_check", "interactive_lab", "concept_check"] + ["explanation"] * 2 + ["reflection"]
DECIMAL_OR_PERCENT = re.compile(r"\d+\.\d+|\d+\s?%")
QUARTER = 0.25


def all_text(lesson) -> list[str]:
    parts = [lesson.title, lesson.short_description, *lesson.learning_objectives, lesson.no_challenge_reason or ""]
    for s in lesson.sections:
        parts.append(s.title)
        if isinstance(s, ExplanationSection):
            parts.append(s.body)
        elif isinstance(s, (ReflectionSection, ConceptCheckSection)):
            parts.append(s.prompt)
        elif isinstance(s, InteractiveLabSection):
            parts.append(s.instructions)
        if isinstance(s, ConceptCheckSection) and s.question is not None:
            parts += [s.question, s.explanation, *[o.text for o in s.options]]
    return parts


def section(section_id: str):
    return next(s for s in LESSON.sections if s.id == section_id)


def without_measurement(circuit: Circuit) -> Circuit:
    return Circuit(num_qubits=circuit.num_qubits, num_clbits=circuit.num_clbits, ops=[o for o in circuit.ops if o.gate.value != "measure"])


def aer_or_skip(case: unittest.TestCase) -> None:
    try:
        AER.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
    except AdapterUnavailable as exc:
        case.skipTest(str(exc))


class TestStructure(unittest.TestCase):
    def test_it_is_lesson_eighteen_after_the_variational_lesson(self) -> None:
        self.assertEqual(len(LESSONS), 18)
        self.assertEqual(LESSONS[17].id, ID)
        self.assertEqual(LESSONS[16].id, "variational-vqe")

    def test_its_prerequisite_is_phase_estimation_and_it_exists(self) -> None:
        self.assertEqual(LESSON.prerequisite_lesson_ids, ["quantum-phase-estimation"])
        self.assertIsNotNone(get_lesson("quantum-phase-estimation"))

    def test_ten_sections_in_the_agreed_shape_with_unique_ids(self) -> None:
        self.assertEqual([s.type for s in LESSON.sections], SHAPE)
        self.assertEqual([s.id for s in LESSON.sections], [f"s{i}" for i in range(1, 11)])

    def test_metadata(self) -> None:
        self.assertEqual(LESSON.difficulty, "advanced")
        self.assertTrue(3 <= len(LESSON.learning_objectives) <= 5)
        self.assertTrue(10 <= LESSON.estimated_minutes <= 30)
        self.assertIn("not a factoring implementation", LESSON.short_description)
        self.assertIn("fixed", LESSON.short_description)

    def test_explanations_are_short_single_paragraphs(self) -> None:
        for s in LESSON.sections:
            if isinstance(s, ExplanationSection):
                self.assertTrue(120 <= len(s.body) <= 680, f"{s.id}: {len(s.body)} chars")
                self.assertNotIn("\n", s.body)

    def test_two_concept_checks_each_with_one_correct_option_and_an_explanation(self) -> None:
        checks = [s for s in LESSON.sections if isinstance(s, ConceptCheckSection)]
        self.assertEqual([c.id for c in checks], ["s5", "s7"])
        self.assertEqual([c.correct_option_id for c in checks], ["b", "b"])
        for check in checks:
            self.assertEqual(len(check.options), 4)
            self.assertEqual(len({o.text for o in check.options}), 4)
            self.assertTrue(check.explanation.strip())
            self.assertEqual(check.concept, "order-finding")
            lengths = sorted(len(o.text) for o in check.options)
            correct = len(next(o for o in check.options if o.id == check.correct_option_id).text)
            self.assertLess(correct, lengths[-1] * 1.35, "the correct option must not stand out by length")

    def test_the_lab_uses_the_execute_capability_and_names_the_register_order_and_the_trace(self) -> None:
        (lab,) = [s for s in LESSON.sections if isinstance(s, InteractiveLabSection)]
        self.assertEqual(lab.capability, "execute")
        for word in ("backend", "shots", "q2 q1 q0", "trace", "work register"):
            self.assertIn(word, lab.instructions)
        self.assertIn("Nothing here is hardware", lab.instructions)

    def test_the_served_catalog_carries_it_without_keys_or_explanations(self) -> None:
        served = {l.id: l for l in app_module.list_lessons().lessons}[ID]
        self.assertEqual([s.model_dump() for s in served.sections], [s.model_dump() for s in public_lesson(LESSON).sections])
        blob = json.dumps(served.model_dump(mode="json"))
        self.assertNotIn("correct_option_id", blob)
        self.assertNotIn("no_challenge_reason", blob)
        for s in LESSON.sections:
            if isinstance(s, ConceptCheckSection):
                self.assertNotIn(s.explanation, blob)

    def test_it_has_no_challenge_and_says_why_and_the_validator_accepts_that(self) -> None:
        self.assertEqual([c.id for c in CHALLENGES if c.lesson_id == ID], [])
        self.assertTrue(LESSON.no_challenge_reason and len(LESSON.no_challenge_reason) > 60)
        self.assertIsNone(DECIMAL_OR_PERCENT.search(LESSON.no_challenge_reason))
        aer_or_skip(self)
        pairs = {(m, r.path) for r in app_module.app.routes for m in getattr(r, "methods", ())}
        report = validate_content(known_routes=pairs)
        self.assertTrue(report.ok, "\n" + str(report))
        self.assertEqual(report.checked["lessons"], 18)


class TestProse(unittest.TestCase):
    def test_no_decimal_or_percentage(self) -> None:
        for text in all_text(LESSON):
            self.assertIsNone(DECIMAL_OR_PERCENT.search(text), text[:80])

    def test_no_text_claims_a_run_produced_a_particular_outcome(self) -> None:
        pattern = re.compile(r"(the backend (returned|reported|measured)|you (got|measured|saw) (a |an )?\d|our run|in our experiment)", re.I)
        for text in all_text(LESSON):
            self.assertIsNone(pattern.search(text), text[:80])

    def test_no_multi_qubit_ket(self) -> None:
        for text in all_text(LESSON):
            self.assertIsNone(re.search(r"\|[01]{2,}⟩", text), text[:80])

    def test_worked_reasoning_is_labelled_textbook(self) -> None:
        for sid in ("s2", "s3", "s4", "s8"):
            self.assertIn("textbook", section(sid).body.lower(), sid)
        self.assertIn("textbook", LESSON.sections[6].explanation.lower())  # the classical finish is not a backend result

    def test_it_says_it_is_one_fixed_educational_instance_and_not_general_shor(self) -> None:
        s1 = section("s1").body
        for needle in ("ONE fixed small educational instance", "not a general factoring implementation", "not a scalable Shor's algorithm", "needs no hardware"):
            self.assertIn(needle, s1, needle)

    def test_it_says_what_it_is_not_again_at_the_end(self) -> None:
        s9 = section("s9").body
        for needle in (
            "ONE fixed instance",
            "not a general factoring implementation",
            "not a scalable Shor's algorithm",
            "not simulated here as a production factoring system",
            "no hardware",
            "statevector simulator",
        ):
            self.assertIn(needle, s9, needle)

    def test_it_claims_no_hardware_speedup_break_or_factoring_result(self) -> None:
        text = " ".join(all_text(LESSON)).lower()
        for claim in (
            "on real hardware",
            "ibm",
            "recorded run",
            "speed-up",
            "speedup",
            "quantum advantage",
            "faster than",
            "exponential",
            "rsa",
            "breaks ",
            "factored fifteen",
            "found the factors",
            "verified by the backend",
        ):
            self.assertNotIn(claim, text, claim)

    def test_the_deck_illustrative_numbers_never_appear(self) -> None:
        for forbidden in ("71 of 72", "71/72"):
            self.assertNotIn(forbidden, " ".join(all_text(LESSON)))

    def test_the_tutor_topics_are_in_the_section_titles(self) -> None:
        titles = " | ".join(s.title.lower() for s in LESSON.sections)
        for needle in ("hidden period", "order of 2 modulo 15", "multiplication as a gate", "period becomes a phase", "classical finish", "repeating", "fixed instance"):
            self.assertIn(needle, titles, needle)


class TestTheArithmeticTheTextStates(unittest.TestCase):
    """Plain integer arithmetic (no quantum number): the s2 cycle, the order, the s7 finish. Test-only."""

    def test_s2_the_powers_cycle_two_four_eight_one_so_the_order_is_four(self) -> None:
        self.assertEqual([pow(BASE, k, N) for k in range(1, 5)], [2, 4, 8, 1])
        order = next(k for k in range(1, N) if pow(BASE, k, N) == 1)
        self.assertEqual(order, 4)
        self.assertEqual(pow(BASE, 16, N), 1)  # why q2 (the power 4 of the multiplication, 16 modulo 15) needs no gate

    def test_s7_the_finish_gives_three_and_five_from_four_minus_one_and_four_plus_one(self) -> None:
        half = pow(BASE, 4 // 2)
        self.assertEqual((half - 1, half + 1), (3, 5))
        self.assertEqual((math.gcd(half - 1, N), math.gcd(half + 1, N)), (3, 5))
        self.assertEqual(3 * 5, N)

    def test_s8_the_allowed_phases_are_whole_quarters_and_only_two_of_them_show_the_full_order(self) -> None:
        phases = [Fraction(y, 8) for y in (0, 2, 4, 6)]
        self.assertEqual(phases, [Fraction(0), Fraction(1, 4), Fraction(1, 2), Fraction(3, 4)])
        self.assertEqual([p.denominator for p in phases], [1, 4, 2, 4])  # none shows nothing; a half shows only part; a quarter and three quarters show 4
        self.assertEqual({p.denominator for p in phases if p.denominator == 4}, {4})


class TestThePhysicsTheTextStates(unittest.TestCase):
    """Checked on the real backends. Test-only: nothing here is shipped."""

    def setUp(self) -> None:
        aer_or_skip(self)
        self.circuit = LESSON.linked_circuit
        self.unmeasured = without_measurement(self.circuit)
        self.state = AER.run(self.unmeasured, "statevector").statevector

    def test_the_lab_circuit_is_seven_qubits_with_three_measured_and_within_every_limit(self) -> None:
        self.assertEqual((self.circuit.num_qubits, self.circuit.num_clbits), (7, 3))
        self.assertEqual(len(self.circuit.ops), 29)
        self.assertEqual([op.targets for op in self.circuit.ops if op.gate.value == "measure"], [[0], [1], [2]])
        for adapter_name in ("qiskit-aer", "cirq", "pennylane"):
            check_run_limits(self.circuit, adapter_name)
        gates = {op.gate.value for op in self.circuit.ops}
        self.assertTrue(gates <= {"x", "h", "cx", "ccx", "cp", "swap", "measure"}, gates)

    def test_s5_s6_the_counting_register_is_one_of_four_evenly_spaced_strings_each_a_quarter_of_the_time(self) -> None:
        distribution = project_distribution(self.state, [2, 1, 0])
        self.assertEqual(set(distribution), {"000", "010", "100", "110"})
        for bits, probability in distribution.items():
            self.assertAlmostEqual(probability, QUARTER, places=9, msg=bits)
        # the strings are the multiples of two: phases y/8 that are whole numbers of quarter turns (s4)
        self.assertEqual(sorted(int(bits, 2) for bits in distribution), [0, 2, 4, 6])
        self.assertEqual({Fraction(int(bits, 2), 8).denominator for bits in distribution}, {1, 4, 2})

    def test_s6_the_work_register_holds_the_cycle_one_two_four_eight(self) -> None:
        work = project_distribution(self.state, [6, 5, 4, 3])
        self.assertEqual(set(work), {format(pow(BASE, k, N), "04b") for k in range(4)})
        for probability in work.values():
            self.assertAlmostEqual(probability, QUARTER, places=9)

    def test_s6_shots_only_ever_show_those_four_strings_and_all_of_them(self) -> None:
        counts = AER.run(self.circuit, "shots", 2000).counts
        self.assertEqual(sum(counts.values()), 2000)
        self.assertEqual({bits for bits, n in counts.items() if n}, {"000", "010", "100", "110"})

    def test_s3_the_controlled_multiplications_do_exactly_what_the_text_says_for_every_work_value(self) -> None:
        # Basis sweep on the backend: control (q0 for "times 2", q1 for "times 4") and the work value x are inputs (the harness reads input
        # bits highest qubit first, so the bit string is x then the control); the work register must
        # read (multiplier * x modulo 15) when the control is 1 and x when it is 0. The value 15 stays 15 (the text's wrap-around).
        for control, multiplier, ops in ((0, 2, SHOR_CONTROLLED_TIMES_2), (1, 4, SHOR_CONTROLLED_TIMES_4)):
            cases = []
            for c in (0, 1):
                for x in range(16):
                    expected = (multiplier * x % N if x != 15 else 15) if c else x
                    cases.append(TestCaseSpec(input_bits=format(x, "04b") + str(c), expected_output=format(expected, "04b")))
            report = run_multi_input_test(
                circuit=Circuit(num_qubits=7, num_clbits=0, ops=ops),
                adapter=AER,
                input_qubits=[control, 6, 5, 4, 3],
                output_qubits=[6, 5, 4, 3],
                cases=cases,
            )
            self.assertEqual(report.overall_status, OverallStatus.ALL_PASSED, (multiplier, report.counterexamples[:1]))

    def test_s3_it_is_three_swaps_for_times_two_and_two_for_times_four_each_made_of_cx_ccx_cx(self) -> None:
        self.assertEqual(len(SHOR_CONTROLLED_TIMES_2), 9)
        self.assertEqual(len(SHOR_CONTROLLED_TIMES_4), 6)
        for ops in (SHOR_CONTROLLED_TIMES_2, SHOR_CONTROLLED_TIMES_4):
            self.assertEqual([op.gate.value for op in ops], ["cx", "ccx", "cx"] * (len(ops) // 3))
        self.assertEqual(SHOR_CONTROLLED_POWERS, [*SHOR_CONTROLLED_TIMES_2, *SHOR_CONTROLLED_TIMES_4])
        # q2 has no controlled gate: "multiplying by 16 changes nothing"
        controls_used = {c for op in SHOR_CONTROLLED_POWERS for c in op.controls if c < 3}
        self.assertEqual(controls_used, {0, 1})

    def test_the_prepared_work_register_starts_at_the_number_one(self) -> None:
        start = AER.run(Circuit(num_qubits=7, num_clbits=0, ops=SHOR_PREPARE), "statevector").statevector
        self.assertEqual(set(project_distribution(start, [6, 5, 4, 3])), {"0001"})

    def test_the_three_backends_agree_on_the_state(self) -> None:
        states = {"qiskit-aer": self.state}
        for adapter in (CirqAdapter(), PennyLaneAdapter()):
            states[adapter.name] = adapter.run(self.unmeasured, "statevector").statevector
        for pair in compare_all(states):
            self.assertTrue(pair.agrees, pair)

    def test_it_can_be_traced_within_the_trace_limits_and_the_final_step_is_the_run_state(self) -> None:
        body, _ = split_terminal_measurements(self.circuit)
        trace = trace_circuit(self.circuit, AER, max_qubits=8, max_operations=64)
        self.assertEqual(len(trace.steps), len(body) + 1)
        self.assertEqual(len(trace.terminal_measurements), 3)
        self.assertEqual(trace.steps[-1].statevector, self.state)

    def test_breaking_the_circuit_changes_what_the_backend_returns(self) -> None:
        # failure case: without the controlled multiplication by 2 the structure is gone and the counting register is no longer the four strings
        broken = Circuit(num_qubits=7, num_clbits=0, ops=[*SHOR_PREPARE, *SHOR_CONTROLLED_TIMES_4, *without_measurement(LESSON.linked_circuit).ops[len(SHOR_PREPARE) + len(SHOR_CONTROLLED_POWERS):]])
        distribution = project_distribution(AER.run(broken, "statevector").statevector, [2, 1, 0])
        self.assertNotEqual(set(distribution), {"000", "010", "100", "110"})
        # and a wrong gate in the multiplication breaks the work register's cycle
        ops = list(SHOR_CONTROLLED_TIMES_2)
        ops[7] = GateOp(gate="ccx", controls=[0, 5], targets=[4])  # the last swap guarded by the wrong wire (it needs q3, which is the one holding the value)
        wrong = Circuit(num_qubits=7, num_clbits=0, ops=[*SHOR_PREPARE, *ops, *SHOR_CONTROLLED_TIMES_4])
        wrong_state = AER.run(wrong, "statevector").statevector
        right_state = AER.run(Circuit(num_qubits=7, num_clbits=0, ops=[*SHOR_PREPARE, *SHOR_CONTROLLED_POWERS]), "statevector").statevector
        _, _, fidelity = compare_states(wrong_state, right_state)
        self.assertLess(fidelity, 1 - 1e-6)


class TestServerGradingAndTheTutor(unittest.TestCase):
    def test_the_server_grades_each_check_and_returns_the_explanation_only_then(self) -> None:
        for check in (c for c in LESSON.sections if isinstance(c, ConceptCheckSection)):
            right = grade_concept_check(ID, check.id, check.correct_option_id)
            self.assertTrue(right.correct)
            self.assertEqual(right.explanation, check.explanation)
            for option in check.options:
                if option.id != check.correct_option_id:
                    wrong = grade_concept_check(ID, check.id, option.id)
                    self.assertFalse(wrong.correct, (check.id, option.id))

    def _ask(self, question, section_id, language="en"):
        return answer_lesson_aware_question(question, resolve_lesson_context(ID, section_id), [], None, None, language)[0]

    def test_explain_simpler_and_hint_work_on_every_section_in_three_languages(self) -> None:
        markers = {
            "en": ((EXPLAIN, "About this part of the lesson:"), (SIMPLER, "In short:"), (HINT, "A hint:")),
            "hi": ((EXPLAIN, "पाठ के इस भाग के बारे में:"), (SIMPLER, "संक्षेप में:"), (HINT, "एक संकेत:")),
            "kn": ((EXPLAIN, "ಪಾಠದ ಈ ಭಾಗದ ಬಗ್ಗೆ:"), (SIMPLER, "ಸಂಕ್ಷಿಪ್ತವಾಗಿ:"), (HINT, "ಒಂದು ಸುಳಿವು:")),
        }
        swept = 0
        for language, pairs in markers.items():
            for s in LESSON.sections:
                for question, marker in pairs:
                    answer = self._ask(question, s.id, language)
                    swept += 1
                    self.assertTrue(answer.startswith(marker), f"{language}/{s.id}/{question}: {answer[:60]}")
                    self.assertFalse(DECIMAL.search(answer), f"{language}/{s.id}/{question}")
        self.assertEqual(swept, 3 * 10 * 3)

    def test_hindi_and_kannada_localise_only_the_wrapper_the_lesson_text_stays_english(self) -> None:
        for language, marker in (("hi", HI_EXPLAIN), ("kn", KN_EXPLAIN)):
            answer = self._ask(EXPLAIN, "s3", language)
            self.assertIn(marker, answer)
            self.assertIn(section("s3").body.split(".")[0], answer)

    def test_a_hint_never_gives_the_answer_to_a_check(self) -> None:
        for check in (c for c in LESSON.sections if isinstance(c, ConceptCheckSection)):
            hint = self._ask(HINT, check.id)
            self.assertNotIn(check.explanation, hint)
            self.assertNotIn(next(o.text for o in check.options if o.id == check.correct_option_id), hint)


if __name__ == "__main__":
    unittest.main()
