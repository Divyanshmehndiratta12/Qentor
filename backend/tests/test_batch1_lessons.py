"""Quality, trust and physics tests for lessons 11–13: Superdense Coding, Quantum Teleportation and Grover's Search.

Same four groups as ``test_advanced_lessons.py``:

1. Structure and concept-check integrity (registration, prerequisites, ten sections, unique ids, answer keys).
2. Prose trust: no decimal or percentage, no claimed outcome, no multi-qubit ket, textbook algebra labelled, the deferred-
   corrections statement of the teleportation lesson, and "one small fixed example" statements.
3. The physics each lesson states, checked on the REAL Aer backend: the linked circuits, the variants the lessons ask the
   learner to build, and every concept check's answer key (a wrong key fails a test). Test-only; nothing here ships.
4. The tutor on every section (explain / simpler / hint, Hindi and Kannada wrappers, no quiz answer or rationale leaking), the
   server-side grading of every check, and the challenge and progression links.
"""

from __future__ import annotations

import itertools
import json
import math
import re
import unittest
from pathlib import Path

from qentor.challenges import CHALLENGES
from qentor.circuit.model import Circuit, GateOp
from qentor.content.validation import validate_content
from qentor.execution.adapter import AdapterUnavailable
from qentor.execution.aer import AerAdapter
from qentor.execution.trace import trace_circuit
from qentor.lessons import (
    LESSONS,
    ConceptCheckSection,
    ExplanationSection,
    InteractiveLabSection,
    ReflectionSection,
    get_lesson,
    public_lesson,
)
from qentor.lessons.grading import GradeError, grade_concept_check
from qentor.tutor import answer_lesson_aware_question, resolve_lesson_context
from tests.test_tutor_lesson import DECIMAL, EXPLAIN, HI_EXPLAIN, HINT, KN_EXPLAIN, SIMPLER, ask

BATCH1_IDS = ["superdense-coding", "quantum-teleportation", "grovers-search"]
BATCH1 = [get_lesson(lesson_id) for lesson_id in BATCH1_IDS]
CHALLENGE_FOR = {
    "superdense-coding": "superdense-encode-10",
    "quantum-teleportation": "teleport-ry-fixed",
    "grovers-search": "grover-find-01",
}

DECIMAL_OR_PERCENT = re.compile(r"\d+\.\d+|\d+\s?%")
# One section shape for all three: four explanations, a check, the lab, a check, two explanations, a reflection.
SHAPE = ["explanation"] * 4 + ["concept_check", "interactive_lab", "concept_check"] + ["explanation"] * 2 + ["reflection"]
# Pinned so a reordering is a deliberate act; the physics tests below check each one is TRUE.
ANSWER_KEYS = {
    ("superdense-coding", "s5"): "b",
    ("superdense-coding", "s7"): "d",
    ("quantum-teleportation", "s5"): "c",
    ("quantum-teleportation", "s7"): "a",
    ("grovers-search", "s5"): "d",
    ("grovers-search", "s7"): "b",
}
ANSWER_TEXT = {
    ("superdense-coding", "s5"): "always disagree",
    ("superdense-coding", "s7"): "His own half of the shared pair",
    ("quantum-teleportation", "s5"): "No definite state of its own",
    ("quantum-teleportation", "s7"): "Controlled gates applied before any measurement",
    ("grovers-search", "s5"): "Diffusion compares amplitudes with their average",
    ("grovers-search", "s7"): "one reflection about the average moves all the amplitude",
}


def _checks(lesson):
    return [s for s in lesson.sections if isinstance(s, ConceptCheckSection) and s.question is not None]


def _all_checks():
    return [(lesson, s) for lesson in BATCH1 for s in _checks(lesson)]


def _all_text(lesson) -> list[str]:
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


def _section(lesson_id: str, section_id: str):
    return next(s for s in get_lesson(lesson_id).sections if s.id == section_id)


# --------------------------------------------------------------------------- #
# 1. Structure                                                                #
# --------------------------------------------------------------------------- #


