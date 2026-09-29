"""Provider-agnostic LLM adapter for the tutor (docs/ARCHITECTURE.md §8).

This is the only place server-side that is allowed to call an LLM — it never
runs in the browser (nothing in ``web/`` imports or reaches this module), and
it never receives a client-supplied quantum number: callers pass it the
already-built fact sheet (``qentor.tutor.facts.build_fact_sheet``) and the
learner's question text, nothing else.

An ``LLMDraft`` is raw, untrusted output. Nothing in this module decides
whether a draft is safe to show a learner — see ``qentor.tutor.guard`` for
that. ``generate`` must raise ``LLMUnavailable`` on any failure (network,
timeout, malformed response) rather than return a guessed or partial draft.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Protocol

from .models import TutorFact

DEFAULT_MODEL = "claude-opus-5-5"

# docs/AI_BOUNDARY.md §"Fallback": "a timeout of 8 seconds ... the server
# builds a template explanation from the same facts".
REQUEST_TIMEOUT_SECONDS = 8.0

# Canonical language codes per docs/ARCHITECTURE.md §10. An unrecognised code
# falls back to English rather than raising — the schema
# (qentor.api.schemas.TutorRequest) is what rejects an unsupported code
# outright, this is just a defensive default for direct callers of this module.
_LANGUAGE_NAMES = {"en": "English", "hi": "Hindi", "kn": "Kannada"}
_DEFAULT_LANGUAGE = "en"

_SYSTEM_PROMPT_TEMPLATE = (
    "You are a quantum computing tutor. You are given a numbered fact sheet "
    "built from a real, already-executed quantum circuit. You must never "
    "invent a probability, amplitude, count or pass/fail verdict yourself — "
    "every number in your answer must already appear in one of the facts. "
    "Cite every fact you rely on by its id. Write the \"answer\" value in "
    "{language_name}; fact ids, numbers and bitstrings must stay exactly as "
    "given, in Latin digits, never translated or reformatted. Reply with "
    'JSON only, no prose outside the JSON: {{"answer": "...", '
    '"cited_fact_ids": ["F1", ...]}}.'
)


# Appended only when the request carries lesson context. It adds a second,
# separate source (course material) and restates the trust rule for it: the
# lesson may be used to explain, never to produce a quantum result.
_LESSON_PROMPT_ADDENDUM = (
    " You may also be given LESSON CONTEXT facts (ids starting with L) taken "
    "from the course material. Use them to explain the concept, cite them by "
    "id, and stay within them; they are not measurement results. Quantum "
    "numbers, probabilities, amplitudes, counts and verdicts may come ONLY "
    "from the QUANTUM RESULT FACTS (ids starting with F). Never calculate or "
    "estimate a new circuit result yourself. If no QUANTUM RESULT FACTS are "
    "given, there is no result: do not state any measurement outcome, "
    "probability or amplitude. If the facts do not contain enough "
    "information, say so instead of guessing. Keep circuit gate names, ids, "
    "bitstrings, backend names and hashes exactly as given."
)


def _system_prompt(language: str, *, with_lesson_context: bool = False) -> str:
    language_name = _LANGUAGE_NAMES.get(language, _LANGUAGE_NAMES[_DEFAULT_LANGUAGE])
    prompt = _SYSTEM_PROMPT_TEMPLATE.format(language_name=language_name)
    return prompt + _LESSON_PROMPT_ADDENDUM if with_lesson_context else prompt


def _user_message(
    question: str,
    facts: list[TutorFact],
    language: str,
    lesson_facts: list[TutorFact] | None,
) -> str:
    fact_lines = "\n".join(f"{f.id}: {f.description}" for f in facts)
    if not lesson_facts:
        # The original, lesson-free shape — unchanged.
        return f"Facts:\n{fact_lines or '(no facts)'}\n\nQuestion: {question}"

    language_name = _LANGUAGE_NAMES.get(language, _LANGUAGE_NAMES[_DEFAULT_LANGUAGE])
    lesson_lines = "\n".join(f"{f.id}: {f.description}" for f in lesson_facts)
    no_result = "(none — no executed result is attached to this question)"
    return (
        f"LESSON CONTEXT:\n{lesson_lines}\n\n"
        f"QUANTUM RESULT FACTS:\n{fact_lines or no_result}\n\n"
        f"USER QUESTION: {question}\n\n"
        f"LANGUAGE: {language_name}"
    )


class LLMDraft:
    """Raw output from an LLM adapter, not yet validated or trusted."""

    def __init__(self, *, answer: str, cited_fact_ids: list[str]) -> None:
        self.answer = answer
        self.cited_fact_ids = cited_fact_ids


class LLMUnavailable(Exception):
    """The provider could not be reached, timed out, or returned garbage."""


class LLMAdapter(Protocol):
    name: str

    def generate(
        self,
        question: str,
        facts: list[TutorFact],
        language: str = "en",
        lesson_facts: list[TutorFact] | None = None,
    ) -> LLMDraft:
        """Raise ``LLMUnavailable`` on any failure — never return a guessed draft.

        ``facts`` are quantum-result facts (``F#``); ``lesson_facts`` are
        course-material facts (``L#``) and are only ever passed when the
        request carried lesson context."""
        ...


class AnthropicAdapter:
    """Calls the Anthropic Messages API.

    Uses the standard library's ``urllib`` rather than a new pip dependency —
    this backend has no HTTP client dependency today (see
    backend/requirements.txt) and one outbound POST call doesn't need one.
    """

    name = "anthropic"

    def __init__(self, api_key: str, model: str = DEFAULT_MODEL) -> None:
        self._api_key = api_key
        self._model = model

    def generate(
        self,
        question: str,
        facts: list[TutorFact],
        language: str = "en",
        lesson_facts: list[TutorFact] | None = None,
    ) -> LLMDraft:
        body = json.dumps(
            {
                "model": self._model,
                "max_tokens": 512,
                "system": _system_prompt(language, with_lesson_context=bool(lesson_facts)),
                "messages": [
                    {"role": "user", "content": _user_message(question, facts, language, lesson_facts)}
                ],
            }
        ).encode("utf-8")

        request = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-api-key": self._api_key,
                "anthropic-version": "2023-06-01",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read())
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise LLMUnavailable(f"anthropic request failed: {exc}") from exc

        try:
            text = payload["content"][0]["text"]
            parsed = json.loads(text)
            return LLMDraft(
                answer=parsed["answer"],
                cited_fact_ids=list(parsed.get("cited_fact_ids", [])),
            )
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise LLMUnavailable(f"anthropic response was not the expected shape: {exc}") from exc
