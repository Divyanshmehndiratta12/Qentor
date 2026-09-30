"""Quality and trust tests for the seven foundation lessons
(``qentor.lessons.content_foundations``).

Three groups:

1. Structure and concept-check integrity — every lesson has the same shape, and
   every question has four distinct options with exactly one correct answer that
   the question itself does not give away.
2. Prose trust — lesson text never contains a decimal or percentage (so it can
   never be mistaken for a result), and every lab points the learner at the
   backend rather than quoting an outcome.
3. Labs match their claims — each lesson's linked circuit is executed on the
   real Aer backend and the textbook claims the lesson makes about it are
   checked against what the backend actually returns. (These run in the test
   suite only; nothing here ships as a result.)
"""

from __future__ import annotations

import math
import re
import unittest

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.bloch import bloch_coordinates
from qentor.execution.trace import trace_circuit
from qentor.lessons import LESSONS, ConceptCheckSection, ExplanationSection, InteractiveLabSection, ReflectionSection, get_lesson
from qentor.provenance.models import ProvenanceClass, ProvenanceRecord
from qentor.provenance.models import ExecutionStatus
from qentor.verification.bell_state import verify_bell_state
from qentor.verification.models import VerificationStatus

FOUNDATION_IDS = [
    "qubits-measurement",
    "bloch-sphere",
    "superposition",
    "phase",
    "interference",
    "entanglement",
    "bell-state",
]
FOUNDATION = [get_lesson(lesson_id) for lesson_id in FOUNDATION_IDS]

DECIMAL_OR_PERCENT = re.compile(r"\d+\.\d+|\d+\s?%")
EXPECTED_SHAPE = [
    "explanation", "explanation", "explanation", "explanation",
    "concept_check", "interactive_lab", "concept_check", "explanation", "reflection",
]


def _checks(lesson):
    return [s for s in lesson.sections if isinstance(s, ConceptCheckSection) and s.question is not None]


def _all_checks():
    return [(lesson, s) for lesson in FOUNDATION for s in _checks(lesson)]


def _all_text(lesson) -> list[str]:
    """Every learner-visible string of a lesson."""
    parts = [lesson.title, lesson.short_description, *lesson.learning_objectives]
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