class TestBatch1Structure(unittest.TestCase):
    def test_they_are_lessons_eleven_to_thirteen_after_the_original_ten_with_stable_ids(self) -> None:
        self.assertEqual([lesson.id for lesson in LESSONS][10:13], BATCH1_IDS)  # lessons 14-16 follow (test_algorithm_lessons)
        self.assertEqual(len(LESSONS), 19)
        self.assertEqual(len({lesson.id for lesson in LESSONS}), 19)
        self.assertEqual(
            [lesson.id for lesson in LESSONS][:10],
            ["qubits-measurement", "bloch-sphere", "superposition", "phase", "interference", "entanglement", "bell-state", "phase-kickback", "deutsch-jozsa", "bernstein-vazirani"],
        )

    def test_prerequisites_are_the_ones_the_brief_names_and_all_resolve(self) -> None:
        self.assertEqual(
            {lesson.id: lesson.prerequisite_lesson_ids for lesson in BATCH1},
            {"superdense-coding": ["bell-state"], "quantum-teleportation": ["bell-state", "phase"], "grovers-search": ["interference"]},
        )
        known = {lesson.id for lesson in LESSONS}
        for lesson in BATCH1:
            self.assertTrue(set(lesson.prerequisite_lesson_ids) <= known, lesson.id)
            self.assertNotIn(lesson.id, lesson.prerequisite_lesson_ids)

    def test_each_lesson_has_ten_sections_in_the_agreed_shape_with_unique_ids(self) -> None:
        for lesson in BATCH1:
            self.assertEqual([s.type for s in lesson.sections], SHAPE, lesson.id)
            self.assertEqual([s.id for s in lesson.sections], [f"s{i}" for i in range(1, 11)], lesson.id)
            kinds = [s.type for s in lesson.sections]
            self.assertEqual((kinds.count("concept_check"), kinds.count("interactive_lab"), kinds.count("reflection")), (2, 1, 1))

    def test_difficulty_and_metadata(self) -> None:
        self.assertEqual({l.id: l.difficulty for l in BATCH1}, {"superdense-coding": "intermediate", "quantum-teleportation": "advanced", "grovers-search": "advanced"})
        for lesson in BATCH1:
            self.assertTrue(3 <= len(lesson.learning_objectives) <= 5, lesson.id)
            self.assertTrue(10 <= lesson.estimated_minutes <= 25, lesson.id)
            self.assertTrue(lesson.concept.strip())
            self.assertIsNone(lesson.no_challenge_reason, lesson.id)

    def test_explanations_are_short_paragraphs(self) -> None:
        for lesson in BATCH1:
            for s in lesson.sections:
                if isinstance(s, ExplanationSection):
                    self.assertTrue(120 <= len(s.body) <= 680, f"{lesson.id}/{s.id}: {len(s.body)} chars")
                    self.assertNotIn("\n", s.body, f"{lesson.id}/{s.id}")

    def test_the_lab_points_at_the_backend_execute_capability(self) -> None:
        for lesson in BATCH1:
            (lab,) = [s for s in lesson.sections if isinstance(s, InteractiveLabSection)]
            self.assertEqual(lab.capability, "execute", lesson.id)
            self.assertIn("backend", lab.instructions.lower(), lesson.id)

    def test_no_lab_sends_the_learner_to_read_amplitudes_from_a_measured_statevector_run(self) -> None:
        # a statevector run of a circuit that ends in a measurement is one COLLAPSED state (the Lab says so); the states live in the trace
        for lesson in BATCH1:
            self.assertEqual(lesson.linked_circuit.ops[-1].gate.value, "measure", lesson.id)
            (lab,) = [s for s in lesson.sections if isinstance(s, InteractiveLabSection)]
            self.assertNotIn("statevector mode and look at the amplitudes", lab.instructions, lesson.id)
            self.assertIn("trace", lab.instructions.lower(), lesson.id)
        teleport = _section("quantum-teleportation", "s6").instructions
        self.assertIn("shots mode", teleport)  # the one probabilistic readout is read from sampled shots
        self.assertIn("collapsed", teleport)

    def test_the_linked_circuits_are_the_fixed_examples(self) -> None:
        def ops(lesson_id):
            return [(o.gate.value, list(o.controls), list(o.targets), list(o.params), list(o.clbits)) for o in get_lesson(lesson_id).linked_circuit.ops]

        self.assertEqual(
            ops("superdense-coding"),
            [("h", [], [0], [], []), ("cx", [0], [1], [], []), ("x", [], [0], [], []), ("cx", [0], [1], [], []), ("h", [], [0], [], []), ("measure", [], [0], [], [0]), ("measure", [], [1], [], [1])],
        )
        self.assertEqual(
            ops("quantum-teleportation"),
            [
                ("ry", [], [0], [1.0], []), ("h", [], [1], [], []), ("cx", [1], [2], [], []), ("cx", [0], [1], [], []), ("h", [], [0], [], []),
                ("cx", [1], [2], [], []), ("cz", [0], [2], [], []), ("measure", [], [2], [], [0]),
            ],
        )  # fmt: skip
        self.assertEqual(len(get_lesson("grovers-search").linked_circuit.ops), 16)
        self.assertEqual(
            [(get_lesson(i).linked_circuit.num_qubits, get_lesson(i).linked_circuit.num_clbits) for i in BATCH1_IDS], [(2, 2), (3, 1), (2, 2)]
        )

    def test_the_circuits_use_no_mid_circuit_measurement_and_only_gates_the_model_supports(self) -> None:
        for lesson in BATCH1:
            ops = lesson.linked_circuit.ops
            first_measure = next((i for i, o in enumerate(ops) if o.gate.value == "measure"), len(ops))
            self.assertTrue(all(o.gate.value == "measure" for o in ops[first_measure:]), lesson.id)

    def test_every_check_has_exactly_one_correct_option_pinned_to_its_answer(self) -> None:
        self.assertEqual(len(_all_checks()), 6)
        self.assertEqual({(lesson.id, s.id) for lesson, s in _all_checks()}, set(ANSWER_KEYS))
        for lesson, s in _all_checks():
            ConceptCheckSection.model_validate(s.model_dump())
            ids = [o.id for o in s.options]
            self.assertEqual(sorted(ids), ["a", "b", "c", "d"], f"{lesson.id}/{s.id}")
            self.assertEqual(s.correct_option_id, ANSWER_KEYS[(lesson.id, s.id)])
            correct = next(o.text for o in s.options if o.id == s.correct_option_id)
            self.assertIn(ANSWER_TEXT[(lesson.id, s.id)], correct, f"{lesson.id}/{s.id}")
            self.assertEqual(s.concept, lesson.concept)

    def test_options_are_real_distinct_and_the_answer_is_not_a_tell(self) -> None:
        for lesson, s in _all_checks():
            texts = [o.text.strip() for o in s.options]
            self.assertTrue(all(len(t) >= 8 for t in texts), f"{lesson.id}/{s.id}")
            self.assertEqual(len({t.lower() for t in texts}), 4, f"{lesson.id}/{s.id}")
            correct = next(o.text for o in s.options if o.id == s.correct_option_id)
            self.assertNotIn(correct.lower(), (s.question + " " + s.prompt).lower())
            self.assertTrue(s.question.strip().endswith("?"))
            self.assertGreaterEqual(len(s.explanation), 160)
            self.assertGreaterEqual(s.explanation.count("."), 2)
        keys = [s.correct_option_id for _, s in _all_checks()]
        self.assertGreaterEqual(len(set(keys)), 4, keys)
        longest = sum(1 for _, s in _all_checks() if len(next(o.text for o in s.options if o.id == s.correct_option_id)) == max(len(o.text) for o in s.options))
        self.assertLessEqual(longest, 3, "the correct option is the longest too often")

    def test_the_two_checks_of_a_lesson_test_different_things(self) -> None:
        for lesson in BATCH1:
            first, second = _checks(lesson)
            self.assertNotEqual(first.question, second.question)
            self.assertFalse({o.text for o in first.options} & {o.text for o in second.options}, lesson.id)

    def test_the_served_catalog_carries_the_new_lessons_without_keys_or_explanations(self) -> None:
        from qentor.api import app as app_module

        served = {lesson.id: lesson for lesson in app_module.list_lessons().lessons}
        self.assertEqual(len(served), 19)
        for lesson in BATCH1:
            self.assertEqual([s.model_dump() for s in served[lesson.id].sections], [s.model_dump() for s in public_lesson(lesson).sections])
            blob = json.dumps(served[lesson.id].model_dump(mode="json"))
            self.assertNotIn("correct_option_id", blob)
            for check in _checks(lesson):
                self.assertNotIn(check.explanation, blob)


