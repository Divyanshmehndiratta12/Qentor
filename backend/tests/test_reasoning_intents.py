"""Deterministic routing of typed questions to reasoning intents in English, Hindi and Kannada, and the tutor behaving as before for everything else."""

from __future__ import annotations

import unittest

from qentor.api import app as app_module
from qentor.api.schemas import TutorRequest
from qentor.lessons import LESSONS
from qentor.reasoning import (
    BasisStateTarget,
    EachQubitValueTarget,
    Intent,
    MostLikelyTarget,
    QubitValueTarget,
    SampledVsTheoreticalTarget,
)
from qentor.tutor.deterministic import UNSUPPORTED_QUESTION_ANSWER
from qentor.tutor.intents import normalise, route_question

from tests.reasoning_case import BELL, BELL_MEASURED, REDUNDANT, SUPERPOSITION, ReasoningCase

# (question, intent) in the three languages. The three questions of one row mean the same thing.
ROWS = [
    # PROBABILITY
    ("What is the probability of 1?", "1 आने की संभावना कितनी है?", "1 ಬರುವ ಸಾಧ್ಯತೆ ಎಷ್ಟು?", Intent.PROBABILITY),
    ("How likely is 0?", "0 आने की प्रायिकता क्या है?", "0 ಬರುವ ಸಂಭವನೀಯತೆ ಎಷ್ಟು?", Intent.PROBABILITY),
    # OPTIMIZE
    ("Can you optimize this circuit?", "क्या आप इस सर्किट को ऑप्टिमाइज़ कर सकते हैं?", "ಈ ಸರ್ಕ್ಯೂಟ್ ಅನ್ನು ಆಪ್ಟಿಮೈಸ್ ಮಾಡಿ", Intent.OPTIMIZE),
    ("Simplify this circuit", "इस सर्किट में कम गेट इस्तेमाल करो", "ಕಡಿಮೆ ಗೇಟ್ ಬಳಸಿ", Intent.OPTIMIZE),
    # TRACE_CHANGE (the English phrases are the ones the step tutor does not already own)
    ("Why did the state change here?", "यह अवस्था क्यों बदली? क्यों बदला", "ಇಲ್ಲಿ ಸ್ಥಿತಿ ಏಕೆ ಬದಲಾಯಿತು?", Intent.TRACE_CHANGE),
    ("Explain the change", "बदलाव समझाइए", "ಬದಲಾವಣೆಯನ್ನು ವಿವರಿಸಿ", Intent.TRACE_CHANGE),
    # WHAT_IF
    ("What if I remove the H gate?", "अगर मैं H गेट हटा दूँ तो क्या होगा?", "H ಗೇಟ್ ತೆಗೆದರೆ ಏನಾಗುತ್ತದೆ?", Intent.WHAT_IF),
    ("What would happen if I add an X?", "X जोड़ने पर क्या होगा?", "ಒಂದು ವೇಳೆ X ಸೇರಿಸಿದರೆ?", Intent.WHAT_IF),
    # COMPARE
    ("Compare these two runs", "इन दोनों रन की तुलना करो", "ಈ ಎರಡು ರನ್‌ಗಳನ್ನು ಹೋಲಿಸಿ", Intent.COMPARE),
    ("What is the difference between the runs?", "दोनों के बीच अंतर क्या है?", "ಇವುಗಳ ನಡುವೆ ವ್ಯತ್ಯಾಸವೇನು? ಹೋಲಿಕೆ ಮಾಡಿ", Intent.COMPARE),
    # DEBUG
    ("Debug my circuit", "मेरे सर्किट को डिबग करो", "ನನ್ನ ಸರ್ಕ್ಯೂಟ್ ಡೀಬಗ್ ಮಾಡಿ", Intent.DEBUG),
    ("What's wrong with my circuit?", "मेरे सर्किट में क्या गलत है?", "ನನ್ನ ಸರ್ಕ್ಯೂಟ್‌ನಲ್ಲಿ ಏನು ತಪ್ಪು?", Intent.DEBUG),
]