class TestFoundationLessonStructure(unittest.TestCase):
    def test_all_seven_are_registered_in_teaching_order_with_unchanged_prerequisites(self) -> None:
        self.assertEqual([lesson.id for lesson in LESSONS][:7], FOUNDATION_IDS)
        prereqs = {lesson.id: lesson.prerequisite_lesson_ids for lesson in FOUNDATION}
        self.assertEqual(
            prereqs,
            {
                "qubits-measurement": [],
                "bloch-sphere": ["qubits-measurement"],
                "superposition": ["qubits-measurement"],
                "phase": ["superposition"],
                "interference": ["phase"],
                "entanglement": ["superposition"],
                "bell-state": ["entanglement"],
            },
        )

    def test_every_lesson_has_the_same_intuition_concept_example_lab_check_reflection_shape(self) -> None:
        for lesson in FOUNDATION:
            self.assertEqual([s.type for s in lesson.sections], EXPECTED_SHAPE, lesson.id)
            self.assertEqual([s.id for s in lesson.sections], [f"s{i}" for i in range(1, 10)], lesson.id)

    def test_counts_match_the_brief(self) -> None:
        for lesson in FOUNDATION:
            kinds = [s.type for s in lesson.sections]
            self.assertTrue(3 <= kinds.count("explanation") <= 5, lesson.id)
            self.assertTrue(1 <= kinds.count("concept_check") <= 2, lesson.id)
            self.assertEqual(kinds.count("interactive_lab"), 1, lesson.id)
            self.assertGreaterEqual(kinds.count("reflection"), 1, lesson.id)

    def test_explanations_are_short_paragraphs_not_walls_of_text(self) -> None:
        for lesson in FOUNDATION:
            for s in lesson.sections:
                if isinstance(s, ExplanationSection):
                    self.assertTrue(120 <= len(s.body) <= 680, f"{lesson.id}/{s.id}: {len(s.body)} chars")
                    self.assertNotIn("\n", s.body, f"{lesson.id}/{s.id}")  # rendered as one paragraph

    def test_titles_objectives_and_metadata_are_present_and_sensible(self) -> None:
        for lesson in FOUNDATION:
            self.assertTrue(3 <= len(lesson.learning_objectives) <= 5, lesson.id)
            self.assertTrue(10 <= lesson.estimated_minutes <= 25, lesson.id)
            for text in [lesson.title, lesson.short_description, *lesson.learning_objectives]:
                self.assertTrue(text.strip(), lesson.id)
            for s in lesson.sections:
                self.assertTrue(s.title.strip(), f"{lesson.id}/{s.id}")

    def test_every_lesson_has_a_linked_circuit_for_its_lab(self) -> None:
        for lesson in FOUNDATION:
            self.assertIsNotNone(lesson.linked_circuit, lesson.id)
            lab = next(s for s in lesson.sections if isinstance(s, InteractiveLabSection))
            self.assertEqual(lab.capability, "verify_bell_state" if lesson.id == "bell-state" else "execute")

    def test_labs_send_the_learner_to_the_backend_and_never_quote_an_outcome(self) -> None:
        for lesson in FOUNDATION:
            lab = next(s for s in lesson.sections if isinstance(s, InteractiveLabSection))
            self.assertIn("backend", lab.instructions.lower(), lesson.id)
            self.assertFalse(DECIMAL_OR_PERCENT.search(lab.instructions), lesson.id)

    def test_a_reader_could_still_follow_the_lesson_start_to_finish_through_the_api(self) -> None:
        from qentor.api import app as app_module

        served = {lesson.id: lesson for lesson in app_module.list_lessons().lessons}
        for lesson in FOUNDATION:
            self.assertEqual(
                [s.model_dump() for s in served[lesson.id].sections],
                [s.model_dump() for s in lesson.sections],
                lesson.id,
            )


