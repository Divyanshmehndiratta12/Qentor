"""Deterministic, no-LLM tutor answers (docs/AI_BOUNDARY.md's "Fallback").

This milestone has no LLM adapter yet — the provider-agnostic adapter in
docs/ARCHITECTURE.md §8 is not built here. Every answer this module produces
is the template path AI_BOUNDARY.md describes for "no API key, a timeout, or
two guard failures": "the server builds a template explanation from the same
facts... labelled 'Explanation generated without AI'." When an LLM adapter is
added later, this module remains that fallback, not dead code — and the fact
sheet it reads from (``qentor.tutor.facts``) is exactly what the LLM step
would also be given as grounding context.

Per docs/ARCHITECTURE.md §10, only the natural-language wrapper text around a
fact is ever translated — every ``TutorFact.description`` (which carries the
gate names, bitstrings and numbers) is interpolated into the chosen
language's template verbatim, never re-translated or reformatted. An
unrecognised ``language`` code falls back to English rather than raising,
since the schema (``qentor.api.schemas.TutorRequest``) is what rejects an
unsupported code outright.
"""

from __future__ import annotations

from qentor.provenance.models import ProvenanceRecord

from .models import TutorFact

_DEFAULT_LANGUAGE = "en"

_CIRCUIT_KEYWORDS = ("circuit", "gate", "qubit", "does this do", "what does")
_RESULT_KEYWORDS = (
    "result",
    "probability",
    "probabilities",
    "outcome",
    "count",
    "counts",
    "measure",
    "measured",
    "statevector",
    "amplitude",
)

_UNSUPPORTED_QUESTION_ANSWERS = {
    "en": (
        "I don't have a deterministic answer for that question yet. Try asking "
        '"what does this circuit do" or "what was the result".'
    ),
    "hi": (
        "मुझे अभी उस प्रश्न का निश्चित उत्तर नहीं पता। कृपया पूछें "
        '"यह सर्किट क्या करता है" या "परिणाम क्या था"।'
    ),
    "kn": (
        "ಆ ಪ್ರಶ್ನೆಗೆ ನನ್ನ ಬಳಿ ಇನ್ನೂ ನಿಖರವಾದ ಉತ್ತರವಿಲ್ಲ. ದಯವಿಟ್ಟು "
        '"ಈ ಸರ್ಕ್ಯೂಟ್ ಏನು ಮಾಡುತ್ತದೆ" ಅಥವಾ "ಫಲಿತಾಂಶ ಏನಾಗಿತ್ತು" ಎಂದು ಕೇಳಿ.'
    ),
}

# Kept as a stable, importable constant — historically the only language, and
# still what an omitted/unrecognised language code resolves to.
UNSUPPORTED_QUESTION_ANSWER = _UNSUPPORTED_QUESTION_ANSWERS[_DEFAULT_LANGUAGE]

_CIRCUIT_ANSWER_TEMPLATES = {
    "en": "{description} ({id}).",
    "hi": "{description} ({id})।",
    "kn": "{description} ({id}).",
}

_RESULT_SUMMARY_TEMPLATES = {
    "en": "For this result: {citations}.",
    "hi": "इस परिणाम के लिए: {citations}।",
    "kn": "ಈ ಫಲಿತಾಂಶಕ್ಕಾಗಿ: {citations}.",
}

_NO_VALUE_FACTS_ANSWERS = {
    "en": "This execution recorded no probability or amplitude data to report.",
    "hi": "इस निष्पादन ने रिपोर्ट करने के लिए कोई प्रायिकता या आयाम डेटा दर्ज नहीं किया।",
    "kn": "ಈ ಎಕ್ಸಿಕ್ಯೂಷನ್ ವರದಿ ಮಾಡಲು ಯಾವುದೇ ಸಂಭವನೀಯತೆ ಅಥವಾ ಆಂಪ್ಲಿಟ್ಯೂಡ್ ಡೇಟಾವನ್ನು ದಾಖಲಿಸಿಲ್ಲ.",
}

_FAILED_EXECUTION_TEMPLATES = {
    "en": (
        "The execution for result {result_id} did not succeed "
        "(status: {status}), so there is nothing verified to explain."
    ),
    "hi": (
        "परिणाम {result_id} के लिए निष्पादन सफल नहीं हुआ "
        "(स्थिति: {status}), इसलिए समझाने के लिए कोई सत्यापित जानकारी नहीं है।"
    ),
    "kn": (
        "ಫಲಿತಾಂಶ {result_id} ಗಾಗಿ ಎಕ್ಸಿಕ್ಯೂಷನ್ ಯಶಸ್ವಿಯಾಗಲಿಲ್ಲ "
        "(ಸ್ಥಿತಿ: {status}), ಆದ್ದರಿಂದ ವಿವರಿಸಲು ಯಾವುದೇ ಪರಿಶೀಲಿಸಿದ ಮಾಹಿತಿ ಇಲ್ಲ."
    ),
}


def answer_question(
    question: str,
    facts: list[TutorFact],
    record: ProvenanceRecord,
    language: str = _DEFAULT_LANGUAGE,
) -> str:
    """Only meaningful for a successful execution — see ``answer_failed_execution``
    for the case where ``record``'s own execution did not succeed.

    ``language`` only ever selects which wrapper-text template is used; the
    question is still matched against the same English keyword lists
    regardless of ``language`` — this is about the learner's chosen *answer*
    language, not the language they typed the question in.
    """
    q = question.lower()

    if any(keyword in q for keyword in _CIRCUIT_KEYWORDS):
        circuit_fact = next(f for f in facts if f.kind == "circuit_summary")
        template = _CIRCUIT_ANSWER_TEMPLATES.get(language, _CIRCUIT_ANSWER_TEMPLATES[_DEFAULT_LANGUAGE])
        return template.format(description=circuit_fact.description, id=circuit_fact.id)

    if any(keyword in q for keyword in _RESULT_KEYWORDS):
        return _answer_result_summary(facts, language)

    return _UNSUPPORTED_QUESTION_ANSWERS.get(language, _UNSUPPORTED_QUESTION_ANSWERS[_DEFAULT_LANGUAGE])


def answer_failed_execution(record: ProvenanceRecord, language: str = _DEFAULT_LANGUAGE) -> str:
    template = _FAILED_EXECUTION_TEMPLATES.get(language, _FAILED_EXECUTION_TEMPLATES[_DEFAULT_LANGUAGE])
    return template.format(result_id=record.result_id, status=record.verification_status.value)


def _answer_result_summary(facts: list[TutorFact], language: str = _DEFAULT_LANGUAGE) -> str:
    value_facts = [f for f in facts if f.kind in ("probability", "amplitude")]
    if not value_facts:
        return _NO_VALUE_FACTS_ANSWERS.get(language, _NO_VALUE_FACTS_ANSWERS[_DEFAULT_LANGUAGE])
    citations = "; ".join(f"{f.description} ({f.id})" for f in value_facts)
    template = _RESULT_SUMMARY_TEMPLATES.get(language, _RESULT_SUMMARY_TEMPLATES[_DEFAULT_LANGUAGE])
    return template.format(citations=citations)