# --------------------------------------------------------------------------- #
# 2. Prose trust                                                              #
# --------------------------------------------------------------------------- #


class TestBatch1ProseNeverLooksLikeAResult(unittest.TestCase):
    def test_no_decimal_or_percentage_anywhere_in_a_lesson(self) -> None:
        for lesson in BATCH1:
            for text in _all_text(lesson):
                self.assertFalse(DECIMAL_OR_PERCENT.search(text), f"{lesson.id}: {text[:80]!r}")

    def test_no_text_claims_a_run_produced_a_particular_outcome(self) -> None:
        pattern = re.compile(r"(the backend (returned|reported|measured)|you (got|measured|saw) (a |an )?\d|our run|in our experiment)", re.I)
        for lesson in BATCH1:
            for text in _all_text(lesson):
                self.assertIsNone(pattern.search(text), f"{lesson.id}: {text[:80]!r}")

    def test_no_multi_qubit_ket_so_no_bit_order_is_left_unstated(self) -> None:
        for lesson in BATCH1:
            for text in _all_text(lesson):
                self.assertIsNone(re.search(r"\|[01]{2,}⟩", text), f"{lesson.id}: {text[:80]!r}")

    def test_bit_strings_are_always_stated_in_qentors_order(self) -> None:
        for lesson_id, section_id in (("superdense-coding", "s3"), ("grovers-search", "s2")):
            self.assertIn("q1 q0", _section(lesson_id, section_id).body)
            self.assertIn("highest-numbered qubit on the left", _section(lesson_id, section_id).body)

    def test_the_deck_illustrative_numbers_never_appear(self) -> None:
        for lesson in BATCH1:
            for forbidden in ("71 of 72", "71/72"):
                self.assertNotIn(forbidden, " ".join(_all_text(lesson)))

    def test_worked_algebra_is_labelled_textbook(self) -> None:
        for lesson_id, section_id in (("superdense-coding", "s4"), ("quantum-teleportation", "s3"), ("grovers-search", "s3"), ("grovers-search", "s8")):
            self.assertIn("textbook", _section(lesson_id, section_id).body.lower(), f"{lesson_id}/{section_id}")

    def test_each_lesson_says_it_is_one_small_fixed_example(self) -> None:
        self.assertIn("ONE small fixed circuit", _section("superdense-coding", "s1").body)
        self.assertIn("ONE fixed 3-qubit example", _section("quantum-teleportation", "s1").body)
        grover = _section("grovers-search", "s1").body
        self.assertIn("ONE small educational example", grover)
        self.assertIn("does not show a scalable speed-up", grover)
        self.assertIn("not a general search tool", grover)

    def test_teleportation_says_clearly_that_its_corrections_are_deferred_and_not_the_full_protocol(self) -> None:
        body = _section("quantum-teleportation", "s2").body
        for needle in ("NO mid-circuit measurement", "NO classical control", "DEFERRED", "not the full dynamic protocol", "classical communication", "does not claim to be"):
            self.assertIn(needle, body, needle)
        self.assertIn("deferred", get_lesson("quantum-teleportation").short_description)
        self.assertIn("deferred", " ".join(_all_text(get_lesson("quantum-teleportation"))).lower())
        # the lab repeats it, and the second check tests it
        self.assertIn("deferred", _section("quantum-teleportation", "s6").instructions)
        self.assertIn("deferred corrections", _section("quantum-teleportation", "s7").question)

    def test_no_teleportation_text_claims_the_dynamic_protocol_runs_here(self) -> None:
        text = " ".join(_all_text(get_lesson("quantum-teleportation"))).lower()
        for claim in ("measures q0 and q1 in this circuit", "classical bits are sent in this", "this circuit sends classical", "full dynamic protocol runs"):
            self.assertNotIn(claim, text)
        self.assertNotIn("faster than light", text.replace("cannot signal faster than light", ""))  # only ever denied

    def test_teleportation_explains_the_reduced_state_reading_of_the_spheres(self) -> None:
        body = _section("quantum-teleportation", "s9").body
        for needle in ("own Bloch sphere", "reduced state", "length zero", "not an error"):
            self.assertIn(needle, body, needle)

    def test_the_tutor_topics_each_lesson_must_cover_are_in_its_prose(self) -> None:
        text = {lesson.id: " ".join(_all_text(lesson)).lower() for lesson in BATCH1}
        titles = {lesson.id: " | ".join(s.title.lower() for s in lesson.sections) for lesson in BATCH1}
        for needle in ("x and z", "shared entangled pair", "actually transmitted"):
            self.assertIn(needle, titles["superdense-coding"], needle)
        for needle in ("moving a state", "entanglement and corrections", "faster-than-light", "deferred corrections"):
            self.assertIn(needle, titles["quantum-teleportation"], needle)
        for needle in ("oracle changes a phase", "diffusion", "why one iteration is enough"):
            self.assertIn(needle, titles["grovers-search"], needle)
        self.assertIn("cannot signal faster than light", text["quantum-teleportation"])

    def test_grover_says_the_marked_item_and_the_oracle_in_the_fixed_example(self) -> None:
        self.assertIn("The marked item in this lesson is 01: q1 is 0 and q0 is 1", _section("grovers-search", "s2").body)
        self.assertIn("X on q1 comes before it and again after", _section("grovers-search", "s3").body)


# --------------------------------------------------------------------------- #
# 3. The physics the lessons state, on the real backend                       #
# --------------------------------------------------------------------------- #


def _g(gate, target, controls=(), clbits=(), params=()):
    return GateOp(gate=gate, targets=[target], controls=list(controls), clbits=list(clbits), params=list(params))


def _complex(state):
    return [complex(re_, im) for re_, im in state]


def _overlap(a, b) -> float:
    return abs(sum(x.conjugate() * y for x, y in zip(a, b)))


def _reduced(state, n, qubit):
    rho = [[0j, 0j], [0j, 0j]]
    for i, amp_i in enumerate(state):
        for j, amp_j in enumerate(state):
            if all(((i >> q) & 1) == ((j >> q) & 1) for q in range(n) if q != qubit):
                rho[(i >> qubit) & 1][(j >> qubit) & 1] += amp_i * amp_j.conjugate()
    return rho


def _purity(state, n, qubit) -> float:
    rho = _reduced(state, n, qubit)
    return sum((rho[i][j] * rho[j][i]).real for i in range(2) for j in range(2))


