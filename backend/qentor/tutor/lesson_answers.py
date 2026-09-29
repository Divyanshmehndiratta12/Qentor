"""Deterministic (no-LLM) answers for lesson-aware questions.

Same contract as ``qentor.tutor.deterministic``: only the wrapper text around a
fact is localized; every ``TutorFact.description`` (lesson prose, gate names,
ids, bitstrings, numbers) is interpolated verbatim, never translated or
reformatted. Lesson prose is authored in English in ``qentor.lessons``, so a
Hindi or Kannada answer is a localized wrapper around English lesson text.

Routing is one small layer, not a keyword matrix:

    hint | simpler | explain   -> answered from the lesson facts
    circuit | result           -> the existing deterministic answer, unchanged
    anything else              -> an honest "no deterministic answer"

Explicit lesson words (hint, simpler, concept, section, lesson) win over the
circuit/result keywords, so "explain this concept about qubits" is a lesson
question; "explain this circuit" and "explain my result" are not.

Nothing here produces a quantum number. With a result attached, the result
facts are quoted by the existing deterministic answer; without one, a circuit
or result question gets a plain "run a circuit first" message.
"""

from __future__ import annotations

import re
from typing import Literal

from qentor.provenance.models import ProvenanceRecord

from .deterministic import _CIRCUIT_KEYWORDS, _DEFAULT_LANGUAGE, _RESULT_KEYWORDS, answer_question
from .lesson_context import LessonContext
from .models import TutorFact

Route = Literal["hint", "simpler", "explain", "circuit", "result", "unsupported"]

_HINT = re.compile(r"\b(hints?|clues?)\b")
_SIMPLER = re.compile(r"\b(simpler|simply|simple|simplify|easier|eli5)\b")
_LESSON_WORDS = re.compile(r"\b(concept|section|lesson)\b")
_EXPLAIN = re.compile(r"\bexplain\b")
_RESULT_WORD = re.compile(r"\bresults?\b")
_CIRCUIT_WORD = re.compile(r"\bcircuits?\b")
_WORD = re.compile(r"[a-z]+")

# Generic English words that say nothing about a topic. Deliberately small: this
# is not a topic matrix, just enough that "what does this do" is not "about"
# every lesson. Topic words come from the lesson's own prose (`topic_text`).
_STOPWORDS = frozenset(
    "what this that these those does doing with have from your about where when which would could should "
    "they them then than there here into more less some much many also just very been were will please "
    "tell show give explain mean means work works make like need want know thing things only each every "
    "other another because while after before again still even ever being both such over under same".split()
)

_EXPLAIN_TEMPLATES = {
    "en": "About this part of the lesson: {citations}.",
    "hi": "पाठ के इस भाग के बारे में: {citations}।",
    "kn": "ಪಾಠದ ಈ ಭಾಗದ ಬಗ್ಗೆ: {citations}.",
}
_SIMPLER_TEMPLATES = {
    "en": "In short: {citations}.",
    "hi": "संक्षेप में: {citations}।",
    "kn": "ಸಂಕ್ಷಿಪ್ತವಾಗಿ: {citations}.",
}
_HINT_TEMPLATES = {
    "en": "A hint: {citations}. Try working it out yourself before checking.",
    "hi": "एक संकेत: {citations}। जाँचने से पहले खुद हल करने की कोशिश करें।",
    "kn": "ಒಂದು ಸುಳಿವು: {citations}. ಪರಿಶೀಲಿಸುವ ಮೊದಲು ನೀವೇ ಪರಿಹರಿಸಲು ಪ್ರಯತ್ನಿಸಿ.",
}
_LESSON_NOTE_TEMPLATES = {
    "en": "Lesson context: {citations}.",
    "hi": "पाठ का संदर्भ: {citations}।",
    "kn": "ಪಾಠದ ಸಂದರ್ಭ: {citations}.",
}
_NO_MATERIAL_ANSWERS = {
    "en": "I don't have enough lesson material to answer that.",
    "hi": "इसका उत्तर देने के लिए मेरे पास पर्याप्त पाठ सामग्री नहीं है।",
    "kn": "ಅದಕ್ಕೆ ಉತ್ತರಿಸಲು ನನ್ನ ಬಳಿ ಸಾಕಷ್ಟು ಪಾಠ ಸಾಮಗ್ರಿ ಇಲ್ಲ.",
}
_NO_RESULT_ANSWERS = {
    "en": "There is no executed result to explain yet. Run a circuit in the Lab first, then ask again.",
    "hi": "समझाने के लिए अभी कोई निष्पादित परिणाम नहीं है। पहले Lab में एक सर्किट चलाएँ, फिर दोबारा पूछें।",
    "kn": "ವಿವರಿಸಲು ಇನ್ನೂ ಯಾವುದೇ ಕಾರ್ಯಗತಗೊಂಡ ಫಲಿತಾಂಶವಿಲ್ಲ. ಮೊದಲು Lab ನಲ್ಲಿ ಒಂದು ಸರ್ಕ್ಯೂಟ್ ಚಲಾಯಿಸಿ, ನಂತರ ಮತ್ತೆ ಕೇಳಿ.",
}
_UNSUPPORTED_LESSON_ANSWERS = {
    "en": (
        "I don't have a deterministic answer for that yet. With a lesson open, try "
        '"explain this concept", "give me a simpler explanation" or "give me a hint".'
    ),
    "hi": (
        "मुझे अभी उसका निश्चित उत्तर नहीं पता। पाठ खुला होने पर पूछें "
        '"इस अवधारणा को समझाइए", "इसे सरल तरीके से समझाइए" या "एक संकेत दीजिए"।'
    ),
    "kn": (
        "ಅದಕ್ಕೆ ನನ್ನ ಬಳಿ ಇನ್ನೂ ನಿಖರವಾದ ಉತ್ತರವಿಲ್ಲ. ಪಾಠ ತೆರೆದಿರುವಾಗ "
        '"ಈ ಪರಿಕಲ್ಪನೆಯನ್ನು ವಿವರಿಸಿ", "ಸರಳವಾಗಿ ವಿವರಿಸಿ" ಅಥವಾ "ಒಂದು ಸುಳಿವು ಕೊಡಿ" ಎಂದು ಕೇಳಿ.'
    ),
}


