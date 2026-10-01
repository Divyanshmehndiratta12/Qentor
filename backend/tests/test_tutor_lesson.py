"""Lesson-aware tutoring (docs/AI_BOUNDARY.md): POST /api/tutor with optional
``lesson_id``/``section_id``.

The invariant these tests protect: lesson explanation comes from the lesson
registry, quantum numbers come only from the provenance log, and the browser
supplies identifiers — never lesson text and never a number. Real Aer results
(skipped, not faked, if Aer is unavailable) are used wherever a result is
needed; the LLM is always a test double.
"""

from __future__ import annotations

import json
import re
import unittest
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from qentor.api import app as app_module
from qentor.api.schemas import TutorRequest
from qentor.circuit.model import Circuit, GateOp
from qentor.lessons import LESSONS, ConceptCheckSection, ExplanationSection, get_lesson
from qentor.tutor import answer_lesson_aware_question, resolve_lesson_context
from qentor.tutor.deterministic import UNSUPPORTED_QUESTION_ANSWER, answer_question
from qentor.tutor.facts import build_fact_sheet
from qentor.tutor.lesson_answers import route_question
from qentor.tutor.lesson_context import (
    LESSON_NOT_FOUND,
    SECTION_MISMATCH,
    SECTION_NOT_FOUND,
    LessonContextError,
)
from qentor.tutor.llm import (
    _LESSON_PROMPT_ADDENDUM,
    AnthropicAdapter,
    LLMDraft,
    LLMUnavailable,
    _system_prompt,
)
from tests.test_api_tutor import BELL, TutorEndpointTestCase

H_Z = Circuit(num_qubits=1, num_clbits=0, ops=[GateOp(gate="h", targets=[0]), GateOp(gate="z", targets=[0])])

EXPLAIN = "Explain this concept"
SIMPLER = "Give me a simpler explanation"
HINT = "Give me a hint"

HI_EXPLAIN = "पाठ के इस भाग के बारे में"
KN_EXPLAIN = "ಪಾಠದ ಈ ಭಾಗದ ಬಗ್ಗೆ"

DECIMAL = re.compile(r"\d+\.\d+|\d+%")


def _section(lesson_id: str, section_id: str):
    return next(sec for sec in get_lesson(lesson_id).sections if sec.id == section_id)


def prose(lesson_id: str, section_id: str) -> str:
    """The section's own teaching/prompt text, straight from the lesson registry."""
    sec = _section(lesson_id, section_id)
    return getattr(sec, "body", None) or getattr(sec, "instructions", None) or sec.prompt


def description(lesson_id: str) -> str:
    return get_lesson(lesson_id).short_description


def correct_option_text(lesson_id: str, section_id: str) -> str:
    sec = _section(lesson_id, section_id)
    return next(o.text for o in sec.options if o.id == sec.correct_option_id)


# Content the tests below refer to, read from the registry (never retyped here).
QM_S1 = prose("qubits-measurement", "s1")
PHASE_S1 = prose("phase", "s1")
PHASE_LAB = prose("phase", "s6")  # the interactive lab
PHASE_REFLECTION = prose("phase", "s9")
PHASE_DESC = description("phase")
INTERF_DESC = description("interference")
INTERF_QUIZ = "s5"  # interference's first concept check
INTERF_MATERIAL = prose("interference", "s4")  # the explanation closest before it
INTERF_CORRECT = correct_option_text("interference", INTERF_QUIZ)
INTERF_RATIONALE = _section("interference", INTERF_QUIZ).explanation


def ask(**kwargs):
    return app_module.tutor_endpoint(TutorRequest(**kwargs))


class RecordingLLM:
    """Test double for qentor.tutor.llm.LLMAdapter that records what it was given."""

    name = "recording"

    def __init__(self, draft: LLMDraft | None = None, *, raises: Exception | None = None) -> None:
        self._draft = draft
        self._raises = raises
        self.calls: list[dict] = []

    def generate(self, question, facts, language="en", lesson_facts=None):
        self.calls.append(
            {"question": question, "facts": list(facts), "language": language, "lesson_facts": lesson_facts}
        )
        if self._raises is not None:
            raise self._raises
        assert self._draft is not None
        return self._draft


# --------------------------------------------------------------------------- #
# Request schema                                                              #
# --------------------------------------------------------------------------- #


class TestRequestSchema(unittest.TestCase):
    def test_a_request_without_lesson_context_is_unchanged(self) -> None:
        req = TutorRequest.model_validate({"result_id": "res_x", "circuit": BELL.canonical_dict(), "question": "hi"})
        self.assertEqual(req.language, "en")
        self.assertIsNone(req.lesson_id)
        self.assertIsNone(req.section_id)

    def test_lesson_only_request_is_valid(self) -> None:
        req = TutorRequest(question=EXPLAIN, lesson_id="phase")
        self.assertIsNone(req.result_id)
        self.assertIsNone(req.circuit)

    def test_lesson_and_result_request_is_valid(self) -> None:
        req = TutorRequest(result_id="res_x", circuit=BELL, question="q", lesson_id="phase", section_id="s1")
        self.assertEqual((req.lesson_id, req.section_id), ("phase", "s1"))

    def test_neither_result_nor_lesson_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            TutorRequest(question="hello")

    def test_result_id_without_circuit_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            TutorRequest(result_id="res_x", question="hello", lesson_id="phase")

    def test_circuit_without_result_id_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            TutorRequest(circuit=BELL, question="hello", lesson_id="phase")

    def test_section_id_without_lesson_id_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            TutorRequest(result_id="res_x", circuit=BELL, question="hello", section_id="s1")

    def test_empty_lesson_id_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            TutorRequest(question="hello", lesson_id="")

    def test_extra_forbid_still_rejects_client_supplied_lesson_text(self) -> None:
        for extra in ("lesson_text", "lesson", "section_body", "facts", "probabilities", "verification_status"):
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                TutorRequest.model_validate({"question": "q", "lesson_id": "phase", extra: "anything"})


# --------------------------------------------------------------------------- #
# Lesson-context resolution                                                   #
# --------------------------------------------------------------------------- #