def _bloch(state, n, qubit):
    rho = _reduced(state, n, qubit)
    return (2 * rho[0][1].real, -2 * rho[0][1].imag, (rho[0][0] - rho[1][1]).real)


class _Backend(unittest.TestCase):
    def setUp(self) -> None:
        self.aer = AerAdapter()
        try:
            self.aer.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(f"qiskit-aer unavailable: {exc}")
        except Exception:
            pass

    def sv(self, n, *ops) -> list[complex]:
        return _complex(self.aer.run(Circuit(num_qubits=n, num_clbits=0, ops=list(ops)), "statevector").to_payload()["statevector"])

    def shots(self, circuit: Circuit) -> dict[str, float]:
        return self.aer.run(circuit, "shots", 2000).to_payload()["probabilities"]

    def final_state(self, circuit: Circuit) -> list[complex]:
        trace = trace_circuit(circuit, self.aer, mode="statevector", max_qubits=4, max_operations=32)
        return _complex(trace.steps[-1].statevector)

    def assertSameUpToPhase(self, a, b, msg=None) -> None:
        self.assertAlmostEqual(_overlap(a, b), 1.0, places=9, msg=msg)


BELL = [_g("h", 0), _g("cx", 1, [0])]
DECODER = [_g("cx", 1, [0]), _g("h", 0)]


class TestSuperdensePhysics(_Backend):
    def encode(self, *encoding) -> Circuit:
        ops = [*BELL, *encoding, *DECODER, _g("measure", 0, clbits=[0]), _g("measure", 1, clbits=[1])]
        return Circuit(num_qubits=2, num_clbits=2, ops=ops)

    def measured(self, *encoding) -> set[str]:
        """The outcomes a measurement of the bare pair (no decoder) after ``encoding`` can give, as q1 q0 strings."""
        ops = [*BELL, *encoding, _g("measure", 0, clbits=[0]), _g("measure", 1, clbits=[1])]
        return set(self.shots(Circuit(num_qubits=2, num_clbits=2, ops=ops)))

    def test_the_lab_circuit_is_message_10_and_reads_10_every_time(self) -> None:
        lab = get_lesson("superdense-coding").linked_circuit
        self.assertEqual(lab.ops, self.encode(_g("x", 0)).ops)
        self.assertEqual(self.shots(lab), {"10": 1.0})  # q1 q0: Qentor's order

    def test_s3_the_four_encodings_give_the_four_messages_with_x_the_left_bit_and_z_the_right(self) -> None:
        for message, encoding in (("00", []), ("10", [_g("x", 0)]), ("01", [_g("z", 0)]), ("11", [_g("z", 0), _g("x", 0)])):
            with self.subTest(message=message):
                self.assertEqual(self.shots(self.encode(*encoding)), {message: 1.0})

    def test_s2_the_four_encoded_pairs_are_four_distinguishable_states(self) -> None:
        states = [self.sv(2, *BELL, *enc) for enc in ([], [_g("x", 0)], [_g("z", 0)], [_g("z", 0), _g("x", 0)])]
        for (i, a), (j, b) in itertools.combinations(enumerate(states), 2):
            self.assertAlmostEqual(_overlap(a, b), 0.0, places=9, msg=f"{i} vs {j}")

    def test_s2_the_pair_alone_always_agrees_and_each_qubit_alone_is_undetermined(self) -> None:
        self.assertEqual(self.measured(), {"00", "11"})
        pair = self.sv(2, *BELL)
        for qubit in (0, 1):
            self.assertAlmostEqual(_purity(pair, 2, qubit), 0.5, places=9)

    def test_s4_x_turns_agree_into_disagree_and_z_changes_only_the_sign(self) -> None:
        self.assertEqual(self.measured(), {"00", "11"})
        self.assertEqual(self.measured(_g("x", 0)), {"01", "10"})  # X: always disagree
        self.assertEqual(self.measured(_g("z", 0)), {"00", "11"})  # Z: the odds are untouched ...
        bell, z_bell = self.sv(2, *BELL), self.sv(2, *BELL, _g("z", 0))
        self.assertAlmostEqual(_overlap(bell, z_bell), 0.0, places=9)  # ... yet it is a different state
        self.assertAlmostEqual((z_bell[0] / bell[0]).real, 1.0, places=9)
        self.assertAlmostEqual((z_bell[3] / bell[3]).real, -1.0, places=9)  # the sign between the two parts flipped

    def test_answer_key_s5_b_is_true_and_the_distractors_are_false(self) -> None:
        after_x = self.sv(2, *BELL, _g("x", 0))
        self.assertEqual(self.measured(_g("x", 0)), {"01", "10"})  # b (correct): agreed before, always disagree now
        self.assertAlmostEqual(_purity(after_x, 2, 0), 0.5, places=9)  # a false: still entangled, the results are still related
        self.assertNotEqual(self.measured(_g("x", 0)), self.measured(_g("z", 0)))  # c false: the odds DID change (that is Z)
        self.assertLess(_purity(after_x, 2, 1), 0.99)  # d false: the pair did not split into independent qubits

    def test_answer_key_s7_d_a_qubit_alone_carries_no_message_and_bob_needs_his_half(self) -> None:
        # the qubit Alice sends is maximally mixed for EVERY message: on its own it says nothing
        for enc in ([], [_g("x", 0)], [_g("z", 0)], [_g("z", 0), _g("x", 0)]):
            state = self.sv(2, *BELL, *enc)
            self.assertAlmostEqual(_purity(state, 2, 0), 0.5, places=9)
            x, y, z = _bloch(state, 2, 0)
            self.assertAlmostEqual(math.sqrt(x * x + y * y + z * z), 0.0, places=9)
        # with Bob's half the decoder reads each message (s3), and only the two qubits together are decoded: d. Nothing else was
        # sent (b and c are false): the decoder circuit has exactly the two qubits and no classical input.
        self.assertEqual((self.encode(_g("x", 0)).num_qubits, self.encode(_g("x", 0)).num_clbits), (2, 2))

    def test_s8_the_decoder_is_the_same_gates_for_every_message(self) -> None:
        for enc in ([], [_g("x", 0)], [_g("z", 0)]):
            self.assertEqual(self.encode(*enc).ops[-4:-2], DECODER)

    def test_the_trace_of_the_lab_shows_an_entangled_pair_after_the_encoding(self) -> None:
        trace = trace_circuit(get_lesson("superdense-coding").linked_circuit, self.aer, mode="statevector", max_qubits=4, max_operations=32)
        after_encoding = _complex(trace.steps[3].statevector)  # initial, H, CX, X
        self.assertAlmostEqual(_purity(after_encoding, 2, 0), 0.5, places=9)
        self.assertAlmostEqual(_purity(_complex(trace.steps[-1].statevector), 2, 0), 1.0, places=9)  # decoded: each qubit definite
        self.assertEqual(len(trace.terminal_measurements), 2)