class TestRouting(unittest.TestCase):
    def test_the_same_question_in_three_languages_is_one_intent(self) -> None:
        for en, hi, kn, intent in ROWS:
            for language, question in (("en", en), ("hi", hi), ("kn", kn)):
                with self.subTest(language=language, question=question):
                    routed = route_question(question, 1)
                    self.assertIsNotNone(routed, f"{question!r} was not routed")
                    self.assertIs(routed.intent, intent)

    def test_the_probability_examples_from_the_brief_all_name_the_outcome_1(self) -> None:
        for question in ("What is the probability of 1?", "1 आने की संभावना कितनी है?", "1 ಬರುವ ಸಾಧ್ಯತೆ ಎಷ್ಟು?"):
            routed = route_question(question, 1)
            self.assertEqual(routed.target, BasisStateTarget(bits="1"), question)

    def test_the_same_words_on_a_register_ask_for_each_qubit(self) -> None:
        for question in ("What is the probability of 1?", "1 आने की संभावना कितनी है?", "1 ಬರುವ ಸಾಧ್ಯತೆ ಎಷ್ಟು?"):
            self.assertEqual(route_question(question, 3).target, EachQubitValueTarget(value=1), question)

    def test_a_whole_outcome_is_a_basis_state(self) -> None:
        self.assertEqual(route_question("probability of 011", 3).target, BasisStateTarget(bits="011"))
        self.assertEqual(route_question("What is the probability of |11⟩?", 2).target, BasisStateTarget(bits="11"))

    def test_a_named_qubit_is_a_qubit_value(self) -> None:
        self.assertEqual(route_question("What is the probability that qubit 1 is 0?", 2).target, QubitValueTarget(qubit=1, value=0))
        self.assertEqual(route_question("probability of q[0] being 1", 2).target, QubitValueTarget(qubit=0, value=1))
        self.assertEqual(route_question("क्यूबिट 1 के 0 आने की संभावना", 2).target, QubitValueTarget(qubit=1, value=0))
        self.assertEqual(route_question("ಕ್ಯೂಬಿಟ್ 0 ರಲ್ಲಿ 1 ಬರುವ ಸಾಧ್ಯತೆ", 2).target, QubitValueTarget(qubit=0, value=1))

    def test_the_most_likely_outcome(self) -> None:
        for question in ("What is the most likely outcome?", "सबसे संभावित परिणाम क्या है?", "ಅತ್ಯಂತ ಸಾಧ್ಯತೆ ಇರುವ ಫಲಿತಾಂಶ ಯಾವುದು?"):
            routed = route_question(question, 2)
            self.assertIs(routed.intent, Intent.PROBABILITY, question)
            self.assertEqual(routed.target, MostLikelyTarget(), question)

    def test_sampled_versus_theoretical(self) -> None:
        for question in (
            "How does the sampled frequency compare with the theoretical probability?",
            "सैद्धांतिक प्रायिकता और शॉट की आवृत्ति में क्या अंतर है?",
            "ಸೈದ್ಧಾಂತಿಕ ಸಾಧ್ಯತೆ ಮತ್ತು ಶಾಟ್ ಆವರ್ತನ ಹೋಲಿಸಿ",
        ):
            routed = route_question(question, 2)
            self.assertIs(routed.intent, Intent.PROBABILITY, question)  # not COMPARE, although it says "compare"
            self.assertIsInstance(routed.target, SampledVsTheoreticalTarget, question)

    def test_precedence(self) -> None:
        self.assertIs(route_question("What is the probability if I remove the H gate?", 1).intent, Intent.WHAT_IF)
        self.assertIs(route_question("debug and optimize this", 1).intent, Intent.DEBUG)
        self.assertIs(route_question("optimize and compare", 1).intent, Intent.OPTIMIZE)

    def test_unknown_questions_are_not_routed(self) -> None:
        for question in (
            "What does this circuit do?",
            "What was the result?",
            "Explain this concept",
            "Give me a hint",
            "What is a qubit?",
            "What is the probability?",  # no outcome named: the existing result summary answers it
            "ये सर्किट क्या करता है?",
            "ಈ ಸರ್ಕ್ಯೂಟ್ ಏನು ಮಾಡುತ್ತದೆ?",
            "",
            "   ",
        ):
            with self.subTest(question=question):
                self.assertIsNone(route_question(question, 2))

    def test_what_changed_in_english_stays_with_the_step_tutor(self) -> None:
        self.assertIsNone(route_question("What changed in this step?", 2))

    def test_zero_width_joiners_do_not_change_the_match(self) -> None:
        self.assertEqual(normalise("ಗೇಟ್‌ಗಳನ್ನು  ಕಡಿಮೆ"), normalise("ಗೇಟ್ಗಳನ್ನು ಕಡಿಮೆ"))
        self.assertIs(route_question("ಗೇಟ್‌ಗಳನ್ನು ಕಡಿಮೆ ಮಾಡಿ", 2).intent, Intent.OPTIMIZE)

    def test_routing_does_not_depend_on_the_selected_answer_language(self) -> None:
        # the router never sees the language setting: a Hindi question is Hindi whatever the answer language is
        self.assertIs(route_question("1 आने की संभावना कितनी है?", 1).intent, Intent.PROBABILITY)


