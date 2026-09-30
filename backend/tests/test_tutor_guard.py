"""Adversarial tests for the LLM claim guard (``qentor.tutor.guard`` / ``claims``).

The old guard compared decimals and percentages as text, so an integer count
("512 out of 1024"), a fraction ("probability 1/2"), a square-root expression
("amplitude is 1/√2") or a verdict ("this circuit is verified correct") went
straight through. These tests pin the structured replacement: a draft is parsed into
typed claims, the facts are parsed with the same parser, and every claim must be
supported BY VALUE.

Two halves, both required:

* claims the facts DO support (in any equivalent notation) must pass — a guard
  that rejects every answer would just be the template with extra steps;
* claims the facts do NOT support must fail, whatever notation they hide in.

The fact sheets here are built from REAL Aer runs, not typed in.
"""

from __future__ import annotations

import re
import unittest

from qentor.circuit.hashing import circuit_hash
from qentor.circuit.model import Circuit, GateOp
from qentor.execution.aer import AerAdapter
from qentor.provenance.models import ExecutionStatus, ProvenanceClass, ProvenanceRecord
from qentor.tutor.answer import answer_question_with_llm
from qentor.tutor.claims import extract_claims, find_violations, read_support, split_sentences
from qentor.tutor.facts import build_fact_sheet
from qentor.tutor.guard import GuardRejection, validate_llm_draft
from qentor.tutor.llm import LLMDraft
from qentor.tutor.models import TutorFact

AER = AerAdapter()


def _gate(gate, target, controls=(), clbits=()):
    return GateOp(gate=gate, targets=[target], controls=list(controls), clbits=list(clbits))


BELL = Circuit(num_qubits=2, num_clbits=2, ops=[_gate("h", 0), _gate("cx", 1, [0]), _gate("measure", 0, clbits=[0]), _gate("measure", 1, clbits=[1])])
BELL_UNMEASURED = Circuit(num_qubits=2, num_clbits=0, ops=[_gate("h", 0), _gate("cx", 1, [0])])
H_THEN_Z = Circuit(num_qubits=1, num_clbits=0, ops=[_gate("h", 0), _gate("z", 0)])
X_ONLY = Circuit(num_qubits=1, num_clbits=1, ops=[_gate("x", 0), _gate("measure", 0, clbits=[0])])


def _facts(circuit: Circuit, mode: str, shots: int | None = None) -> list[TutorFact]:
    result = AER.run(circuit, mode, shots)  # a real backend run
    record = ProvenanceRecord.new(
        circuit_hash=circuit_hash(circuit),
        backend=result.backend_name,
        backend_version=result.backend_version,
        execution_mode=mode,
        provenance_class=ProvenanceClass.SIMULATION,
        verification_status=ExecutionStatus.STATE_CHECKED,
        payload=result.to_payload(),
    )
    return build_fact_sheet(circuit, record)


def _lesson_fact(text: str) -> TutorFact:
    return TutorFact(id="L1", kind="lesson_material", description=text, result_id=None)


def _draft(text: str, cite: list[str] | None = None) -> LLMDraft:
    return LLMDraft(answer=text, cited_fact_ids=cite or [])


class GuardCase(unittest.TestCase):
    """Shared assertions over one fact sheet."""

    facts: list[TutorFact]

    def accepts(self, text: str) -> None:
        violations = find_violations(text, self.facts)
        self.assertEqual(violations, [], f"wrongly rejected {text!r}: {[str(v) for v in violations]}")
        validate_llm_draft(_draft(text), self.facts)  # and the guard agrees

    def rejects(self, text: str, kind: str | None = None) -> None:
        violations = find_violations(text, self.facts)
        self.assertTrue(violations, f"wrongly accepted {text!r}")
        if kind is not None:
            self.assertIn(kind, {v.kind for v in violations}, [str(v) for v in violations])
        with self.assertRaises(GuardRejection) as raised:
            validate_llm_draft(_draft(text), self.facts)
        self.assertTrue(raised.exception.violations)