class TestTeleportationPhysics(_Backend):
    ANGLE = 1.0

    def circuit(self, angle=ANGLE, *, corrections=True):
        ops = [_g("ry", 0, params=[angle]), _g("h", 1), _g("cx", 2, [1]), _g("cx", 1, [0]), _g("h", 0)]
        if corrections:
            ops += [_g("cx", 2, [1]), _g("cz", 2, [0])]
        return ops

    def test_the_lab_circuit_is_the_fixed_example_and_delivers_the_message_to_q2(self) -> None:
        lab = get_lesson("quantum-teleportation").linked_circuit
        state = self.final_state(lab)
        message = self.sv(1, _g("ry", 0, params=[self.ANGLE]))
        x, y, z = _bloch(state, 3, 2)
        mx, my, mz = _bloch(message, 1, 0)
        for got, want in ((x, mx), (y, my), (z, mz)):
            self.assertAlmostEqual(got, want, places=9)
        self.assertAlmostEqual(_purity(state, 3, 2), 1.0, places=9)  # q2 is in a state of its own

    def test_the_lab_measures_only_q2_and_it_reads_the_message_odds(self) -> None:
        lab = get_lesson("quantum-teleportation").linked_circuit
        shots = self.aer.run(lab, "shots", 6000).to_payload()["probabilities"]
        self.assertEqual(set(shots), {"0", "1"})
        self.assertAlmostEqual(shots["1"], math.sin(self.ANGLE / 2) ** 2, delta=0.04)  # sampled: close, not equal

    def test_s5_answer_c_before_the_corrections_q2_alone_has_no_definite_state(self) -> None:
        before = self.sv(3, *self.circuit(corrections=False))
        self.assertAlmostEqual(_purity(before, 3, 2), 0.5, places=9)  # c: half of an entangled pair
        x, y, z = _bloch(before, 3, 2)
        self.assertAlmostEqual(math.sqrt(x * x + y * y + z * z), 0.0, places=9)
        # a false (no copy of the message), b false (not |0>: it IS entangled), d false (no definite angle to undo alone)
        message = self.sv(1, _g("ry", 0, params=[self.ANGLE]))
        self.assertGreater(abs(_bloch(message, 1, 0)[0]), 0.1)  # the message has a definite direction; q2 has none

    def test_s8_before_the_corrections_bobs_qubit_is_blind_whatever_the_message(self) -> None:
        for angle in (0.3, 1.0, 2.5, math.pi):
            with self.subTest(angle=angle):
                self.assertAlmostEqual(_purity(self.sv(3, *self.circuit(angle, corrections=False)), 3, 2), 0.5, places=9)

    def test_the_same_circuit_teleports_any_message_not_just_the_fixed_one(self) -> None:
        for angle in (0.3, 1.0, 2.5):
            with self.subTest(angle=angle):
                after = self.sv(3, *self.circuit(angle))
                want = _bloch(self.sv(1, _g("ry", 0, params=[angle])), 1, 0)
                for got, expected in zip(_bloch(after, 3, 2), want):
                    self.assertAlmostEqual(got, expected, places=9)

    def test_without_the_corrections_bob_is_left_with_no_message(self) -> None:
        after = self.sv(3, *self.circuit(corrections=False))
        self.assertLess(_purity(after, 3, 2), 0.99)

    def test_s7_deferred_corrections_give_the_same_state_as_measure_then_correct(self) -> None:
        # the lesson's claim, checked by hand: for each of Alice's four possible results, take Bob's conditional state from the
        # pre-correction statevector, apply the X then Z the dynamic protocol would apply for that result, and compare.
        before = self.sv(3, *self.circuit(corrections=False))
        want = self.sv(1, _g("ry", 0, params=[self.ANGLE]))
        for m0, m1 in itertools.product((0, 1), repeat=2):
            conditional = [before[(m0 << 0) | (m1 << 1) | (b << 2)] for b in (0, 1)]
            weight = sum(abs(a) ** 2 for a in conditional)
            self.assertAlmostEqual(weight, 0.25, places=9, msg=f"outcome {m0}{m1} is one of four equally likely results")
            bob = [a / math.sqrt(weight) for a in conditional]
            if m1:
                bob = [bob[1], bob[0]]  # X
            if m0:
                bob = [bob[0], -bob[1]]  # Z
            self.assertSameUpToPhase(bob, want, f"outcome q0={m0} q1={m1}")

    def test_s8_the_message_is_not_copied_alices_qubits_end_in_a_different_state(self) -> None:
        after = self.sv(3, *self.circuit())
        message = _bloch(self.sv(1, _g("ry", 0, params=[self.ANGLE])), 1, 0)
        for qubit in (0, 1):
            bloch = _bloch(after, 3, qubit)
            self.assertAlmostEqual(math.sqrt(sum(c * c for c in bloch)), 1.0, places=9)  # s9: left in states of their own
            self.assertGreater(math.dist(bloch, message), 0.1)  # and not the message

    def test_s9_while_entangled_a_qubits_arrow_has_length_zero(self) -> None:
        mid = self.sv(3, _g("ry", 0, params=[self.ANGLE]), _g("h", 1), _g("cx", 2, [1]), _g("cx", 1, [0]))
        for qubit in (0, 1, 2):
            self.assertLess(_purity(mid, 3, qubit), 0.99, f"q{qubit}")

    def test_the_circuit_model_really_has_no_mid_circuit_measurement(self) -> None:
        from qentor.execution.trace import TraceNotSupported

        mid = Circuit(num_qubits=3, num_clbits=1, ops=[*self.circuit(corrections=False), _g("measure", 0, clbits=[0]), _g("cx", 2, [1])])
        with self.assertRaises(TraceNotSupported):
            trace_circuit(mid, self.aer, mode="statevector", max_qubits=4, max_operations=32)

    def test_answer_key_s7_a_is_the_one_that_describes_this_circuit(self) -> None:
        lab = get_lesson("quantum-teleportation").linked_circuit
        gates = [o.gate.value for o in lab.ops]
        corrections = lab.ops[5:7]
        self.assertEqual([(o.gate.value, o.controls) for o in corrections], [("cx", [1]), ("cz", [0])])  # controlled gates, not classical control
        self.assertEqual(gates.count("measure"), 1)  # one terminal measurement, of q2 only
        self.assertEqual(lab.ops[-1].gate.value, "measure")  # b/c/d false: nothing measured mid-circuit, nothing left out