def route_question(question: str) -> Route:
    """Classify a question asked with a lesson open. Pure; no state."""
    q = question.lower()
    if _HINT.search(q):
        return "hint"
    if _SIMPLER.search(q):
        return "simpler"
    if _LESSON_WORDS.search(q):
        return "explain"
    if any(keyword in q for keyword in _CIRCUIT_KEYWORDS):
        return "circuit"
    if any(keyword in q for keyword in _RESULT_KEYWORDS):
        return "result"
    if _EXPLAIN.search(q):
        return "explain"
    return "unsupported"


def is_lesson_route(route: Route) -> bool:
    return route in ("hint", "simpler", "explain")


def _stems(text: str) -> set[str]:
    # A 6-letter prefix makes "probability"/"probabilities" and
    # "measure"/"measured"/"measurement" match without a stemming library.
    return {w[:6] for w in _WORD.findall(text.lower()) if len(w) >= 4 and w not in _STOPWORDS}


def is_about_lesson(question: str, lesson: LessonContext) -> bool:
    """Does the question mention anything this lesson actually covers?

    Data-driven: it is checked against the lesson's own prose
    (``LessonContext.topic_text``), not a hand-written list of topics. "What is
    a qubit?" is about a lesson that mentions qubits; "Will this win me the
    lottery?" is about none of them.
    """
    return bool(_stems(question) & _stems(lesson.topic_text))


def _refine_route(route: Route, question: str, lesson: LessonContext, has_result: bool) -> Route:
    """A free-text question is routed by the keyword router first; with lesson
    context, two corrections make it useful instead of a dead end:

    - With no result attached there is nothing to summarise, so a question that
      asks for "the result"/"the circuit" gets the honest no-result message; any
      OTHER question that is about this lesson (even one that trips a substring
      keyword, e.g. "What is measurement?") is a lesson question.
    - A question the keyword router does not recognise, but which is about this
      lesson, is a lesson question too.
    """
    if is_lesson_route(route):
        return route
    q = question.lower()
    if not has_result and (_RESULT_WORD.search(q) or _CIRCUIT_WORD.search(q)):
        return "result"
    if (route == "unsupported" or not has_result) and is_about_lesson(question, lesson):
        return "explain"
    return route


def answer_lesson_question(
    question: str,
    lesson: LessonContext,
    facts: list[TutorFact],
    record: ProvenanceRecord | None,
    language: str = _DEFAULT_LANGUAGE,
) -> str:
    """``facts``/``record`` are the quantum-result facts, empty/``None`` when
    the request carried no (usable) result."""
    has_result = record is not None and bool(facts)
    route = _refine_route(route_question(question), question, lesson, has_result)

    if is_lesson_route(route):
        chosen = _select_lesson_facts(route, lesson)
        if not chosen:
            return _pick(_NO_MATERIAL_ANSWERS, language)
        templates = {"explain": _EXPLAIN_TEMPLATES, "simpler": _SIMPLER_TEMPLATES, "hint": _HINT_TEMPLATES}[route]
        return _pick(templates, language).format(citations=_cite(chosen))

    if route in ("circuit", "result"):
        if record is None or not facts:
            return _pick(_NO_RESULT_ANSWERS, language)
        base = answer_question(question, facts, record, language)
        context = _lesson_note_facts(lesson)
        if not context:
            return base
        return f"{base}\n\n{_pick(_LESSON_NOTE_TEMPLATES, language).format(citations=_cite(context))}"

    return _pick(_UNSUPPORTED_LESSON_ANSWERS, language)


def _select_lesson_facts(route: Route, lesson: LessonContext) -> list[TutorFact]:
    overview = lesson.of_kind("lesson_overview")
    objectives = lesson.of_kind("lesson_objective")
    section = lesson.of_kind("lesson_section")
    material = lesson.of_kind("lesson_material")
    # What the current section *teaches*: its own text if it is an explanation,
    # otherwise the lesson's explanatory sections it draws on.
    teaching = section if lesson.section_type == "explanation" else material

    if route == "explain":
        if not section:
            return overview + objectives
        # (Lessons have several objectives; two keep the answer short.)
        return section + ([] if lesson.section_type == "explanation" else material) + objectives[:2]

    # `teaching[-1:]` is the explanation closest to the learner's current step.
    if route == "simpler":
        return overview + (teaching[-1:] or section[:1] or objectives[:1])

    # hint: point at the objective and the material — never at the answer.
    if lesson.section_type == "interactive_lab":
        return objectives[:1] + section
    return objectives[:1] + (teaching[-1:] or section[:1])


def _lesson_note_facts(lesson: LessonContext) -> list[TutorFact]:
    return lesson.of_kind("lesson_section") or lesson.of_kind("lesson_overview")


def _cite(facts: list[TutorFact]) -> str:
    return "; ".join(f"{f.description} ({f.id})" for f in facts)


def _pick(templates: dict[str, str], language: str) -> str:
    return templates.get(language, templates[_DEFAULT_LANGUAGE])