# --------------------------------------------------------------------------- #
# A shots result: outcomes 00 and 11, roughly half each, with real counts.      #
# --------------------------------------------------------------------------- #


class TestShotsFacts(GuardCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.facts = _facts(BELL, "shots", 1000)
        cls.probs = {f.description.split()[1].rstrip(":"): f for f in cls.facts if f.kind == "probability"}

    def test_the_facts_are_the_real_backend_numbers(self) -> None:
        self.assertEqual(set(self.probs), {"00", "11"})
        text = " ".join(f.description for f in self.facts)
        self.assertIn("shots)", text)

    # -- supported: the same claim in equivalent notation must pass --------------------
    def test_restating_the_exact_fact_passes(self) -> None:
        for fact in self.facts:
            self.accepts(f"{fact.description} ({fact.id}).")

    def test_a_count_the_facts_state_passes(self) -> None:
        counts = [int(c) for f in self.facts if f.kind == "probability" for c in re.findall(r"\((\d+) shots\)", f.description)]
        self.accepts(f"Outcome 00 was observed {counts[0]} times (F3).")

    def test_the_same_probability_as_a_percentage_a_fraction_or_a_rounded_decimal_passes(self) -> None:
        p = float(self.probs["00"].description.split("probability ")[1].split()[0])
        self.assertAlmostEqual(p, 0.5, delta=0.1)
        rounded = round(p, 2)
        self.accepts(f"Outcome 00 has probability {rounded}.")
        self.accepts(f"Outcome 00 came up in about {round(p * 100)}% of the shots.")

    def test_bitstrings_and_kets_that_appear_in_the_facts_pass(self) -> None:
        self.accepts("Only the outcomes 00 and 11 appear, so |00⟩ and |11⟩ are the states that were measured.")

    def test_qubit_indices_gate_names_and_fact_ids_are_not_claims(self) -> None:
        self.accepts("H on q0 then CX from q0 to q1 (F1), and c0 and c1 receive the measurements.")

    def test_a_generic_sentence_with_no_number_passes(self) -> None:
        self.accepts("A Hadamard gate puts a qubit into an equal superposition of the two basis states.")

    def test_an_even_split_is_allowed_when_two_probabilities_are_equal_in_the_facts(self) -> None:
        # counts differ run to run; equality of the probabilities is what the guard needs, so build it explicitly
        facts = [
            TutorFact(id="F1", kind="probability", description="outcome 00: probability 0.500000 (500 shots)", result_id="r"),
            TutorFact(id="F2", kind="probability", description="outcome 11: probability 0.500000 (500 shots)", result_id="r"),
        ]
        self.assertEqual(find_violations("The two outcomes are equally likely.", facts), [])

    # -- unsupported: every notation of an unsupported claim must fail -----------------------
    def test_the_brief_examples_are_rejected(self) -> None:
        self.rejects("The outcome 00 occurred 512 out of 1024 times.")
        self.rejects("The amplitude is 1/√2 and this circuit is verified correct.")
        self.rejects("This circuit is verified correct.", "verdict")

    def test_a_fraction_is_supported_only_by_a_matching_value(self) -> None:
        # probability 1/2 is a claim of exactly 0.5; a sampled 0.3 / 0.7 split does not say that
        facts = [
            TutorFact(id="F1", kind="probability", description="outcome 00: probability 0.300000", result_id="r"),
            TutorFact(id="F2", kind="probability", description="outcome 11: probability 0.700000", result_id="r"),
        ]
        self.assertTrue(find_violations("Outcome 00 has probability 1/2.", facts))
        self.assertEqual(find_violations("Outcome 00 has probability 3/10.", facts), [])

    def test_integers_and_counts_the_facts_do_not_state(self) -> None:
        self.rejects("Outcome 00 occurred 733 times.", "int")
        self.rejects("There were 4096 shots in total.", "int")
        self.rejects("The run used 7 qubits.", "int")

    def test_out_of_expressions(self) -> None:
        self.rejects("It appeared 512 out of 1024 times.", "outof")

    def test_fractions(self) -> None:
        self.rejects("Each outcome has probability 1/3.", "frac")
        self.rejects("The chance is 2/7.", "frac")

    def test_square_root_expressions_that_are_not_in_the_facts(self) -> None:
        self.rejects("The amplitude is 1/√5.", "sqrt")
        self.rejects("The norm is √3.", "sqrt")
        self.rejects("The amplitude is sqrt(7).", "sqrt")

    def test_ratios(self) -> None:
        self.rejects("The outcomes appear in a 3:1 ratio.", "ratio")

    def test_scientific_notation(self) -> None:
        self.rejects("The residual probability is 3.2e-5.", "sci")
        self.rejects("The error is 1e-3.", "sci")

    def test_percentages(self) -> None:
        self.rejects("That is about 73% likely.", "pct")
        self.rejects("Outcome 00 has a 12.5% chance.", "pct")

    def test_decimals(self) -> None:
        self.rejects("P(00) = 0.999999.", "dec")
        self.rejects("The probability is 0.123456.", "dec")

    def test_negative_numbers_the_facts_do_not_state(self) -> None:
        self.rejects("The amplitude is -0.5.", "dec")
        self.rejects("The offset is −3.", "int")

    def test_a_basis_state_the_facts_never_mention(self) -> None:
        self.rejects("The |01⟩ component is present.", None)
        self.rejects("You will also see the outcome 01 occasionally.", None)

    def test_a_version_the_facts_do_not_state(self) -> None:
        self.rejects("This ran on qiskit-aer 9.9.9.", "version")

    def test_number_words_quantifying_results(self) -> None:
        self.rejects("Outcome 00 happened five hundred and twelve times.", "word")
        self.rejects("About a quarter of the shots gave 01.", "word")

    def test_certainty_words_need_a_certain_fact(self) -> None:
        self.rejects("The measurement always gives 11.", "certainty")
        self.rejects("Outcome 01 is impossible.", "certainty")

    def test_an_even_split_claim_needs_equal_probabilities(self) -> None:
        facts = [
            TutorFact(id="F1", kind="probability", description="outcome 00: probability 0.300000", result_id="r"),
            TutorFact(id="F2", kind="probability", description="outcome 11: probability 0.700000", result_id="r"),
        ]
        self.assertTrue(find_violations("The outcomes are equally likely.", facts))
        self.assertTrue(find_violations("It is a fifty-fifty split between the outcomes.", facts))

    def test_verdicts_about_this_circuit_or_result(self) -> None:
        self.rejects("Your circuit passes.", "verdict")
        self.rejects("The result is correct.", "verdict")
        self.rejects("This circuit is equivalent to the Bell circuit.", "verdict")
        self.rejects("The optimization is optimal.", "verdict")
        self.rejects("The run failed the check.", "verdict")

    def test_a_valid_looking_citation_does_not_launder_an_unsupported_number(self) -> None:
        real = self.facts[0]
        self.rejects(f"Outcome 00 occurred 733 times ({real.id}).")
        with self.assertRaises(GuardRejection):
            validate_llm_draft(_draft(f"Outcome 00 occurred 733 times ({real.id}).", [real.id]), self.facts)

    def test_one_bad_claim_among_good_ones_is_enough(self) -> None:
        self.rejects("Outcome 00 and 11 are the only outcomes, and 11 occurred 987 times.")

    def test_the_rejection_names_the_offending_claims(self) -> None:
        with self.assertRaises(GuardRejection) as raised:
            validate_llm_draft(_draft("It occurred 512 out of 1024 times and this is verified."), self.facts)
        kinds = {v.kind for v in raised.exception.violations}
        self.assertTrue({"outof", "verdict"} <= kinds)
        self.assertIn("512 out of 1024", str(raised.exception))


# --------------------------------------------------------------------------- #
# A statevector result with a NEGATIVE amplitude (H then Z).                     #
# --------------------------------------------------------------------------- #


class TestSignedAmplitudeFacts(GuardCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.facts = _facts(H_THEN_Z, "statevector")

    def test_the_backend_amplitudes_include_a_negative_one(self) -> None:
        text = " ".join(f.description for f in self.facts if f.kind == "amplitude")
        self.assertIn("-0.707107", text)

    def test_the_signed_fact_is_supported_in_either_minus_glyph(self) -> None:
        self.accepts("The |1⟩ amplitude is -0.707107 + 0.000000i (F3).")
        self.accepts("The |1⟩ amplitude is −0.707107.")

    def test_a_rounded_signed_restatement_passes(self) -> None:
        self.accepts("The |1⟩ amplitude is about -0.7071.")

    def test_dropping_the_sign_is_a_different_claim_and_is_rejected(self) -> None:
        # Z is exactly a sign flip. With only the negative fact in view, a positive claim is unsupported.
        neg = [TutorFact(id="F1", kind="amplitude", description="|1⟩ amplitude: -0.707107 + 0.000000i", result_id="r")]
        self.assertTrue(find_violations("The |1⟩ amplitude is 0.707107.", neg))
        self.assertEqual(find_violations("The |1⟩ amplitude is -0.707107.", neg), [])

    def test_a_magnitude_phrase_licenses_the_unsigned_value(self) -> None:
        neg = [TutorFact(id="F1", kind="amplitude", description="|1⟩ amplitude: -0.707107 + 0.000000i", result_id="r")]
        self.assertEqual(find_violations("The magnitude of the |1⟩ amplitude is 0.707107.", neg), [])

    def test_the_normalisation_written_as_a_square_root_is_supported_by_the_decimal(self) -> None:
        self.accepts("Both amplitudes have size 1/√2 (F1).")
        self.accepts("The state is (|0⟩ − |1⟩)/√2.")

    def test_a_probability_is_not_derivable_from_amplitudes_by_the_model(self) -> None:
        # The facts list amplitudes only; 0.5 = 0.707107**2 would be the MODEL calculating.
        self.rejects("Each outcome has probability 0.5.", "dec")

    def test_the_imaginary_part_cannot_hide_a_number(self) -> None:
        self.rejects("The amplitude is 0.707107 + 0.5i.", "dec")


class TestCertainFacts(GuardCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.facts = _facts(X_ONLY, "shots", 200)

    def test_a_deterministic_outcome_may_be_called_certain_when_a_fact_shows_probability_one(self) -> None:
        self.assertTrue(any("probability 1.000000" in f.description for f in self.facts))
        self.accepts("The measurement always gives 1.")
        self.accepts("Outcome 1 has probability 1 in this run.")

    def test_an_integer_one_matching_a_decimal_one_is_supported_but_two_is_not(self) -> None:
        self.rejects("Outcome 1 has probability 2.")


# --------------------------------------------------------------------------- #
# Lesson facts: textbook expressions may be restated, results still may not.    #
# --------------------------------------------------------------------------- #


class TestLessonFacts(GuardCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.facts = [_lesson_fact("H turns |0⟩ into (|0⟩ + |1⟩)/√2, an equal superposition; measurement gives 0 or 1.")]

    def test_the_textbook_expression_in_the_lesson_may_be_restated(self) -> None:
        self.accepts("H maps |0⟩ to (|0⟩ + |1⟩)/√2 (L1).")

    def test_a_lesson_fact_does_not_license_a_verdict_about_this_circuit(self) -> None:
        self.rejects("Your circuit is verified correct.", "verdict")

    def test_a_lesson_fact_does_not_license_a_new_count(self) -> None:
        self.rejects("The state appears 512 times.", None)

    def test_ordinary_lesson_prose_is_not_a_claim(self) -> None:
        self.accepts("A superposition means the qubit has amplitude on both basis states.")


class TestLessonTextNeverLicensesAClaimAboutTheLearnersOwnWork(GuardCase):
    """The lesson may say "verified", "always" and "equally likely" about a TEXTBOOK case. An
    answer may restate that. It may not turn it into a statement about this circuit."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.facts = [
            _lesson_fact(
                "A verifier reports a circuit as verified when the expected pattern appears. "
                "An X gate always flips the qubit, and after H the two outcomes are equally likely when measured."
            )
        ]

    def test_the_textbook_sentences_may_be_restated(self) -> None:
        self.accepts("A verifier reports a circuit as verified when the expected pattern appears (L1).")
        self.accepts("An X gate always flips the qubit when measured afterwards.")
        self.accepts("After H the two outcomes are equally likely when measured.")

    def test_the_same_words_about_this_circuit_or_result_are_claims(self) -> None:
        self.rejects("Your circuit is verified.", "verdict")
        self.rejects("This circuit always gives 1 when measured.", "certainty")
        self.rejects("Your run gives equally likely outcomes when measured.", "even split")


# --------------------------------------------------------------------------- #
# The parser itself                                                           #
# --------------------------------------------------------------------------- #


class TestExtractor(unittest.TestCase):
    def kinds(self, text: str) -> list[str]:
        return [c.kind for c in extract_claims(text)]

    def test_each_notation_is_its_own_kind(self) -> None:
        cases = {
            "512": ["int"],
            "1,024": ["int"],
            "0.5": ["dec"],
            ".5": ["dec"],
            "-0.707107": ["dec"],
            "−0.707107": ["dec"],
            "50%": ["pct"],
            "12.5 %": ["pct"],
            "1/2": ["frac"],
            "1/√2": ["sqrt"],
            "1/sqrt(2)": ["sqrt"],
            "√2": ["sqrt"],
            "3:1": ["ratio"],
            "512 out of 1024": ["outof"],
            "3.2e-5": ["sci"],
            "1e-9": ["sci"],
            "0.17.2": ["version"],
            "|00⟩": ["ket"],
            "|+⟩": ["ket"],
        }
        for text, kinds in cases.items():
            with self.subTest(text=text):
                self.assertEqual(self.kinds(text), kinds)

    def test_a_bare_bitstring_is_both_a_bitstring_and_an_integer(self) -> None:
        self.assertEqual(self.kinds("outcome 11"), ["bits", "int"])

    def test_identifiers_with_digits_are_not_numbers(self) -> None:
        self.assertEqual(self.kinds("h(q0) then cx(control=q0, target=q1), see F3 and S12 and res_a1b2c3"), [])

    def test_hyphenated_units_are_not_signed_numbers(self) -> None:
        claims = extract_claims("a 2-qubit circuit")
        self.assertEqual([(c.kind, c.value) for c in claims], [("int", 2.0)])

    def test_values_are_read_by_meaning(self) -> None:
        by_text = {c.text: c.value for c in extract_claims("1/2, 50%, 0.5 and 1/√4")}
        self.assertAlmostEqual(by_text["1/2"], 0.5)
        self.assertAlmostEqual(by_text["50%"], 0.5)
        self.assertAlmostEqual(by_text["0.5"], 0.5)
        self.assertAlmostEqual(by_text["1/√4"], 0.5)

    def test_a_trailing_full_stop_is_not_part_of_the_number(self) -> None:
        self.assertEqual([(c.text, c.value) for c in extract_claims("The probability is 0.5.")], [("0.5", 0.5)])

    def test_sentence_splitting_keeps_decimals_together(self) -> None:
        self.assertEqual(split_sentences("It is 0.5. Then it is 0.25."), ["It is 0.5.", "Then it is 0.25."])

    def test_support_is_read_with_the_same_parser(self) -> None:
        fact = TutorFact(id="F1", kind="probability", description="outcome 00: probability 0.500000 (500 shots)", result_id="r")
        support = read_support([fact])
        self.assertIn(500, support.ints)
        self.assertIn(0.5, support.values)
        self.assertIn("00", support.bitstrings)


# --------------------------------------------------------------------------- #
# End to end: a lying LLM never reaches the learner                              #
# --------------------------------------------------------------------------- #


class TestHonestAnswersAreNeverFlagged(unittest.TestCase):
    """The false-positive side, measured: a guard that rejects honest answers is the
    template with extra steps. Deterministic answers only quote their own facts, so read back
    as if they were model drafts they must all pass."""

    def test_every_lesson_section_question_and_language(self) -> None:
        from qentor.lessons import LESSONS
        from qentor.tutor import answer_lesson_aware_question, resolve_lesson_context

        questions = ("Explain this concept", "Give me a simpler explanation", "Give me a hint")
        checked = 0
        for lesson in LESSONS:
            for section in lesson.sections:
                context = resolve_lesson_context(lesson.id, section.id)
                for language in ("en", "hi", "kn"):
                    for question in questions:
                        text = answer_lesson_aware_question(question, context, [], None, None, language)[0]
                        violations = find_violations(text, list(context.facts))
                        checked += 1
                        self.assertEqual(violations, [], f"{lesson.id}/{section.id} {language} {question!r}: {[str(v) for v in violations]}")
        self.assertEqual(checked, (7 * 9 + 3 * 10) * 3 * 3)  # seven 9-section lessons and three 10-section ones

    def test_result_answers_for_real_shots_and_statevector_runs(self) -> None:
        from qentor.tutor.deterministic import answer_question

        checked = 0
        for circuit, mode, shots in ((BELL, "shots", 300), (X_ONLY, "shots", 100), (H_THEN_Z, "statevector", None), (BELL_UNMEASURED, "statevector", None)):
            result = AER.run(circuit, mode, shots)
            record = ProvenanceRecord.new(
                circuit_hash=circuit_hash(circuit),
                backend=result.backend_name,
                backend_version=result.backend_version,
                execution_mode=mode,
                provenance_class=ProvenanceClass.SIMULATION,
                verification_status=ExecutionStatus.STATE_CHECKED,
                payload=result.to_payload(),
            )
            facts = build_fact_sheet(circuit, record)
            for language in ("en", "hi", "kn"):
                for question in ("Explain my result", "Explain this circuit", "What does each gate in this circuit do?", "What was the result?"):
                    text = answer_question(question, facts, record, language)
                    violations = find_violations(text, facts)
                    checked += 1
                    self.assertEqual(violations, [], f"{mode} {language} {question!r}: {[str(v) for v in violations]}")
        self.assertEqual(checked, 4 * 3 * 4)


class _Fake:
    name = "fake"

    def __init__(self, text: str) -> None:
        self.text = text

    def generate(self, question, facts, language="en", **_kwargs):
        return LLMDraft(answer=self.text, cited_fact_ids=[])


class TestALyingModelNeverReachesTheLearner(unittest.TestCase):
    LIES = [
        "The outcome 00 occurred 512 out of 1024 times.",
        "Each outcome has probability 1/2 exactly.",
        "The amplitude is 1/√2, so this circuit is verified correct.",
        "Your circuit passes and is equivalent to the ideal Bell circuit.",
        "The counts were 733 and 267.",
        "The result is 3.2e-5 away from ideal.",
    ]

    def test_every_lie_falls_back_to_the_template_and_is_absent_from_the_answer(self) -> None:
        result = AER.run(BELL, "shots", 200)
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(BELL),
            backend=result.backend_name,
            backend_version=result.backend_version,
            execution_mode="shots",
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED,
            payload=result.to_payload(),
        )
        facts = build_fact_sheet(BELL, record)
        for lie in self.LIES:
            with self.subTest(lie=lie):
                answer, used_template = answer_question_with_llm("What was the result?", facts, record, _Fake(lie))
                self.assertTrue(used_template)
                self.assertNotIn(lie, answer)
                self.assertNotIn("512", answer)

    def test_an_honest_model_is_still_used(self) -> None:
        result = AER.run(BELL, "shots", 200)
        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(BELL),
            backend=result.backend_name,
            backend_version=result.backend_version,
            execution_mode="shots",
            provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED,
            payload=result.to_payload(),
        )
        facts = build_fact_sheet(BELL, record)
        honest = "The circuit applies a Hadamard to q0 and then a CX from q0 to q1, so only the outcomes 00 and 11 are expected (F1)."
        answer, used_template = answer_question_with_llm("Explain this circuit", facts, record, _Fake(honest))
        self.assertFalse(used_template)
        self.assertEqual(answer, honest)


if __name__ == "__main__":
    unittest.main()