class TestGroverPhysics(_Backend):
    ORACLES = {
        "00": [_g("x", 0), _g("x", 1), _g("cz", 1, [0]), _g("x", 0), _g("x", 1)],
        "01": [_g("x", 1), _g("cz", 1, [0]), _g("x", 1)],
        "10": [_g("x", 0), _g("cz", 1, [0]), _g("x", 0)],
        "11": [_g("cz", 1, [0])],
    }
    DIFFUSION = [_g("h", 0), _g("h", 1), _g("x", 0), _g("x", 1), _g("cz", 1, [0]), _g("x", 0), _g("x", 1), _g("h", 0), _g("h", 1)]
    PREPARE = [_g("h", 0), _g("h", 1)]

    def probs(self, state) -> dict[str, float]:
        return {format(i, "02b"): abs(a) ** 2 for i, a in enumerate(state)}

    def test_the_lab_circuit_finds_the_marked_item_01_every_time(self) -> None:
        lab = get_lesson("grovers-search").linked_circuit
        self.assertEqual(lab.ops[:14], [*self.PREPARE, *self.ORACLES["01"], *self.DIFFUSION])
        self.assertEqual(self.shots(lab), {"01": 1.0})  # q1 q0

    def test_s2_the_even_start_makes_all_four_items_equally_likely(self) -> None:
        for item, p in self.probs(self.sv(2, *self.PREPARE)).items():
            self.assertAlmostEqual(p, 0.25, places=9, msg=item)

    def test_s3_the_oracle_flips_only_the_marked_amplitudes_sign_and_a_measurement_cannot_see_it(self) -> None:
        start = self.sv(2, *self.PREPARE)
        after = self.sv(2, *self.PREPARE, *self.ORACLES["01"])
        for item, p in self.probs(after).items():
            self.assertAlmostEqual(p, 0.25, places=9, msg=item)  # the odds did not change
        for index, (a, b) in enumerate(zip(start, after)):
            ratio = (b / a).real
            self.assertAlmostEqual(ratio, -1.0 if index == 1 else 1.0, places=9, msg=f"index {index}")  # index 1 = q1 0, q0 1 = item 01

    def test_s4_diffusion_turns_the_sign_into_the_marked_items_amplitude(self) -> None:
        probs = self.probs(self.sv(2, *self.PREPARE, *self.ORACLES["01"], *self.DIFFUSION))
        self.assertAlmostEqual(probs["01"], 1.0, places=9)
        for item in ("00", "10", "11"):
            self.assertAlmostEqual(probs[item], 0.0, places=9)

    def test_s4_the_diffusion_never_needs_to_know_which_item_is_marked(self) -> None:
        for item, oracle in self.ORACLES.items():
            with self.subTest(marked=item):
                self.assertAlmostEqual(self.probs(self.sv(2, *self.PREPARE, *oracle, *self.DIFFUSION))[item], 1.0, places=9)

    def test_answer_key_s5_d_without_the_oracle_diffusion_has_nothing_to_amplify(self) -> None:
        start = self.sv(2, *self.PREPARE)
        self.assertSameUpToPhase(self.sv(2, *self.PREPARE, *self.DIFFUSION), start)  # c false: the reflection changes nothing
        after_oracle = self.probs(self.sv(2, *self.PREPARE, *self.ORACLES["01"]))
        self.assertAlmostEqual(after_oracle["01"], 0.25, places=9)  # a false: not more likely straight away
        # b false: the item stays where it is: the marked item is still 01, not another bit string
        self.assertAlmostEqual(self.probs(self.sv(2, *self.PREPARE, *self.ORACLES["01"], *self.DIFFUSION))["01"], 1.0, places=9)

    def test_answer_key_s7_b_one_iteration_is_exact_for_four_items_and_a_second_overshoots(self) -> None:
        once = self.probs(self.sv(2, *self.PREPARE, *self.ORACLES["01"], *self.DIFFUSION))["01"]
        twice = self.probs(self.sv(2, *self.PREPARE, *self.ORACLES["01"], *self.DIFFUSION, *self.ORACLES["01"], *self.DIFFUSION))["01"]
        self.assertAlmostEqual(once, 1.0, places=9)  # b
        self.assertLess(twice, 0.999)  # the overshoot the explanation mentions: a second pass makes it worse
        # a false: the oracle alone leaves the item at its start odds (see s5); c false: shown just below; d false: two qubits can run it
        self.assertAlmostEqual(self.probs(self.sv(2, *self.PREPARE, *self.ORACLES["01"]))["01"], 0.25, places=9)

    def test_s8_c_with_more_items_one_iteration_only_goes_part_of_the_way(self) -> None:
        # 3 qubits, 8 items, marked item 111: oracle = CCZ (H, CCX, H on the last qubit); diffusion = H X CCZ X H on all three
        def ccz():
            return [_g("h", 2), _g("ccx", 2, [0, 1]), _g("h", 2)]

        def layer(gate):
            return [_g(gate, q) for q in range(3)]

        iteration = [*ccz(), *layer("h"), *layer("x"), *ccz(), *layer("x"), *layer("h")]
        one = self.sv(3, *layer("h"), *iteration)
        two = self.sv(3, *layer("h"), *iteration, *iteration)
        p_one, p_two = abs(one[7]) ** 2, abs(two[7]) ** 2
        self.assertGreater(p_one, 0.5)
        self.assertLess(p_one, 0.99)  # part of the way, not all of it
        self.assertGreater(p_two, p_one)  # and further iterations help, at this size

    def test_s9_the_oracle_moves_the_phase_arrow_and_not_the_size_and_diffusion_grows_the_size(self) -> None:
        trace = trace_circuit(get_lesson("grovers-search").linked_circuit, self.aer, mode="statevector", max_qubits=4, max_operations=32)
        after_prep, after_oracle, final = (_complex(trace.steps[i].statevector) for i in (2, 5, 14))
        self.assertAlmostEqual(abs(after_oracle[1]), abs(after_prep[1]), places=9)  # size unchanged
        self.assertAlmostEqual(math.cos(math.atan2(after_oracle[1].imag, after_oracle[1].real) - math.atan2(after_prep[1].imag, after_prep[1].real)), -1.0, places=9)  # phase turned by half a turn
        self.assertGreater(abs(final[1]), abs(after_oracle[1]) + 0.4)  # and diffusion made it bigger


