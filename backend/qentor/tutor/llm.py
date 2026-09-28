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

_SYSTEM_PROMPT = (
    "You are a quantum computing tutor. You are given a numbered fact sheet "
    "built from a real, already-executed quantum circuit. You must never "
    "invent a probability, amplitude, count or pass/fail verdict yourself — "
    "every number in your answer must already appear in one of the facts. "
    "Cite every fact you rely on by its id. Reply with JSON only, no prose "
    'outside the JSON: {"answer": "...", "cited_fact_ids": ["F1", ...]}.'
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

    def generate(self, question: str, facts: list[TutorFact]) -> LLMDraft:
        """Raise ``LLMUnavailable`` on any failure — never return a guessed draft."""
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

    def generate(self, question: str, facts: list[TutorFact]) -> LLMDraft:
        fact_lines = "\n".join(f"{f.id}: {f.description}" for f in facts) or "(no facts)"
        body = json.dumps(
            {
                "model": self._model,
                "max_tokens": 512,
                "system": _SYSTEM_PROMPT,
                "messages": [
                    {"role": "user", "content": f"Facts:\n{fact_lines}\n\nQuestion: {question}"}
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