class TestConceptCheckIntegrity(unittest.TestCase):
    def test_there_are_two_real_checks_per_foundation_lesson(self) -> None:
        self.assertEqual(len(_all_checks()), 14)
        for lesson in FOUNDATION:
            self.assertEqual(len(_checks(lesson)), 2, lesson.id)

    def test_every_check_validates_with_all_four_question_fields_present(self) -> None:
        for lesson, s in _all_checks():
            self.assertIsNotNone(s.options, f"{lesson.id}/{s.id}")
            self.assertTrue(s.question and s.explanation and s.correct_option_id, f"{lesson.id}/{s.id}")
            # round-trips through the model's own validators
            ConceptCheckSection.model_validate(s.model_dump())

    def test_exactly_one_correct_option_exists_and_ids_are_unique(self) -> None:
        for lesson, s in _all_checks():
            ids = [o.id for o in s.options]
            self.assertEqual(len(ids), len(set(ids)), f"{lesson.id}/{s.id}: duplicate option ids")
            self.assertEqual(ids.count(s.correct_option_id), 1, f"{lesson.id}/{s.id}")
            self.assertEqual(sorted(ids), ["a", "b", "c", "d"], f"{lesson.id}/{s.id}")

    def test_no_empty_or_duplicate_option_text(self) -> None:
        for lesson, s in _all_checks():
            texts = [o.text.strip() for o in s.options]
            self.assertTrue(all(len(t) >= 3 for t in texts), f"{lesson.id}/{s.id}: empty option")
            self.assertEqual(len({t.lower() for t in texts}), len(texts), f"{lesson.id}/{s.id}: duplicate option text")

    def test_the_question_does_not_give_the_answer_away(self) -> None:
        for lesson, s in _all_checks():
            correct = next(o.text for o in s.options if o.id == s.correct_option_id)
            self.assertNotIn(correct.lower(), s.question.lower(), f"{lesson.id}/{s.id}")
            self.assertNotIn(correct.lower(), s.prompt.lower(), f"{lesson.id}/{s.id}")
            for tell in ("correct answer", "the answer is", "right answer", "correct_option"):
                self.assertNotIn(tell, (s.question + " " + s.prompt).lower(), f"{lesson.id}/{s.id}")
            self.assertTrue(s.question.strip().endswith("?"), f"{lesson.id}/{s.id}")

    def test_the_answer_option_is_not_visible_in_any_lesson_text_field(self) -> None:
        """`correct_option_id` is data, never learner-visible prose."""
        for lesson in FOUNDATION:
            for text in _all_text(lesson):
                self.assertNotIn("correct_option_id", text)
                self.assertNotIn("correctOptionId", text)

    def test_the_explanation_teaches_why_and_is_not_a_bare_restatement(self) -> None:
        for lesson, s in _all_checks():
            self.assertGreaterEqual(len(s.explanation), 120, f"{lesson.id}/{s.id}")
            self.assertGreaterEqual(s.explanation.count("."), 2, f"{lesson.id}/{s.id}: explain in more than one sentence")

    def test_the_correct_answer_is_not_always_in_the_same_place_or_always_the_longest(self) -> None:
        correct_ids = [s.correct_option_id for _, s in _all_checks()]
        self.assertGreaterEqual(len(set(correct_ids)), 4, correct_ids)
        for option_id in "abcd":
            # 14 checks over 4 ids: an even spread is 3-4 each; more than 4 means a habit.
            self.assertLessEqual(correct_ids.count(option_id), 4, f"{option_id!r} is correct too often: {correct_ids}")
        longest = 0
        for _, s in _all_checks():
            lengths = {o.id: len(o.text) for o in s.options}
            if lengths[s.correct_option_id] == max(lengths.values()):
                longest += 1
        self.assertLessEqual(longest, 7, "the correct option is the longest one too often — a tell-tale")

    def test_distractors_are_real_options_not_filler(self) -> None:
        for lesson, s in _all_checks():
            for o in s.options:
                self.assertFalse(re.fullmatch(r"(none|all) of the above|n/a|\.\.\.", o.text.strip().lower()), f"{lesson.id}/{s.id}")

    def test_each_check_carries_its_lessons_concept_for_mastery_grouping(self) -> None:
        for lesson, s in _all_checks():
            self.assertEqual(s.concept, lesson.concept, f"{lesson.id}/{s.id}")


class TestProseNeverLooksLikeAResult(unittest.TestCase):
    def test_no_lesson_text_contains_a_decimal_or_a_percentage(self) -> None:
        for lesson in FOUNDATION:
            for text in _all_text(lesson):
                self.assertFalse(DECIMAL_OR_PERCENT.search(text), f"{lesson.id}: {text[:80]!r}")

    def test_no_lesson_text_claims_a_run_produced_a_particular_outcome(self) -> None:
        pattern = re.compile(r"(the backend (returned|reported|measured)|you (got|measured|saw) (a |an )?\d|our run|in our experiment)", re.I)
        for lesson in FOUNDATION:
            for text in _all_text(lesson):
                self.assertIsNone(pattern.search(text), f"{lesson.id}: {text[:80]!r}")

    def test_worked_examples_are_labelled_as_textbook_algebra(self) -> None:
        # The lessons that write out states step by step say they are textbook
        # maths and hand the actual numbers to the lab / trace.
        for lesson_id, section_id in [("bloch-sphere", "s3"), ("interference", "s3"), ("phase", "s4")]:
            body = next(s for s in get_lesson(lesson_id).sections if s.id == section_id).body.lower()
            self.assertTrue("textbook" in body or "lab" in body, f"{lesson_id}/{section_id}")

    def test_two_qubit_kets_use_the_platforms_bit_order(self) -> None:
        text = " ".join(_all_text(get_lesson("entanglement")))
        self.assertIn("highest-numbered qubit on the left", text)