# --------------------------------------------------------------------------- #
# 4. Tutor, grading, challenges and progression                               #
# --------------------------------------------------------------------------- #


class TestBatch1WithTheTutor(unittest.TestCase):
    def _ask(self, question, lesson_id, section_id, language="en"):
        ctx = resolve_lesson_context(lesson_id, section_id)
        return answer_lesson_aware_question(question, ctx, [], None, None, language)[0]

    @staticmethod
    def _teaching(lesson) -> str:
        return " ".join(s.body for s in lesson.sections if isinstance(s, ExplanationSection))

    def test_every_section_resolves_and_explain_simpler_and_hint_work_everywhere(self) -> None:
        swept = 0
        for lesson in BATCH1:
            for section in lesson.sections:
                for question, marker in ((EXPLAIN, "About this part of the lesson:"), (SIMPLER, "In short:"), (HINT, "A hint:")):
                    answer = self._ask(question, lesson.id, section.id)
                    swept += 1
                    self.assertTrue(answer.startswith(marker), f"{lesson.id}/{section.id}/{question}: {answer[:60]}")
                    self.assertFalse(DECIMAL.search(answer), f"{lesson.id}/{section.id}/{question}")
        self.assertEqual(swept, 3 * 10 * 3)

    def test_answers_stay_compact(self) -> None:
        for lesson in BATCH1:
            for section in lesson.sections:
                for question in (EXPLAIN, SIMPLER, HINT):
                    limit = 2200 if question == EXPLAIN else 1500
                    self.assertLess(len(self._ask(question, lesson.id, section.id)), limit, f"{lesson.id}/{section.id}/{question}")

    def test_a_hint_on_a_check_points_at_the_nearest_explanation_and_the_first_objective(self) -> None:
        for lesson in BATCH1:
            for index, section in enumerate(lesson.sections):
                if isinstance(section, ConceptCheckSection):
                    nearest = [s for s in lesson.sections[:index] if isinstance(s, ExplanationSection)][-1]
                    answer = self._ask(HINT, lesson.id, section.id)
                    self.assertIn(nearest.body, answer, f"{lesson.id}/{section.id}")
                    self.assertIn(lesson.learning_objectives[0], answer, f"{lesson.id}/{section.id}")

    def test_the_section_local_supporting_material_is_selected_correctly(self) -> None:
        for lesson in BATCH1:
            for index, section in enumerate(lesson.sections):
                if isinstance(section, (ConceptCheckSection, InteractiveLabSection, ReflectionSection)):
                    material = [f for f in resolve_lesson_context(lesson.id, section.id).facts if f.kind == "lesson_material"]
                    nearest = [s for s in lesson.sections[:index] if isinstance(s, ExplanationSection)][-2:]
                    self.assertEqual(len(material), len(nearest), f"{lesson.id}/{section.id}")

    def test_no_answer_fact_or_response_leaks_a_correct_option_or_rationale(self) -> None:
        checked = 0
        for lesson in BATCH1:
            teaching = self._teaching(lesson)
            for check in _checks(lesson):
                self.assertNotIn(check.explanation, teaching, f"{lesson.id}/{check.id}")
                correct = next(o.text for o in check.options if o.id == check.correct_option_id)
                for section in lesson.sections:
                    ctx = resolve_lesson_context(lesson.id, section.id)
                    facts = " ".join(f.description for f in ctx.facts)
                    self.assertNotIn(check.explanation, facts, f"{lesson.id}/{section.id}")
                    self.assertNotIn(check.explanation, ctx.topic_text, f"{lesson.id}/{section.id}")
                    if correct not in teaching:
                        self.assertNotIn(correct, facts, f"{lesson.id}/{section.id}")
                    for question in (EXPLAIN, SIMPLER, HINT):
                        answer = self._ask(question, lesson.id, section.id)
                        self.assertNotIn(check.explanation, answer, f"{lesson.id}/{section.id}/{question}")
                        if correct not in teaching:
                            self.assertNotIn(correct, answer, f"{lesson.id}/{section.id}/{question}")
                checked += 1
        self.assertEqual(checked, 6)

    def test_the_whole_endpoint_response_for_a_check_carries_no_answer_key(self) -> None:
        for lesson in BATCH1:
            for check in _checks(lesson):
                blob = ask(question=HINT, lesson_id=lesson.id, section_id=check.id).model_dump_json()
                self.assertNotIn(check.explanation, blob, f"{lesson.id}/{check.id}")
                self.assertNotIn("correct_option", blob)
                self.assertNotIn("correctOption", blob)
                for option in check.options:
                    if option.text not in self._teaching(lesson):
                        self.assertNotIn(option.text, blob, f"{lesson.id}/{check.id}/{option.id}")

    def test_the_endpoint_answers_carry_the_lesson_and_no_quantum_provenance(self) -> None:
        for lesson in BATCH1:
            response = ask(question=EXPLAIN, lesson_id=lesson.id, section_id="s2")
            self.assertEqual((response.lesson_id, response.section_id), (lesson.id, "s2"))
            self.assertIsNone(response.result_id)
            self.assertIsNone(response.provenance_class)
            self.assertIsNone(response.trace_step)
            self.assertTrue(all(f.id.startswith("L") for f in response.facts))

    def test_hindi_and_kannada_wrap_english_lesson_prose_quoted_verbatim(self) -> None:
        for lesson in BATCH1:
            for section in (lesson.sections[0], lesson.sections[3], lesson.sections[8]):
                hi = self._ask(EXPLAIN, lesson.id, section.id, "hi")
                kn = self._ask(EXPLAIN, lesson.id, section.id, "kn")
                self.assertIn(HI_EXPLAIN, hi)
                self.assertIn(KN_EXPLAIN, kn)
                self.assertIn(section.body, hi, f"{lesson.id}/{section.id}")
                self.assertIn(section.body, kn, f"{lesson.id}/{section.id}")

    def test_the_topic_questions_the_brief_names_are_answered_from_the_matching_section(self) -> None:
        cases = [
            ("Why do X and Z give different Bell states?", "superdense-coding", "s4"),
            ("Why does a shared entangled pair let this work?", "superdense-coding", "s2"),
            ("What is actually transmitted?", "superdense-coding", "s9"),
            ("What does teleportation transmit and what does it not?", "quantum-teleportation", "s1"),
            ("What is the role of entanglement in teleportation?", "quantum-teleportation", "s4"),
            ("Why are the corrections deferred here?", "quantum-teleportation", "s2"),
            ("Why is there no faster-than-light signalling?", "quantum-teleportation", "s8"),
            ("Why does the oracle change a phase?", "grovers-search", "s3"),
            ("Why does diffusion increase the marked amplitude?", "grovers-search", "s4"),
            ("Why does one iteration suffice for four items?", "grovers-search", "s8"),
        ]
        for question, lesson_id, section_id in cases:
            with self.subTest(question=question):
                answer = self._ask(question, lesson_id, section_id)
                self.assertTrue(answer.startswith("About this part of the lesson:"), answer[:80])
                self.assertIn(_section(lesson_id, section_id).body, answer)

    def test_a_lesson_question_never_carries_a_lab_result_or_a_trace_step(self) -> None:
        for lesson in BATCH1:
            response = ask(question=HINT, lesson_id=lesson.id, section_id="s6")
            self.assertIsNone(response.trace_step)
            self.assertIsNone(response.result_id)

    def test_no_tutor_source_file_contains_any_batch1_lesson_prose(self) -> None:
        tutor_dir = Path(__file__).resolve().parents[1] / "qentor" / "tutor"
        source = "\n".join(p.read_text(encoding="utf-8") for p in tutor_dir.glob("*.py"))
        for lesson in BATCH1:
            for s in lesson.sections:
                if isinstance(s, ExplanationSection):
                    for start in range(0, len(s.body) - 45, 5):
                        self.assertNotIn(s.body[start : start + 45], source, f"{lesson.id}/{s.id}")
            for objective in lesson.learning_objectives:
                self.assertNotIn(objective[:40], source, lesson.id)