class TestTutorUsesTheRouter(ReasoningCase):
    def ask(self, circuit, run, question: str, language: str = "en"):
        return app_module.tutor_endpoint(TutorRequest(result_id=run.result_id, circuit=circuit, question=question, language=language))

    def test_the_three_probability_questions_get_the_same_facts_in_three_wrappers(self) -> None:
        run = self.run_circuit(SUPERPOSITION)
        answers = {
            "en": self.ask(SUPERPOSITION, run, "What is the probability of 1?", "en"),
            "hi": self.ask(SUPERPOSITION, run, "1 आने की संभावना कितनी है?", "hi"),
            "kn": self.ask(SUPERPOSITION, run, "1 ಬರುವ ಸಾಧ್ಯತೆ ಎಷ್ಟು?", "kn"),
        }
        descriptions = {tuple(f.description for f in r.facts if f.kind == "probability") for r in answers.values()}
        self.assertEqual(len(descriptions), 1)  # identical facts: only the wrapper text differs
        self.assertIn("theoretical probability 0.500000", next(iter(descriptions))[0])
        self.assertIn("बैकएंड", answers["hi"].answer)
        self.assertIn("ಬ್ಯಾಕೆಂಡ್", answers["kn"].answer)
        self.assertNotIn("बैकएंड", answers["en"].answer)
        for r in answers.values():
            self.assertIn("0.500000", r.answer)
            self.assertEqual(r.provenance_class, "SIMULATION")
            self.assertTrue(self.store.get(r.result_id).backend == "reasoning-engine")

    def test_an_optimize_question_in_each_language(self) -> None:
        run = self.run_circuit(REDUNDANT)
        for language, question in (("en", "optimize this circuit"), ("hi", "इस सर्किट को ऑप्टिमाइज़ करो"), ("kn", "ಈ ಸರ್ಕ್ಯೂಟ್ ಅನ್ನು ಆಪ್ಟಿಮೈಸ್ ಮಾಡಿ")):
            with self.subTest(language=language):
                response = self.ask(REDUNDANT, run, question, language)
                self.assertIn("3 operations before, 1 after", response.answer)
                self.assertTrue(any(f.kind == "reasoning_optimization" for f in response.facts))

    def test_a_what_if_or_compare_question_points_at_the_controls_and_computes_nothing(self) -> None:
        run = self.run_circuit(BELL)
        before = self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]  # noqa: SLF001
        for language, question in (("en", "What if I remove the CX?"), ("hi", "अगर मैं CX हटा दूँ तो क्या होगा?"), ("kn", "CX ತೆಗೆದರೆ ಏನಾಗುತ್ತದೆ?")):
            response = self.ask(BELL, run, question, language)
            self.assertEqual(response.facts, [])
            self.assertTrue(response.used_fallback_template)
        self.assertIn("What if", self.ask(BELL, run, "What if I remove the CX?").answer)
        self.assertIn("Compare experiments", self.ask(BELL, run, "Compare these two runs").answer)
        self.assertEqual(self.store._conn.execute("SELECT COUNT(*) FROM results").fetchone()[0], before)  # noqa: SLF001

    def test_an_outcome_that_does_not_fit_is_an_honest_answer_not_an_error(self) -> None:
        run = self.run_circuit(BELL)
        response = self.ask(BELL, run, "What is the probability of 101?")
        self.assertIn("I could not analyse that", response.answer)
        self.assertIn("2 bits long", response.answer)
        self.assertEqual(response.facts, [])

    def test_an_unrouted_question_gets_exactly_the_old_answer(self) -> None:
        run = self.run_circuit(BELL)
        self.assertEqual(self.ask(BELL, run, "tell me a joke").answer, UNSUPPORTED_QUESTION_ANSWER)
        old = self.ask(BELL, run, "What was the result?")
        self.assertTrue(old.answer.startswith("For this result:"))
        self.assertTrue(all(f.id.startswith("F") for f in old.facts))

    def test_a_trace_step_question_in_hindi_is_answered_by_the_engine(self) -> None:
        trace = self.trace(BELL)
        ref = self.step_ref(trace, 2)
        from qentor.tutor.trace_context import TraceStepRef

        response = app_module.tutor_endpoint(
            TutorRequest(circuit=BELL, question="इस चरण में क्या बदला?", language="hi", trace_step=TraceStepRef.model_validate(ref))
        )
        self.assertIn("इस चरण ने क्या बदला", response.answer)
        self.assertTrue(any(f.kind == "reasoning_trace" for f in response.facts))
        self.assertIn("0.500000", response.answer)
        self.assertEqual(response.trace_step.step_number, 3)

    def test_an_english_step_question_keeps_the_step_tutors_answer(self) -> None:
        trace = self.trace(BELL)
        from qentor.tutor.trace_context import TraceStepRef

        response = app_module.tutor_endpoint(
            TutorRequest(circuit=BELL, question="Why did the state change here?", trace_step=TraceStepRef.model_validate(self.step_ref(trace, 2)))
        )
        self.assertTrue(all(f.id.startswith("S") for f in response.facts))

    def test_a_debug_question_returns_the_debuggers_report_with_engine_facts(self) -> None:
        run = self.run_circuit(REDUNDANT)
        response = self.ask(REDUNDANT, run, "debug my circuit")
        self.assertTrue(any(f.id.startswith("R") for f in response.facts))
        self.assertIn("shorter circuit", response.answer.lower() + " ".join(f.description for f in response.facts).lower())

    def test_a_lesson_only_question_is_never_routed(self) -> None:
        response = app_module.tutor_endpoint(TutorRequest(lesson_id=LESSONS[0].id, question="What is the probability of 1?"))
        self.assertIsNone(response.result_id)

    def test_sampled_versus_theoretical_through_the_tutor(self) -> None:
        run = self.run_circuit(BELL_MEASURED, "shots", 400)
        response = self.ask(BELL_MEASURED, run, "How does the sampled frequency compare with the theoretical probability?")
        self.assertTrue(any(f.kind == "reasoning_sampled" for f in response.facts))
        self.assertTrue(any("sampled frequency" in f.description for f in response.facts))


if __name__ == "__main__":
    unittest.main()