class TestResolveLessonContext(unittest.TestCase):
    def test_lesson_only_has_overview_objectives_and_prerequisites_but_no_section(self) -> None:
        ctx = resolve_lesson_context("phase")
        self.assertEqual((ctx.lesson_id, ctx.lesson_title), ("phase", "Phase"))
        self.assertIsNone(ctx.section_id)
        kinds = [f.kind for f in ctx.facts]
        self.assertEqual(kinds[0], "lesson_overview")
        self.assertIn("lesson_objective", kinds)
        self.assertIn("lesson_prerequisite", kinds)
        self.assertNotIn("lesson_section", kinds)
        self.assertNotIn("lesson_material", kinds)

    def test_explanation_section_contributes_its_own_text_only(self) -> None:
        ctx = resolve_lesson_context("phase", "s1")
        self.assertEqual(ctx.section_type, "explanation")
        section_facts = ctx.of_kind("lesson_section")
        self.assertEqual(len(section_facts), 1)
        self.assertIn(PHASE_S1, section_facts[0].description)
        self.assertEqual(ctx.of_kind("lesson_material"), [])

    def test_quiz_section_pulls_in_the_lessons_explanatory_text_as_material(self) -> None:
        ctx = resolve_lesson_context("phase", "s5")
        self.assertEqual(ctx.section_type, "concept_check")
        material = ctx.of_kind("lesson_material")
        # The (up to two) explanation sections closest BEFORE the check — s3 and s4 — in order.
        self.assertEqual(len(material), 2)
        self.assertIn(prose("phase", "s3"), material[0].description)
        self.assertIn(prose("phase", "s4"), material[1].description)

    def test_material_is_the_nearest_preceding_explanations_not_the_whole_lesson(self) -> None:
        for lesson in LESSONS:
            for index, section in enumerate(lesson.sections):
                if isinstance(section, ExplanationSection):
                    continue
                ctx = resolve_lesson_context(lesson.id, section.id)
                material = ctx.of_kind("lesson_material")
                preceding = [s for s in lesson.sections[:index] if isinstance(s, ExplanationSection)]
                self.assertLessEqual(len(material), 2, f"{lesson.id}/{section.id}")
                expected = preceding[-2:] or [next(s for s in lesson.sections if isinstance(s, ExplanationSection))]
                self.assertEqual([m.description for m in material], [f'material — "{s.title}": {s.body}' for s in expected], f"{lesson.id}/{section.id}")
                # a long lesson never dumps every explanation into one prompt
                every_explanation = [s for s in lesson.sections if isinstance(s, ExplanationSection)]
                if len(every_explanation) > 2:
                    self.assertLess(len(material), len(every_explanation), f"{lesson.id}/{section.id}")

    def test_only_the_current_section_is_included_not_the_whole_lesson(self) -> None:
        ctx = resolve_lesson_context("phase", "s1")
        text = " ".join(f.description for f in ctx.facts)
        self.assertNotIn(PHASE_REFLECTION, text)  # the reflection
        self.assertNotIn(PHASE_LAB, text)  # the lab
        self.assertNotIn(prose("phase", "s3"), text)  # a later explanation

    def test_facts_are_l_prefixed_unique_and_carry_no_result_id(self) -> None:
        ctx = resolve_lesson_context("phase", "s5")
        ids = [f.id for f in ctx.facts]
        self.assertEqual(ids, [f"L{i}" for i in range(1, len(ids) + 1)])
        self.assertTrue(all(f.result_id is None for f in ctx.facts))

    def test_unknown_lesson(self) -> None:
        with self.assertRaises(LessonContextError) as ctx:
            resolve_lesson_context("no-such-lesson")
        self.assertEqual(ctx.exception.code, LESSON_NOT_FOUND)

    def test_unknown_section(self) -> None:
        with self.assertRaises(LessonContextError) as ctx:
            resolve_lesson_context("phase", "s99")
        self.assertEqual(ctx.exception.code, SECTION_NOT_FOUND)

    def test_section_belonging_to_another_lesson_is_a_mismatch(self) -> None:
        # A foundation lesson has s1..s9; s10 exists only in the six ten-section lessons (the three advanced ones and the
        # three batch-1 lessons), so the message names the first three owners and then truncates.
        with self.assertRaises(LessonContextError) as ctx:
            resolve_lesson_context("phase", "s10")
        self.assertEqual(ctx.exception.code, SECTION_MISMATCH)
        self.assertIn("'phase'", ctx.exception.message)
        for owner in ("phase-kickback", "deutsch-jozsa", "bernstein-vazirani"):
            self.assertIn(owner, ctx.exception.message)
        self.assertIn("…", ctx.exception.message)
        self.assertNotIn("superdense-coding", ctx.exception.message)  # the fourth owner onward is left out, not listed

    def test_the_mismatch_message_names_a_few_owners_not_the_whole_catalog(self) -> None:
        # The real catalog no longer has a section id owned by more than three other
        # lessons, so the truncation is exercised on a synthetic one.
        from unittest import mock

        phase = get_lesson("phase")
        owners = [phase.model_copy(update={"id": f"owner-{i}"}) for i in range(5)]
        trimmed = [
            o.model_copy(update={"sections": [*o.sections, o.sections[0].model_copy(update={"id": "sX"})]})
            for o in owners
        ]
        with mock.patch("qentor.tutor.lesson_context.LESSONS", [phase, *trimmed]):
            with self.assertRaises(LessonContextError) as ctx:
                resolve_lesson_context("phase", "sX")
        self.assertEqual(ctx.exception.code, SECTION_MISMATCH)
        self.assertIn("owner-0, owner-1, owner-2, …", ctx.exception.message)
        self.assertNotIn("owner-3", ctx.exception.message)

    def test_a_concept_checks_answer_is_never_in_any_fact(self) -> None:
        """A hint must not give the quiz answer away: neither the correct option
        text nor the answer rationale may reach the fact sheet."""
        checked = 0
        for lesson in LESSONS:
            for section in lesson.sections:
                if not isinstance(section, ConceptCheckSection) or section.correct_option_id is None:
                    continue
                checked += 1
                text = " ".join(f.description for f in resolve_lesson_context(lesson.id, section.id).facts)
                teaching = " ".join(s.body for s in lesson.sections if isinstance(s, ExplanationSection))
                # The answer rationale and the option list never enter the facts.
                self.assertNotIn(section.explanation, text, f"{lesson.id}/{section.id}")
                for option in section.options:
                    # (An option may legitimately reappear inside the lesson's own
                    # explanatory text, which the learner can already read.)
                    if option.text not in teaching:
                        self.assertNotIn(option.text, text, f"{lesson.id}/{section.id}/{option.id}")
        self.assertGreater(checked, 0)


# --------------------------------------------------------------------------- #
# Deterministic answers                                                       #
# --------------------------------------------------------------------------- #


class TestRouting(unittest.TestCase):
    def test_the_three_lesson_questions(self) -> None:
        self.assertEqual(route_question(EXPLAIN), "explain")
        self.assertEqual(route_question("Explain this section"), "explain")
        self.assertEqual(route_question(SIMPLER), "simpler")
        self.assertEqual(route_question(HINT), "hint")

    def test_circuit_and_result_questions_are_not_lesson_questions(self) -> None:
        self.assertEqual(route_question("Explain this circuit"), "circuit")
        self.assertEqual(route_question("Explain my result"), "result")
        self.assertEqual(route_question("What does each gate in this circuit do?"), "circuit")

    def test_explicit_lesson_words_beat_circuit_keywords(self) -> None:
        self.assertEqual(route_question("Explain this concept of a qubit"), "explain")

    def test_word_boundaries_prevent_false_positives(self) -> None:
        # "explain" contains "plain"; "simplest"/"chintz" must not trigger anything by accident.
        self.assertEqual(route_question("Will this win me the lottery?"), "unsupported")