def _reduced_purity_of_qubit0(amplitudes: list[float]) -> float:
    """Purity tr(rho^2) of qubit 0's reduced state for a real two-qubit state given
    as amplitudes over [00, 01, 10, 11] (qubit 1 on the left). 1 means qubit 0 has a
    state of its own (separable); less than 1 means the pair is entangled."""
    a = amplitudes
    norm = sum(x * x for x in a)
    a = [x / math.sqrt(norm) for x in a]
    # rho0[i][j] = sum over qubit 1 (k) of psi[k][i] * psi[k][j]; psi[k][i] = a[2k + i]
    rho = [[sum(a[2 * k + i] * a[2 * k + j] for k in range(2)) for j in range(2)] for i in range(2)]
    return sum(rho[i][j] * rho[j][i] for i in range(2) for j in range(2))


class TestAnswerKeysAreTrue(unittest.TestCase):
    """The structure tests cannot know WHICH option is true. Where the physics is
    computable, verify the answer key itself, so a wrong key fails a test."""

    # option text -> real amplitudes over [00, 01, 10, 11], for the entanglement check
    STATES = {
        "(|00⟩ + |01⟩)/√2": [1, 1, 0, 0],
        "|01⟩": [0, 1, 0, 0],
        "(|00⟩ + |01⟩ + |10⟩ + |11⟩)/2": [1, 1, 1, 1],
        "(|00⟩ + |11⟩)/√2": [1, 0, 0, 1],
    }

    def test_the_entanglement_check_marks_exactly_the_entangled_state_correct(self) -> None:
        check = next(s for s in get_lesson("entanglement").sections if s.id == "s5")
        entangled = {o.id for o in check.options if _reduced_purity_of_qubit0(self.STATES[o.text]) < 1 - 1e-9}
        self.assertEqual(entangled, {check.correct_option_id})

    def test_the_purity_helper_itself_is_right(self) -> None:
        self.assertAlmostEqual(_reduced_purity_of_qubit0([1, 0, 0, 1]), 0.5, places=9)  # Bell: maximally mixed
        self.assertAlmostEqual(_reduced_purity_of_qubit0([1, 1, 0, 0]), 1.0, places=9)  # product state