class TestBatch1ServerGrading(unittest.TestCase):
    def test_the_right_option_is_correct_with_the_explanation_and_every_wrong_option_is_not(self) -> None:
        for lesson, check in _all_checks():
            for option in check.options:
                outcome = grade_concept_check(lesson.id, check.id, option.id)
                self.assertEqual(outcome.correct, option.id == check.correct_option_id, f"{lesson.id}/{check.id}/{option.id}")
                self.assertEqual(outcome.explanation, check.explanation)

    def test_bad_input_is_a_structured_error_not_a_verdict(self) -> None:
        with self.assertRaises(GradeError) as unknown_option:
            grade_concept_check("grovers-search", "s5", "z")
        self.assertEqual(unknown_option.exception.status_code, 422)
        with self.assertRaises(GradeError) as unknown_check:
            grade_concept_check("grovers-search", "s4", "a")  # an explanation, not a check
        self.assertEqual(unknown_check.exception.status_code, 404)
        with self.assertRaises(GradeError):
            grade_concept_check("quantum-teleportation", "s99", "a")

    def test_a_check_cannot_be_graded_through_another_lesson(self) -> None:
        with self.assertRaises(GradeError):
            grade_concept_check("superdense-coding", "s5", "zz")
        self.assertTrue(grade_concept_check("superdense-coding", "s5", "b").correct)
        self.assertFalse(grade_concept_check("quantum-teleportation", "s5", "b").correct)  # same section id, different lesson, different key


class TestBatch1ChallengeAndProgressionLinks(unittest.TestCase):
    def test_each_lesson_is_linked_to_its_challenge_and_the_challenge_to_the_lesson(self) -> None:
        by_lesson: dict[str, list[str]] = {}
        for challenge in CHALLENGES:
            by_lesson.setdefault(challenge.lesson_id, []).append(challenge.id)
        for lesson_id, challenge_id in CHALLENGE_FOR.items():
            self.assertIn(challenge_id, by_lesson[lesson_id])
        self.assertEqual(by_lesson["bloch-sphere"], ["bloch-plus-direction"])
        self.assertEqual(by_lesson["entanglement"], ["entangle-bell-pair"])
        self.assertEqual(by_lesson["bell-state"], ["create-bell"])  # not displaced

    def test_the_challenge_starter_and_the_lessons_lab_agree_on_the_register_size(self) -> None:
        from qentor.challenges import CHALLENGE_BY_ID

        for lesson_id, challenge_id in CHALLENGE_FOR.items():
            challenge = CHALLENGE_BY_ID[challenge_id]
            self.assertEqual(challenge.constraints.num_qubits, get_lesson(lesson_id).linked_circuit.num_qubits)

    def test_the_lab_circuits_are_the_challenge_reference_solutions_or_their_close_relatives(self) -> None:
        from qentor.challenges import CHALLENGE_BY_ID

        # the lab is the worked example and the challenge's reference is the same protocol: gate for gate
        for lesson_id, challenge_id in CHALLENGE_FOR.items():
            lab = [(o.gate.value, o.controls, o.targets, o.params) for o in get_lesson(lesson_id).linked_circuit.ops]
            ref = [(o.gate.value, o.controls, o.targets, o.params) for o in CHALLENGE_BY_ID[challenge_id].reference_solution.ops]
            self.assertEqual(lab, ref, lesson_id)

    def test_the_content_validator_passes_with_the_new_content(self) -> None:
        aer = AerAdapter()
        try:
            aer.run(Circuit(num_qubits=1, num_clbits=0, ops=[]), "statevector")
        except AdapterUnavailable as exc:
            self.skipTest(str(exc))
        report = validate_content()
        self.assertTrue(report.ok, "\n" + str(report))
        self.assertEqual(report.checked["lessons"], 19)
        self.assertEqual(report.checked["challenges"], 20)

    def test_the_original_ten_lessons_are_unchanged_apart_from_losing_the_stale_no_challenge_reason(self) -> None:
        self.assertEqual([len(lesson.sections) for lesson in LESSONS[:10]], [9] * 7 + [10] * 3)
        for lesson in LESSONS[:10]:
            self.assertIsNone(lesson.no_challenge_reason, lesson.id)


if __name__ == "__main__":
    unittest.main()