class TestLessonOnlyDeterministicAnswers(unittest.TestCase):
    def _answer(self, question, lesson_id="phase", section_id="s1", language="en"):
        ctx = resolve_lesson_context(lesson_id, section_id)
        return answer_lesson_aware_question(question, ctx, [], None, None, language)

    def test_explain_uses_the_current_section_text(self) -> None:
        answer, fallback = self._answer(EXPLAIN)
        self.assertTrue(fallback)
        self.assertIn(PHASE_S1, answer)
        self.assertIn("L", answer)  # cites lesson fact ids

    def test_explain_differs_by_section(self) -> None:
        s1, _ = self._answer(EXPLAIN, section_id="s1")
        lab, _ = self._answer(EXPLAIN, section_id="s6")
        self.assertNotEqual(s1, lab)
        self.assertIn(PHASE_LAB, lab)
        self.assertNotIn(PHASE_S1, lab)  # s1 is not among the two explanations nearest the lab

    def test_explain_on_a_lesson_with_no_section_uses_the_overview(self) -> None:
        answer, _ = self._answer(EXPLAIN, section_id=None)
        self.assertIn(PHASE_DESC, answer)

    def test_simpler_is_short_and_from_the_lesson(self) -> None:
        simpler, _ = self._answer(SIMPLER)
        explain, _ = self._answer(EXPLAIN)
        self.assertTrue(simpler.startswith("In short:"))
        self.assertIn(PHASE_DESC, simpler)
        # "Simpler" cites fewer lesson facts than the full explanation.
        self.assertLess(simpler.count("(L"), explain.count("(L"))

    def test_hint_on_a_quiz_points_at_the_material_and_not_the_answer(self) -> None:
        answer, _ = self._answer(HINT, "interference", INTERF_QUIZ)
        self.assertTrue(answer.startswith("A hint:"))
        self.assertIn(INTERF_MATERIAL, answer)
        # The correct option and the answer rationale are absent.
        self.assertNotIn(INTERF_CORRECT, answer)
        self.assertNotIn(INTERF_RATIONALE, answer)

    def test_hint_on_a_lab_quotes_the_instructions(self) -> None:
        answer, _ = self._answer(HINT, "phase", "s6")
        self.assertIn(PHASE_LAB, answer)

    def test_circuit_or_result_question_without_a_result_is_honest_not_invented(self) -> None:
        for q in ("What was the result?", "Explain this circuit"):
            answer, fallback = self._answer(q)
            self.assertTrue(fallback)
            self.assertIn("no executed result", answer)
            self.assertFalse(DECIMAL.search(answer), answer)

    def test_unrelated_question_says_it_has_no_answer(self) -> None:
        answer, _ = self._answer("Will this win me the lottery?")
        self.assertIn("don't have a deterministic answer", answer)

    def test_no_lesson_answer_contains_a_decimal_or_percentage_for_any_lesson_section_or_question(self) -> None:
        """Lesson answers must never introduce a quantum value: sweep the whole
        registry with every lesson intent."""
        swept = 0
        for lesson in LESSONS:
            for section_id in [None, *[s.id for s in lesson.sections]]:
                for q in (EXPLAIN, SIMPLER, HINT, "What was the result?"):
                    answer, _ = self._answer(q, lesson.id, section_id)
                    swept += 1
                    self.assertFalse(DECIMAL.search(answer), f"{lesson.id}/{section_id}/{q}: {answer}")
        self.assertGreater(swept, 100)

    def test_english_hindi_kannada_wrappers(self) -> None:
        en, _ = self._answer(EXPLAIN, language="en")
        hi, _ = self._answer(EXPLAIN, language="hi")
        kn, _ = self._answer(EXPLAIN, language="kn")
        self.assertIn("About this part of the lesson:", en)
        self.assertIn(HI_EXPLAIN, hi)
        self.assertIn(KN_EXPLAIN, kn)
        # The lesson text itself, gate names and notation are not translated.
        for answer in (en, hi, kn):
            self.assertIn(PHASE_S1, answer)
            self.assertIn("(L", answer)

    def test_hindi_and_kannada_hint_and_simpler_wrappers(self) -> None:
        self.assertIn("संकेत", self._answer(HINT, language="hi")[0])
        self.assertIn("ಸುಳಿವು", self._answer(HINT, language="kn")[0])
        self.assertIn("संक्षेप में", self._answer(SIMPLER, language="hi")[0])
        self.assertIn("ಸಂಕ್ಷಿಪ್ತವಾಗಿ", self._answer(SIMPLER, language="kn")[0])

    def test_unrecognised_language_falls_back_to_english(self) -> None:
        answer, _ = self._answer(EXPLAIN, language="fr")
        self.assertIn("About this part of the lesson:", answer)


# --------------------------------------------------------------------------- #
# LLM adapter / prompt                                                        #
# --------------------------------------------------------------------------- #


def _capture_anthropic_request(adapter, *args, **kwargs):
    """Run ``adapter.generate`` with the network stubbed; return the parsed request body."""
    captured: dict = {}

    def fake_urlopen(request, timeout=None):
        captured["body"] = json.loads(request.data.decode("utf-8"))
        response = MagicMock()
        response.read.return_value = json.dumps(
            {"content": [{"text": json.dumps({"answer": "ok", "cited_fact_ids": []})}]}
        ).encode("utf-8")
        response.__enter__.return_value = response
        return response

    with patch("qentor.tutor.llm.urllib.request.urlopen", fake_urlopen):
        adapter.generate(*args, **kwargs)
    return captured["body"]