class TestLabsMatchTheirClaims(unittest.TestCase):
    """Executes each lesson's linked circuit on the real backend and checks the
    textbook claim the lesson makes about it. Skipped (not faked) without Aer."""

    def setUp(self) -> None:
        self.aer = AerAdapter()
        try:
            self.aer.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")
        except Exception:
            pass

    def _sv(self, circuit: Circuit):
        return self.aer.run(circuit, "statevector").to_payload()["statevector"]

    def _shots(self, circuit: Circuit, shots: int = 2000):
        return self.aer.run(circuit, "shots", shots).to_payload()

    def _circuit(self, num_qubits, num_clbits, *ops):
        return Circuit(num_qubits=num_qubits, num_clbits=num_clbits, ops=list(ops))

    def test_every_linked_circuit_runs_on_the_backend(self) -> None:
        for lesson in LESSONS:
            with self.subTest(lesson=lesson.id):
                state = self._sv(lesson.linked_circuit)
                self.assertEqual(len(state), 2 ** lesson.linked_circuit.num_qubits)

    def test_qubits_measurement_lab_x_then_measure_gives_a_definite_one(self) -> None:
        payload = self._shots(get_lesson("qubits-measurement").linked_circuit)
        self.assertEqual(set(payload["probabilities"]), {"1"})

    def test_superposition_lab_h_gives_equal_amplitudes_in_the_trace_and_both_outcomes_in_shots(self) -> None:
        circuit = get_lesson("superposition").linked_circuit
        # The lab tells the learner to open the TRACE for the amplitudes right after H:
        # a plain statevector run of a circuit that ends in a measurement returns the
        # COLLAPSED state, so the trace (which stops before the terminal measurement)
        # is the right tool.
        trace = trace_circuit(circuit, self.aer, mode="statevector", max_qubits=4, max_operations=8)
        after_h = [complex(re, im) for re, im in trace.steps[-1].statevector]
        self.assertAlmostEqual(abs(after_h[0]), 1 / math.sqrt(2), places=9)
        self.assertAlmostEqual(abs(after_h[1]), 1 / math.sqrt(2), places=9)
        self.assertAlmostEqual(abs(after_h[0]) ** 2, 0.5, places=9)  # amplitude squared is a probability
        self.assertEqual(len(trace.terminal_measurements), 1)
        self.assertEqual(set(self._shots(circuit)["probabilities"]), {"0", "1"})

    def test_a_statevector_run_of_a_circuit_ending_in_a_measurement_is_collapsed_so_no_lab_text_relies_on_it(self) -> None:
        """Pin the behaviour that shaped the superposition lab text, and make sure
        no lab tells the learner to read pre-measurement amplitudes from a plain
        statevector run of a circuit that ends in a measurement."""
        collapsed = [complex(re, im) for re, im in self._sv(get_lesson("superposition").linked_circuit)]
        self.assertIn(round(abs(collapsed[0]), 9), (0.0, 1.0))
        for lesson in FOUNDATION:
            lab = next(s for s in lesson.sections if isinstance(s, InteractiveLabSection))
            ends_in_measurement = lesson.linked_circuit.ops[-1].gate.value == "measure"
            if ends_in_measurement:
                self.assertNotIn("statevector mode and look at the amplitudes", lab.instructions, lesson.id)

    def test_h_twice_returns_to_zero_as_the_superposition_lesson_says(self) -> None:
        circuit = self._circuit(1, 1, GateOp(gate="h", targets=[0]), GateOp(gate="h", targets=[0]), GateOp(gate="measure", targets=[0], clbits=[0]))
        self.assertEqual(set(self._shots(circuit)["probabilities"]), {"0"})

    def test_phase_lab_z_changes_the_sign_but_not_the_probabilities(self) -> None:
        with_z = [complex(re, im) for re, im in self._sv(get_lesson("phase").linked_circuit)]
        h_only = [complex(re, im) for re, im in self._sv(self._circuit(1, 0, GateOp(gate="h", targets=[0])))]
        self.assertAlmostEqual(abs(with_z[0]) ** 2, abs(h_only[0]) ** 2, places=9)
        self.assertAlmostEqual(abs(with_z[1]) ** 2, abs(h_only[1]) ** 2, places=9)
        self.assertAlmostEqual((with_z[1] / with_z[0]).real, -1.0, places=9)  # the |1> amplitude flipped sign
        self.assertAlmostEqual((h_only[1] / h_only[0]).real, 1.0, places=9)

    def test_phase_lesson_h_maps_plus_and_minus_to_zero_and_one(self) -> None:
        h = GateOp(gate="h", targets=[0])
        plus_then_h = self._circuit(1, 1, h, h, GateOp(gate="measure", targets=[0], clbits=[0]))
        minus_then_h = self._circuit(1, 1, h, GateOp(gate="z", targets=[0]), h, GateOp(gate="measure", targets=[0], clbits=[0]))
        self.assertEqual(set(self._shots(plus_then_h)["probabilities"]), {"0"})
        self.assertEqual(set(self._shots(minus_then_h)["probabilities"]), {"1"})

    def test_interference_lab_h_z_h_never_gives_zero_and_without_the_z_never_gives_one(self) -> None:
        self.assertEqual(set(self._shots(get_lesson("interference").linked_circuit)["probabilities"]), {"1"})
        no_z = self._circuit(1, 1, GateOp(gate="h", targets=[0]), GateOp(gate="h", targets=[0]), GateOp(gate="measure", targets=[0], clbits=[0]))
        self.assertEqual(set(self._shots(no_z)["probabilities"]), {"0"})

    def test_bloch_lab_h_then_s_lands_on_plus_i_and_h_alone_on_plus(self) -> None:
        x, y, z = bloch_coordinates(self._sv(get_lesson("bloch-sphere").linked_circuit))
        self.assertAlmostEqual(x, 0.0, places=9)
        self.assertAlmostEqual(y, 1.0, places=9)  # |+i> is +y
        self.assertAlmostEqual(z, 0.0, places=9)
        x, y, z = bloch_coordinates(self._sv(self._circuit(1, 0, GateOp(gate="h", targets=[0]))))
        self.assertAlmostEqual(x, 1.0, places=9)  # |+> is +x
        self.assertAlmostEqual(z, 0.0, places=9)

    def test_bloch_lesson_x_swaps_the_poles_and_z_leaves_them_fixed(self) -> None:
        x_state = bloch_coordinates(self._sv(self._circuit(1, 0, GateOp(gate="x", targets=[0]))))
        self.assertAlmostEqual(x_state[2], -1.0, places=9)  # south pole
        z_state = bloch_coordinates(self._sv(self._circuit(1, 0, GateOp(gate="z", targets=[0]))))
        self.assertAlmostEqual(z_state[2], 1.0, places=9)  # |0> is unchanged by Z

    def test_entanglement_lab_h_cx_has_only_00_and_11_with_equal_size(self) -> None:
        state = [complex(re, im) for re, im in self._sv(get_lesson("entanglement").linked_circuit)]
        self.assertAlmostEqual(abs(state[0]), 1 / math.sqrt(2), places=9)
        self.assertAlmostEqual(abs(state[3]), 1 / math.sqrt(2), places=9)
        self.assertAlmostEqual(abs(state[1]), 0.0, places=9)
        self.assertAlmostEqual(abs(state[2]), 0.0, places=9)

    def test_the_bit_order_and_intermediate_state_the_lessons_write_out(self) -> None:
        """Lessons write kets with the highest-numbered qubit on the left: after H
        on qubit 0 the state is (|00> + |01>)/sqrt2, i.e. basis indices 0 and 1."""
        state = [complex(re, im) for re, im in self._sv(self._circuit(2, 0, GateOp(gate="h", targets=[0])))]
        self.assertGreater(abs(state[0]), 0.7)
        self.assertGreater(abs(state[1]), 0.7)
        self.assertAlmostEqual(abs(state[2]) + abs(state[3]), 0.0, places=9)
        # and CX before H leaves the pair unentangled (only qubit 0 is in superposition)
        reversed_order = self._circuit(2, 0, GateOp(gate="cx", controls=[0], targets=[1]), GateOp(gate="h", targets=[0]))
        s2 = [complex(re, im) for re, im in self._sv(reversed_order)]
        self.assertAlmostEqual(abs(s2[3]), 0.0, places=9)

    def test_independent_hadamards_give_all_four_outcomes_and_the_bell_pair_only_two(self) -> None:
        independent = self._circuit(
            2, 2,
            GateOp(gate="h", targets=[0]), GateOp(gate="h", targets=[1]),
            GateOp(gate="measure", targets=[0], clbits=[0]), GateOp(gate="measure", targets=[1], clbits=[1]),
        )
        self.assertEqual(set(self._shots(independent, 4000)["probabilities"]), {"00", "01", "10", "11"})
        bell = get_lesson("bell-state").linked_circuit
        self.assertEqual(set(self._shots(bell, 4000)["probabilities"]), {"00", "11"})

    def test_bell_lab_run_passes_the_bell_verifier_and_a_broken_circuit_is_unverifiable(self) -> None:
        circuit = get_lesson("bell-state").linked_circuit
        result = self.aer.run(circuit, "shots", 2000)
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(circuit), backend=result.backend_name, backend_version=result.backend_version,
            execution_mode=result.execution_mode, provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED, payload=result.to_payload(),
        )
        self.assertEqual(verify_bell_state(circuit, record).verification_status, VerificationStatus.VERIFIED)

        # "moving the H" (the lab's suggestion): CX before H is not the canonical pattern.
        broken = self._circuit(
            2, 2,
            GateOp(gate="cx", controls=[0], targets=[1]), GateOp(gate="h", targets=[0]),
            GateOp(gate="measure", targets=[0], clbits=[0]), GateOp(gate="measure", targets=[1], clbits=[1]),
        )
        broken_result = self.aer.run(broken, "shots", 2000)
        broken_record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(broken), backend=broken_result.backend_name, backend_version=broken_result.backend_version,
            execution_mode=broken_result.execution_mode, provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED, payload=broken_result.to_payload(),
        )
        self.assertEqual(verify_bell_state(broken, broken_record).verification_status, VerificationStatus.UNVERIFIABLE)

    # ---- answer keys, tied to what the backend actually does -------------------------

    def _key(self, lesson_id: str, section_id: str) -> str:
        check = next(s for s in get_lesson(lesson_id).sections if s.id == section_id)
        return next(o.text for o in check.options if o.id == check.correct_option_id)

    def _measured_twice(self):
        circuit = self._circuit(
            1, 2,
            GateOp(gate="h", targets=[0]),
            GateOp(gate="measure", targets=[0], clbits=[0]),
            GateOp(gate="measure", targets=[0], clbits=[1]),
        )
        return set(self._shots(circuit, 4000)["probabilities"])

    def test_answer_keys_of_the_computable_checks_match_the_backend(self) -> None:
        h = GateOp(gate="h", targets=[0])
        z = GateOp(gate="z", targets=[0])
        m = GateOp(gate="measure", targets=[0], clbits=[0])

        # qubits-measurement s7: a second measurement repeats the first
        self.assertEqual(self._measured_twice() - {"00", "11"}, set())  # never 01 / 10
        self.assertTrue(self._key("qubits-measurement", "s7").startswith("1 again"))

        # bloch-sphere s5: X on the north pole gives the south pole
        south = bloch_coordinates(self._sv(self._circuit(1, 0, GateOp(gate="x", targets=[0]))))
        self.assertAlmostEqual(south[2], -1.0, places=9)
        self.assertIn("south pole", self._key("bloch-sphere", "s5"))

        # bloch-sphere s7: |+> and |-> measure alike but sit at opposite points on the equator
        plus, minus = self._sv(self._circuit(1, 0, h)), self._sv(self._circuit(1, 0, h, z))
        for state in (plus, minus):
            self.assertAlmostEqual(state[0][0] ** 2 + state[0][1] ** 2, 0.5, places=9)
        self.assertAlmostEqual(bloch_coordinates(plus)[0], 1.0, places=9)
        self.assertAlmostEqual(bloch_coordinates(minus)[0], -1.0, places=9)
        key = self._key("bloch-sphere", "s7")
        self.assertTrue("relative phase" in key and "opposite points" in key)

        # superposition s5: probability of 1 after H is 1/2
        after_h = self._sv(self._circuit(1, 0, h))
        self.assertAlmostEqual(after_h[1][0] ** 2 + after_h[1][1] ** 2, 0.5, places=9)
        self.assertTrue(self._key("superposition", "s5").startswith("1/2"))

        # superposition s7: H then H returns |0> with certainty
        self.assertEqual(set(self._shots(self._circuit(1, 1, h, h, m))["probabilities"]), {"0"})
        self.assertIn("returns to |0⟩ with certainty", self._key("superposition", "s7"))

        # phase s5: Z leaves the immediate measurement probabilities unchanged
        p_before = [re * re + im * im for re, im in self._sv(self._circuit(1, 0, h))]
        p_after = [re * re + im * im for re, im in self._sv(self._circuit(1, 0, h, z))]
        for a, b in zip(p_before, p_after):
            self.assertAlmostEqual(a, b, places=9)
        self.assertTrue(self._key("phase", "s5").startswith("They are unchanged"))

        # interference s5 / s7: outcome 0 is never seen in H,Z,H; outcome 0 is certain in H,H
        self.assertEqual(set(self._shots(self._circuit(1, 1, h, z, h, m))["probabilities"]), {"1"})
        self.assertIn("opposite signs and cancel", self._key("interference", "s5"))
        self.assertEqual(set(self._shots(self._circuit(1, 1, h, h, m))["probabilities"]), {"0"})
        key = self._key("interference", "s7")
        self.assertTrue(key.startswith("Outcome 0") and "routes to outcome 1 cancel" in key, key)

        # entanglement s7: independent Hadamards -> all four outcomes; H+CX -> only 00 and 11
        independent = self._circuit(
            2, 2, h, GateOp(gate="h", targets=[1]),
            GateOp(gate="measure", targets=[0], clbits=[0]), GateOp(gate="measure", targets=[1], clbits=[1]),
        )
        self.assertEqual(len(self._shots(independent, 4000)["probabilities"]), 4)
        self.assertEqual(set(self._shots(get_lesson("bell-state").linked_circuit, 4000)["probabilities"]), {"00", "11"})
        key = self._key("entanglement", "s7")
        self.assertTrue(key.startswith("A shows all four") and "B shows only 00 and 11" in key)

        # bell-state s5: outcomes 01 and 10 never occur, so a first reading of 1 means a second reading of 1
        seen = set(self._shots(get_lesson("bell-state").linked_circuit, 4000)["probabilities"])
        self.assertNotIn("10", seen)
        self.assertNotIn("01", seen)
        self.assertTrue(self._key("bell-state", "s5").startswith("It reads 1"))

    def test_the_bell_verifier_looks_at_support_only_so_a_phase_flipped_state_also_verifies(self) -> None:
        """bell-state s7's key says the check 'looks only at which outcomes occurred, not
        at phases'. Prove it: (|00> - |11>)/sqrt2 has the same support and also verifies."""
        circuit = self._circuit(2, 0, GateOp(gate="h", targets=[0]), GateOp(gate="cx", controls=[0], targets=[1]))
        s = 1 / math.sqrt(2)
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(circuit), backend="qiskit-aer", backend_version="fixture",
            execution_mode="statevector", provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED,
            payload={"execution_id": "fixture", "statevector": [[s, 0.0], [0.0, 0.0], [0.0, 0.0], [-s, 0.0]]},
        )
        self.assertEqual(verify_bell_state(circuit, record).verification_status, VerificationStatus.VERIFIED)
        self.assertIn("not at phases", self._key("bell-state", "s7"))

    def test_a_global_phase_is_invisible_to_the_bloch_vector_and_a_relative_one_is_not(self) -> None:
        """phase s7's key: multiplying BOTH amplitudes by -1 is undetectable; only one is not."""
        s = 1 / math.sqrt(2)
        base = [[s, 0.0], [s, 0.0]]
        both = [[-s, 0.0], [-s, 0.0]]
        only_beta = [[s, 0.0], [-s, 0.0]]
        self.assertEqual([round(c, 9) for c in bloch_coordinates(base)], [round(c, 9) for c in bloch_coordinates(both)])
        self.assertNotEqual([round(c, 9) for c in bloch_coordinates(base)], [round(c, 9) for c in bloch_coordinates(only_beta)])
        self.assertIn("both α and β", self._key("phase", "s7"))

    def test_the_verifier_checks_the_things_the_bell_lesson_says_it_checks(self) -> None:
        circuit = get_lesson("bell-state").linked_circuit
        result = self.aer.run(circuit, "shots", 500)
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(circuit), backend=result.backend_name, backend_version=result.backend_version,
            execution_mode=result.execution_mode, provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED, payload=result.to_payload(),
        )
        names = {c.name for c in verify_bell_state(circuit, record).checks}
        # the lesson: same circuit/result, ran successfully, canonical H->CX pattern, only 00/11 seen, both seen
        for expected in (
            "circuit_hash_matches_record", "execution_succeeded", "circuit_matches_bell_pattern",
            "observed_support_within_expected",
        ):
            self.assertIn(expected, names)
        self.assertTrue(any("coverage" in n or "expected_support" in n for n in names), names)


if __name__ == "__main__":
    unittest.main()