class TestLLMAdapterLessonContext(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = AnthropicAdapter(api_key="sk-fake-test-key")
        self.lesson = resolve_lesson_context("phase", "s1")

    def test_adapter_request_carries_lesson_context_result_facts_question_and_language(self) -> None:
        body = _capture_anthropic_request(
            self.adapter, "Why didn't the probability change?", [], "hi", lesson_facts=list(self.lesson.facts)
        )
        content = body["messages"][0]["content"]
        self.assertIn("LESSON CONTEXT:", content)
        self.assertIn(PHASE_S1, content)
        self.assertIn("QUANTUM RESULT FACTS:", content)
        self.assertIn("USER QUESTION: Why didn't the probability change?", content)
        self.assertIn("LANGUAGE: Hindi", content)
        self.assertLess(content.index("LESSON CONTEXT"), content.index("QUANTUM RESULT FACTS"))
        self.assertLess(content.index("QUANTUM RESULT FACTS"), content.index("USER QUESTION"))
        # ...and the system prompt actually sent carries BOTH the original trust
        # rules and the lesson addendum (not just the helper that builds it).
        self.assertEqual(body["system"], _system_prompt("hi", with_lesson_context=True))
        self.assertTrue(body["system"].endswith(_LESSON_PROMPT_ADDENDUM))
        self.assertIn("must never invent a probability", body["system"])

    def test_with_no_result_the_prompt_says_so_instead_of_leaving_it_blank(self) -> None:
        body = _capture_anthropic_request(self.adapter, "q", [], "en", lesson_facts=list(self.lesson.facts))
        self.assertIn("no executed result is attached", body["messages"][0]["content"])

    def test_the_lesson_free_request_shape_is_unchanged(self) -> None:
        body = _capture_anthropic_request(self.adapter, "What was the result?", [], "en")
        self.assertEqual(body["messages"][0]["content"], "Facts:\n(no facts)\n\nQuestion: What was the result?")
        self.assertEqual(body["system"], _system_prompt("en"))
        self.assertNotIn("LESSON CONTEXT", body["system"])

    def test_system_prompt_keeps_the_quantum_trust_rules_with_and_without_lesson(self) -> None:
        for with_lesson in (False, True):
            prompt = _system_prompt("kn", with_lesson_context=with_lesson)
            self.assertIn("must never invent a probability", prompt)
            self.assertIn("Cite every fact", prompt)
            self.assertIn("Kannada", prompt)
            self.assertIn("bitstrings must stay exactly as given", prompt)

    def test_lesson_addendum_restates_the_trust_boundary(self) -> None:
        prompt = _system_prompt("en", with_lesson_context=True)
        self.assertTrue(prompt.endswith(_LESSON_PROMPT_ADDENDUM))
        for phrase in (
            "LESSON CONTEXT",
            "QUANTUM RESULT FACTS",
            "ONLY",
            "Never calculate or estimate a new circuit result",
            "do not state any measurement outcome",
            "instead of guessing",
            "backend names and hashes exactly as given",
        ):
            self.assertIn(phrase, prompt)


# --------------------------------------------------------------------------- #
# Orchestration: guard + fallback                                             #
# --------------------------------------------------------------------------- #


class TestLessonAwareOrchestration(unittest.TestCase):
    def setUp(self) -> None:
        self.lesson = resolve_lesson_context("phase", "s1")

    def test_llm_receives_lesson_facts_separately_from_result_facts(self) -> None:
        llm = RecordingLLM(LLMDraft(answer="Z flips a sign (L3).", cited_fact_ids=["L3"]))
        answer, fallback = answer_lesson_aware_question(EXPLAIN, self.lesson, [], None, llm, "en")
        self.assertFalse(fallback)
        self.assertEqual(answer, "Z flips a sign (L3).")
        (call,) = llm.calls
        self.assertEqual(call["facts"], [])
        self.assertEqual([f.id for f in call["lesson_facts"]], [f.id for f in self.lesson.facts])

    def test_guard_accepts_a_citation_to_a_lesson_fact_and_a_number_from_one(self) -> None:
        # "|1>" style text has no decimals; use the overview which mentions none — cite it.
        llm = RecordingLLM(LLMDraft(answer="See the overview (L1).", cited_fact_ids=["L1"]))
        _, fallback = answer_lesson_aware_question(EXPLAIN, self.lesson, [], None, llm, "en")
        self.assertFalse(fallback)

    def test_guard_rejects_an_invented_number_and_falls_back_to_the_lesson(self) -> None:
        llm = RecordingLLM(LLMDraft(answer="The probability is 0.707107 (L3).", cited_fact_ids=["L3"]))
        answer, fallback = answer_lesson_aware_question(EXPLAIN, self.lesson, [], None, llm, "en")
        self.assertTrue(fallback)
        self.assertNotIn("0.707107", answer)
        self.assertIn(PHASE_S1, answer)

    def test_guard_rejects_a_citation_to_a_fact_that_does_not_exist(self) -> None:
        llm = RecordingLLM(LLMDraft(answer="Trust me (L99).", cited_fact_ids=["L99"]))
        answer, fallback = answer_lesson_aware_question(EXPLAIN, self.lesson, [], None, llm, "en")
        self.assertTrue(fallback)
        self.assertNotIn("Trust me", answer)

    def test_provider_failure_falls_back_to_the_deterministic_lesson_answer(self) -> None:
        llm = RecordingLLM(raises=LLMUnavailable("connection refused"))
        answer, fallback = answer_lesson_aware_question(HINT, self.lesson, [], None, llm, "en")
        self.assertTrue(fallback)
        self.assertTrue(answer.startswith("A hint:"))

    def test_no_llm_uses_the_deterministic_answer(self) -> None:
        answer, fallback = answer_lesson_aware_question(EXPLAIN, self.lesson, [], None, None, "en")
        self.assertTrue(fallback)
        self.assertIn("About this part of the lesson:", answer)


# --------------------------------------------------------------------------- #
# Endpoint                                                                    #
# --------------------------------------------------------------------------- #


class TestEndpointLessonOnly(TutorEndpointTestCase):
    def setUp(self) -> None:
        super().setUp()
        patcher = patch.object(app_module, "_llm_adapter", None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_lesson_id_only(self) -> None:
        response = ask(question=EXPLAIN, lesson_id="phase")
        self.assertEqual(response.lesson_id, "phase")
        self.assertIsNone(response.section_id)
        self.assertTrue(response.used_fallback_template)
        self.assertIn(PHASE_DESC, response.answer)

    def test_lesson_id_and_section_id(self) -> None:
        response = ask(question=EXPLAIN, lesson_id="phase", section_id="s1")
        self.assertEqual((response.lesson_id, response.section_id), ("phase", "s1"))
        self.assertIn(PHASE_S1, response.answer)

    def test_lesson_only_answer_is_not_presented_as_a_quantum_result(self) -> None:
        response = ask(question=EXPLAIN, lesson_id="phase", section_id="s1")
        self.assertIsNone(response.result_id)
        self.assertIsNone(response.circuit_hash)
        self.assertIsNone(response.provenance_class)
        self.assertIsNone(response.verification_status)
        self.assertGreater(len(response.facts), 0)
        for fact in response.facts:
            self.assertTrue(fact.id.startswith("L"))
            self.assertIsNone(fact.result_id)
            self.assertNotIn(fact.kind, ("probability", "amplitude", "execution_status", "circuit_summary"))

    def test_the_three_learn_quick_actions_are_answered_from_the_lesson_without_an_llm(self) -> None:
        cases = [
            ("qubits-measurement", "s1", EXPLAIN, QM_S1),
            ("phase", "s1", SIMPLER, PHASE_DESC),
            ("interference", INTERF_QUIZ, HINT, INTERF_MATERIAL),
        ]
        for lesson_id, section_id, question, expected in cases:
            with self.subTest(lesson=lesson_id, section=section_id, question=question):
                response = ask(question=question, lesson_id=lesson_id, section_id=section_id)
                self.assertIn(expected, response.answer)
                self.assertTrue(response.used_fallback_template)

    def test_languages(self) -> None:
        self.assertIn("About this part of the lesson:", ask(question=EXPLAIN, lesson_id="phase", section_id="s1").answer)
        hi = ask(question=EXPLAIN, lesson_id="phase", section_id="s1", language="hi").answer
        kn = ask(question=EXPLAIN, lesson_id="phase", section_id="s1", language="kn").answer
        self.assertIn(HI_EXPLAIN, hi)
        self.assertIn(KN_EXPLAIN, kn)
        self.assertIn(PHASE_S1, hi)
        self.assertIn(PHASE_S1, kn)

    def test_result_question_with_no_result_is_honest(self) -> None:
        response = ask(question="What was the result?", lesson_id="phase", section_id="s1")
        self.assertIn("no executed result", response.answer)
        self.assertIsNone(response.result_id)

    def test_lesson_answer_writes_nothing_to_the_provenance_log(self) -> None:
        with patch.object(self.store, "insert") as insert, patch.object(self.store, "get") as get:
            ask(question=EXPLAIN, lesson_id="phase", section_id="s1")
        insert.assert_not_called()
        get.assert_not_called()  # a lesson-only question never even reads the log


class TestEndpointInvalidLessonContext(TutorEndpointTestCase):
    def _error(self, **kwargs) -> HTTPException:
        with self.assertRaises(HTTPException) as ctx:
            ask(question=EXPLAIN, **kwargs)
        return ctx.exception

    def test_invalid_lesson_id(self) -> None:
        exc = self._error(lesson_id="not-a-lesson")
        self.assertEqual(exc.status_code, 404)
        self.assertEqual(exc.detail["code"], "TUTOR_LESSON_NOT_FOUND")
        self.assertIn("not-a-lesson", exc.detail["message"])

    def test_invalid_section_id(self) -> None:
        exc = self._error(lesson_id="phase", section_id="s99")
        self.assertEqual(exc.status_code, 404)
        self.assertEqual(exc.detail["code"], "TUTOR_SECTION_NOT_FOUND")

    def test_section_from_the_wrong_lesson(self) -> None:
        exc = self._error(lesson_id="phase", section_id="s10")
        self.assertEqual(exc.status_code, 422)
        self.assertEqual(exc.detail["code"], "TUTOR_SECTION_MISMATCH")

    def test_errors_are_structured_and_carry_no_stack_trace(self) -> None:
        exc = self._error(lesson_id="not-a-lesson")
        self.assertEqual(set(exc.detail), {"code", "message"})
        self.assertNotIn("Traceback", exc.detail["message"])

    def test_an_invalid_lesson_is_never_silently_ignored_even_with_a_valid_result(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)
        with self.assertRaises(HTTPException) as ctx:
            ask(result_id=record.result_id, circuit=BELL, question="What was the result?", lesson_id="nope")
        self.assertEqual(ctx.exception.detail["code"], "TUTOR_LESSON_NOT_FOUND")


class TestEndpointLessonPlusResult(TutorEndpointTestCase):
    def setUp(self) -> None:
        super().setUp()
        patcher = patch.object(app_module, "_llm_adapter", None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_lesson_and_real_result_coexist_in_one_response(self) -> None:
        record = self._insert_record(H_Z, "statevector")
        response = ask(
            result_id=record.result_id,
            circuit=H_Z,
            question="Why didn't the probability change?",
            lesson_id="phase",
            section_id="s1",
        )
        # Provenance is the result's, unchanged.
        self.assertEqual(response.result_id, record.result_id)
        self.assertEqual(response.circuit_hash, record.circuit_hash)
        self.assertEqual(response.provenance_class, "SIMULATION")
        self.assertEqual(response.verification_status, "STATE_CHECKED")
        self.assertEqual((response.lesson_id, response.section_id), ("phase", "s1"))
        # Both fact sources are present and distinguishable.
        result_facts = [f for f in response.facts if f.id.startswith("F")]
        lesson_facts = [f for f in response.facts if f.id.startswith("L")]
        self.assertGreater(len(result_facts), 0)
        self.assertGreater(len(lesson_facts), 0)
        self.assertTrue(all(f.result_id == record.result_id for f in result_facts))
        self.assertTrue(all(f.result_id is None for f in lesson_facts))
        # The answer quotes the backend's amplitudes verbatim and adds the lesson.
        for fact in result_facts:
            if fact.kind == "amplitude":
                self.assertIn(fact.description, response.answer)
        self.assertIn("Lesson context:", response.answer)
        self.assertIn(PHASE_S1, response.answer)

    def test_result_numbers_are_the_backends_not_the_lessons(self) -> None:
        record = self._insert_record(H_Z, "statevector")
        with_lesson = ask(
            result_id=record.result_id, circuit=H_Z, question="What was the result?", lesson_id="phase", section_id="s1"
        )
        without = ask(result_id=record.result_id, circuit=H_Z, question="What was the result?")
        self.assertEqual(
            [(f.id, f.description) for f in with_lesson.facts if f.id.startswith("F")],
            [(f.id, f.description) for f in without.facts],
        )

    def test_lesson_question_with_a_result_attached_is_still_answered_from_the_lesson(self) -> None:
        record = self._insert_record(H_Z, "statevector")
        response = ask(result_id=record.result_id, circuit=H_Z, question=HINT, lesson_id="phase", section_id="s6")
        self.assertIn(PHASE_LAB, response.answer)
        self.assertEqual(response.result_id, record.result_id)

    def test_a_failed_execution_is_not_explained_but_a_lesson_question_still_is(self) -> None:
        record = self._insert_failed_record(BELL)
        failed = ask(
            result_id=record.result_id, circuit=BELL, question="What was the result?", lesson_id="phase", section_id="s1"
        )
        self.assertIn(record.result_id, failed.answer)
        self.assertIn("ERROR", failed.answer)
        lesson = ask(result_id=record.result_id, circuit=BELL, question=EXPLAIN, lesson_id="phase", section_id="s1")
        self.assertIn(PHASE_S1, lesson.answer)
        self.assertEqual(lesson.verification_status, "ERROR")

    def test_unknown_result_id_and_circuit_mismatch_still_fail_as_before(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            ask(result_id="res_missing", circuit=BELL, question="q", lesson_id="phase")
        self.assertEqual(ctx.exception.status_code, 404)
        record = self._insert_record(H_Z, "statevector")
        with self.assertRaises(HTTPException) as ctx:
            ask(result_id=record.result_id, circuit=BELL, question="q", lesson_id="phase")
        self.assertEqual(ctx.exception.status_code, 422)


class TestEndpointLLMWithLessonContext(TutorEndpointTestCase):
    def _patch_llm(self, adapter) -> None:
        patcher = patch.object(app_module, "_llm_adapter", adapter)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_llm_gets_lesson_facts_and_result_facts_separately(self) -> None:
        record = self._insert_record(H_Z, "statevector")
        llm = RecordingLLM(LLMDraft(answer="Z changes the phase (L3).", cited_fact_ids=["L3"]))
        self._patch_llm(llm)

        response = ask(
            result_id=record.result_id,
            circuit=H_Z,
            question="Why didn't the probability change?",
            lesson_id="phase",
            section_id="s1",
            language="hi",
        )

        self.assertFalse(response.used_fallback_template)
        (call,) = llm.calls
        self.assertEqual(call["language"], "hi")
        self.assertTrue(all(f.id.startswith("F") for f in call["facts"]))
        self.assertTrue(all(f.id.startswith("L") for f in call["lesson_facts"]))
        self.assertEqual([f.description for f in call["facts"]], [f.description for f in build_fact_sheet(H_Z, record)])

    def test_llm_invented_quantum_value_never_reaches_the_response(self) -> None:
        record = self._insert_record(H_Z, "statevector")
        self._patch_llm(RecordingLLM(LLMDraft(answer="P(1) = 0.123456 (L3).", cited_fact_ids=["L3"])))

        response = ask(
            result_id=record.result_id, circuit=H_Z, question="Why?", lesson_id="phase", section_id="s1"
        )

        self.assertTrue(response.used_fallback_template)
        self.assertNotIn("0.123456", response.answer)

    def test_failed_execution_never_calls_the_llm_even_with_lesson_context(self) -> None:
        record = self._insert_failed_record(BELL)
        llm = RecordingLLM(LLMDraft(answer="should not be reached", cited_fact_ids=[]))
        self._patch_llm(llm)

        response = ask(
            result_id=record.result_id, circuit=BELL, question="What was the result?", lesson_id="phase", section_id="s1"
        )

        self.assertEqual(llm.calls, [])
        self.assertNotEqual(response.answer, "should not be reached")

    def test_a_lesson_free_request_still_uses_the_original_llm_call_shape(self) -> None:
        """Old test doubles have `generate(question, facts, language)` and no
        `lesson_facts` parameter — a lesson-free request must not pass one."""
        record = self._insert_record(BELL, "shots", shots=2000)
        calls: list[tuple] = []

        class LegacyLLM:
            name = "legacy"

            def generate(self, question, facts, language="en"):
                calls.append((question, language))
                return LLMDraft(answer="Trust me (F999).", cited_fact_ids=["F999"])

        self._patch_llm(LegacyLLM())
        response = ask(result_id=record.result_id, circuit=BELL, question="What was the result?")
        self.assertEqual(len(calls), 1)
        self.assertTrue(response.used_fallback_template)  # guard rejected F999


class TestLabTutoringUnchanged(TutorEndpointTestCase):
    """N: a request without lesson context behaves exactly as before."""

    def setUp(self) -> None:
        super().setUp()
        patcher = patch.object(app_module, "_llm_adapter", None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_response_has_the_original_shape_and_no_lesson_fields_set(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)
        response = ask(result_id=record.result_id, circuit=BELL, question="What was the result?")
        self.assertIsNone(response.lesson_id)
        self.assertIsNone(response.section_id)
        self.assertEqual(response.result_id, record.result_id)
        self.assertTrue(all(f.id.startswith("F") for f in response.facts))
        self.assertTrue(all(f.result_id == record.result_id for f in response.facts))

    def test_answer_is_exactly_what_the_original_deterministic_path_returns(self) -> None:
        record = self._insert_record(BELL, "shots", shots=2000)
        facts = build_fact_sheet(BELL, record)
        for question in ("What was the result?", "What does this circuit do?", "Will this win me the lottery?"):
            with self.subTest(question=question):
                response = ask(result_id=record.result_id, circuit=BELL, question=question)
                self.assertEqual(response.answer, answer_question(question, facts, record))

    def test_lesson_keywords_do_not_hijack_a_lab_question(self) -> None:
        """Without lesson context, "Give me a hint" gets the original answer —
        the lesson router is only consulted when a lesson is attached."""
        record = self._insert_record(BELL, "shots", shots=2000)
        response = ask(result_id=record.result_id, circuit=BELL, question=HINT)
        self.assertEqual(response.answer, UNSUPPORTED_QUESTION_ANSWER)


class TestFreeTextLessonQuestions(unittest.TestCase):
    """A learner types a normal question with a lesson open and no Lab result.
    The router must be useful there (not a dead end) without inventing anything."""

    def _ask(self, question, lesson_id, section_id, language="en"):
        ctx = resolve_lesson_context(lesson_id, section_id)
        return answer_lesson_aware_question(question, ctx, [], None, None, language)[0]

    def test_what_is_a_qubit_is_a_lesson_question_even_though_qubit_is_a_circuit_keyword(self) -> None:
        answer = self._ask("What is a qubit?", "qubits-measurement", "s1")
        self.assertIn(QM_S1, answer)
        self.assertNotIn("no executed result", answer)

    def test_what_is_measurement_is_a_lesson_question_even_though_measure_is_a_result_keyword(self) -> None:
        answer = self._ask("What is measurement?", "qubits-measurement", "s1")
        self.assertIn(QM_S1, answer)
        self.assertNotIn("no executed result", answer)

    def test_what_is_interference_uses_the_interference_lesson(self) -> None:
        answer = self._ask("What is interference?", "interference", INTERF_QUIZ)
        self.assertIn(INTERF_MATERIAL, answer)

    def test_the_lesson_that_is_open_decides_the_answer(self) -> None:
        a = self._ask("What is a qubit?", "qubits-measurement", "s1")
        b = self._ask("What is a qubit?", "phase", "s1")
        self.assertNotEqual(a, b)
        self.assertIn(PHASE_S1, b)

    def test_follow_up_more_simply_is_a_simpler_request_in_the_same_lesson(self) -> None:
        for q in ("Explain that more simply.", "Can you explain that more simply?", "Could you make it simpler?"):
            with self.subTest(q=q):
                answer = self._ask(q, "interference", "s1")
                self.assertTrue(answer.startswith("In short:"), answer)
                self.assertIn(INTERF_DESC, answer)

    def test_asking_for_the_result_or_circuit_with_none_attached_stays_honest_even_if_the_lesson_says_result(self) -> None:
        # interference's own objective says "Predict the result of H, Z, H ...",
        # so "result" IS a lesson word here — the no-result message must still win.
        for q in ("What was the result?", "Explain my result", "Explain this circuit"):
            with self.subTest(q=q):
                answer = self._ask(q, "interference", "s2")
                self.assertIn("no executed result", answer)
                self.assertFalse(DECIMAL.search(answer))

    def test_off_topic_questions_are_not_answered_with_lesson_text(self) -> None:
        for q in ("What is the capital of France?", "Will this win me the lottery?", "Tell me a joke"):
            with self.subTest(q=q):
                answer = self._ask(q, "phase", "s1")
                self.assertIn("don't have a deterministic answer", answer)
                self.assertNotIn("Z gate", answer)

    def test_fact_sheet_scaffolding_words_do_not_make_a_question_on_topic(self) -> None:
        # "objective", "explanation", "section"-style words appear in every fact
        # description but are not lesson prose; they must not count as topical.
        ctx = resolve_lesson_context("phase", "s1")
        self.assertNotIn("objective", ctx.topic_text.lower())
        from qentor.tutor.lesson_answers import is_about_lesson

        self.assertFalse(is_about_lesson("Can I get an objective explanation of football?", ctx))
        self.assertTrue(is_about_lesson("Why does Z change the phase?", ctx))

    def test_topic_text_never_contains_a_quiz_answer_or_rationale(self) -> None:
        for lesson in LESSONS:
            for section in lesson.sections:
                if isinstance(section, ConceptCheckSection) and section.explanation:
                    topic = resolve_lesson_context(lesson.id, section.id).topic_text
                    self.assertNotIn(section.explanation, topic, f"{lesson.id}/{section.id}")

    def test_stemming_matches_plurals_and_verb_forms(self) -> None:
        from qentor.tutor.lesson_answers import is_about_lesson

        ctx = resolve_lesson_context("phase", "s1")  # says "probabilities"
        self.assertTrue(is_about_lesson("Did the probability change?", ctx))

    def test_hindi_and_kannada_free_text_use_the_localised_wrapper(self) -> None:
        self.assertIn(HI_EXPLAIN, self._ask("What is a qubit?", "qubits-measurement", "s1", "hi"))
        self.assertIn(KN_EXPLAIN, self._ask("What is a qubit?", "qubits-measurement", "s1", "kn"))

    def test_no_free_text_answer_for_any_lesson_contains_a_decimal_or_percentage(self) -> None:
        swept = 0
        for lesson in LESSONS:
            for section_id in [None, *[s.id for s in lesson.sections]]:
                for q in ("What is a qubit?", "What is phase?", "Explain that more simply.", "Why did the probability change?"):
                    self.assertFalse(DECIMAL.search(self._ask(q, lesson.id, section_id)), f"{lesson.id}/{section_id}/{q}")
                    swept += 1
        self.assertGreater(swept, 100)

    def test_with_a_result_attached_an_unrecognised_on_topic_question_is_answered_from_the_lesson(self) -> None:
        # (the result-question path is unchanged and covered elsewhere)
        ctx = resolve_lesson_context("phase", "s1")
        from qentor.tutor.facts import build_fact_sheet
        from qentor.provenance.models import ProvenanceClass, ProvenanceRecord
        from qentor.provenance.models import ExecutionStatus
        from qentor.circuit.hashing import circuit_hash

        record = ProvenanceRecord.new(
            circuit_hash=circuit_hash(H_Z), backend="qiskit-aer", backend_version="0.17.2",
            execution_mode="statevector", provenance_class=ProvenanceClass.SIMULATION,
            verification_status=ExecutionStatus.STATE_CHECKED,
            payload={"execution_id": "aer-local-fake", "statevector": [[0.7071067811865476, 0.0], [-0.7071067811865476, 0.0]]},
        )
        facts = build_fact_sheet(H_Z, record)
        answer, _ = answer_lesson_aware_question("What is phase?", ctx, facts, record, None, "en")
        self.assertIn(PHASE_S1, answer)
        result_answer, _ = answer_lesson_aware_question("What was the result?", ctx, facts, record, None, "en")
        self.assertIn("For this result:", result_answer)  # unchanged result path


class TestEndpointFreeTextLesson(TutorEndpointTestCase):
    def setUp(self) -> None:
        super().setUp()
        patcher = patch.object(app_module, "_llm_adapter", None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_free_text_lesson_question_with_no_result_over_the_endpoint(self) -> None:
        response = ask(question="What is a qubit?", lesson_id="qubits-measurement", section_id="s1")
        self.assertIn(QM_S1, response.answer)
        self.assertEqual((response.lesson_id, response.section_id), ("qubits-measurement", "s1"))
        self.assertIsNone(response.result_id)

    def test_follow_up_in_the_same_lesson_keeps_the_lesson_context(self) -> None:
        first = ask(question="What is a qubit?", lesson_id="qubits-measurement", section_id="s1")
        follow_up = ask(question="Explain that more simply.", lesson_id="qubits-measurement", section_id="s1")
        self.assertEqual((follow_up.lesson_id, follow_up.section_id), (first.lesson_id, first.section_id))
        self.assertTrue(follow_up.answer.startswith("In short:"))


class TestExpandedLessonsWithTheTutor(unittest.TestCase):
    """Phase-2 content: the seven foundation lessons now have nine sections each.
    The tutor must stay compact, honest and answer-safe on every one of them, in
    every language, while reading the registry rather than copying it."""

    FOUNDATION = [
        "qubits-measurement", "bloch-sphere", "superposition", "phase", "interference", "entanglement", "bell-state",
    ]

    def _ask(self, question, lesson_id, section_id, language="en"):
        ctx = resolve_lesson_context(lesson_id, section_id)
        return answer_lesson_aware_question(question, ctx, [], None, None, language)[0]

    def _teaching(self, lesson) -> str:
        return " ".join(s.body for s in lesson.sections if isinstance(s, ExplanationSection))

    def test_explain_simpler_and_hint_work_on_every_section_of_every_foundation_lesson(self) -> None:
        swept = 0
        for lesson_id in self.FOUNDATION:
            for section in get_lesson(lesson_id).sections:
                for question, marker in ((EXPLAIN, "About this part of the lesson:"), (SIMPLER, "In short:"), (HINT, "A hint:")):
                    answer = self._ask(question, lesson_id, section.id)
                    swept += 1
                    self.assertTrue(answer.startswith(marker), f"{lesson_id}/{section.id}/{question}: {answer[:60]}")
                    self.assertFalse(DECIMAL.search(answer), f"{lesson_id}/{section.id}/{question}")
        self.assertEqual(swept, 7 * 9 * 3)

    def test_answers_stay_compact_even_though_lessons_are_longer(self) -> None:
        for lesson_id in self.FOUNDATION:
            for section in get_lesson(lesson_id).sections:
                for question in (EXPLAIN, SIMPLER, HINT):
                    answer = self._ask(question, lesson_id, section.id)
                    limit = 2200 if question == EXPLAIN else 1500
                    self.assertLess(len(answer), limit, f"{lesson_id}/{section.id}/{question}: {len(answer)} chars")

    def test_no_answer_or_fact_for_any_section_leaks_a_quiz_answer_or_rationale(self) -> None:
        checked = 0
        for lesson_id in self.FOUNDATION:
            lesson = get_lesson(lesson_id)
            teaching = self._teaching(lesson)
            for check in [s for s in lesson.sections if isinstance(s, ConceptCheckSection)]:
                # the rationale is quiz-only text: it appears in no explanation
                self.assertNotIn(check.explanation, teaching, f"{lesson_id}/{check.id}")
                correct = next(o.text for o in check.options if o.id == check.correct_option_id)
                for section in lesson.sections:
                    ctx = resolve_lesson_context(lesson_id, section.id)
                    facts = " ".join(f.description for f in ctx.facts)
                    self.assertNotIn(check.explanation, facts, f"{lesson_id}/{section.id}")
                    self.assertNotIn(check.explanation, ctx.topic_text, f"{lesson_id}/{section.id}")
                    if correct not in teaching:
                        self.assertNotIn(correct, facts, f"{lesson_id}/{section.id}")
                    for question in (EXPLAIN, SIMPLER, HINT):
                        answer = self._ask(question, lesson_id, section.id)
                        self.assertNotIn(check.explanation, answer, f"{lesson_id}/{section.id}/{question}")
                        if correct not in teaching:
                            self.assertNotIn(correct, answer, f"{lesson_id}/{section.id}/{question}")
                checked += 1
        self.assertEqual(checked, 14)

    def test_the_whole_endpoint_response_for_a_quiz_section_carries_no_answer_or_rationale(self) -> None:
        for lesson_id in self.FOUNDATION:
            lesson = get_lesson(lesson_id)
            for check in [s for s in lesson.sections if isinstance(s, ConceptCheckSection)]:
                response = ask(question=HINT, lesson_id=lesson_id, section_id=check.id)
                blob = response.model_dump_json()
                self.assertNotIn(check.explanation, blob, f"{lesson_id}/{check.id}")
                self.assertNotIn("correct_option", blob)
                self.assertNotIn("correctOption", blob)

    def test_a_hint_on_a_check_points_at_the_nearest_explanation_and_the_first_objective(self) -> None:
        for lesson_id in self.FOUNDATION:
            lesson = get_lesson(lesson_id)
            for index, section in enumerate(lesson.sections):
                if not isinstance(section, ConceptCheckSection):
                    continue
                nearest = [s for s in lesson.sections[:index] if isinstance(s, ExplanationSection)][-1]
                answer = self._ask(HINT, lesson_id, section.id)
                self.assertIn(nearest.body, answer, f"{lesson_id}/{section.id}")
                self.assertIn(lesson.learning_objectives[0], answer, f"{lesson_id}/{section.id}")

    def test_localised_wrappers_around_english_lesson_prose_on_the_new_content(self) -> None:
        for lesson_id in self.FOUNDATION:
            first = get_lesson(lesson_id).sections[0]
            hi = self._ask(EXPLAIN, lesson_id, first.id, "hi")
            kn = self._ask(EXPLAIN, lesson_id, first.id, "kn")
            self.assertIn(HI_EXPLAIN, hi)
            self.assertIn(KN_EXPLAIN, kn)
            # the lesson prose itself is NOT translated — it is quoted verbatim
            self.assertIn(first.body, hi, lesson_id)
            self.assertIn(first.body, kn, lesson_id)

    def test_free_text_questions_are_answered_from_the_expanded_lessons(self) -> None:
        cases = [
            ("What is the Born rule?", "qubits-measurement", "s3"),
            ("What is a relative phase?", "phase", "s2"),
            ("What is destructive interference?", "interference", "s2"),
            ("Why is a Bell pair entangled?", "bell-state", "s8"),
            ("What does the verifier check?", "bell-state", "s4"),
        ]
        for question, lesson_id, section_id in cases:
            with self.subTest(question=question):
                answer = self._ask(question, lesson_id, section_id)
                self.assertTrue(answer.startswith("About this part of the lesson:"), answer[:80])
                self.assertIn(prose(lesson_id, section_id), answer)

    def test_the_tutor_reads_the_registry_so_changed_lesson_prose_changes_the_answer(self) -> None:
        """Nothing in the tutor holds a copy of lesson text: patch the registry and the
        very next answer quotes the patched text."""
        lesson = get_lesson("phase")
        edited_sections = [
            s.model_copy(update={"body": "SENTINEL: prose that exists only in this test."}) if s.id == "s1" else s
            for s in lesson.sections
        ]
        edited = lesson.model_copy(update={"sections": edited_sections})
        with patch("qentor.tutor.lesson_context.get_lesson", lambda lid: edited if lid == "phase" else get_lesson(lid)):
            answer = self._ask(EXPLAIN, "phase", "s1")
        self.assertIn("SENTINEL: prose that exists only in this test.", answer)
        self.assertNotIn(PHASE_S1, answer)

    def test_no_tutor_source_file_contains_any_lesson_prose(self) -> None:
        """Static guard against duplicating lesson content inside tutor templates."""
        from pathlib import Path

        tutor_dir = Path(__file__).resolve().parents[1] / "qentor" / "tutor"
        source = "\n".join(p.read_text(encoding="utf-8") for p in tutor_dir.glob("*.py"))
        self.assertGreater(len(source), 5000)
        for lesson_id in self.FOUNDATION:
            lesson = get_lesson(lesson_id)
            for s in lesson.sections:
                if isinstance(s, ExplanationSection):
                    # sliding windows, so a copied fragment from anywhere in a body is caught
                    for start in range(0, len(s.body) - 45, 5):
                        window = s.body[start : start + 45]
                        self.assertNotIn(window, source, f"{lesson_id}/{s.id}: {window!r}")
            for objective in lesson.learning_objectives:
                self.assertNotIn(objective[:40], source, lesson_id)
            self.assertNotIn(lesson.short_description, source, lesson_id)

    def test_lesson_facts_sent_to_the_llm_are_the_registrys_and_come_from_the_current_section(self) -> None:
        llm = RecordingLLM(LLMDraft(answer="ok (L1).", cited_fact_ids=["L1"]))
        ctx = resolve_lesson_context("interference", INTERF_QUIZ)
        answer_lesson_aware_question("Explain this concept", ctx, [], None, llm, "en")
        (call,) = llm.calls
        text = " ".join(f.description for f in call["lesson_facts"])
        self.assertIn(INTERF_MATERIAL, text)
        self.assertNotIn(INTERF_CORRECT, text)
        self.assertNotIn(INTERF_RATIONALE, text)
        # only the two nearest explanations reach the prompt, not all five
        self.assertEqual(len([f for f in call["lesson_facts"] if f.kind == "lesson_material"]), 2)


if __name__ == "__main__":
    unittest.main()
