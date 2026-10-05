"""Empty cited fact ids from a model are ignored; an id that is not in the fact sheet is still rejected by the guard."""

from __future__ import annotations

import io
import json
import unittest
from unittest import mock

from qentor.tutor.answer import answer_question_with_llm
from qentor.tutor.facts import build_fact_sheet
from qentor.tutor.guard import GuardRejection, validate_llm_draft
from qentor.tutor.llm import AnthropicAdapter, LLMDraft, LLMUnavailable, OpenAICompatibleAdapter, normalise_cited_fact_ids
from tests.test_tutor_llm import BELL, _record


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _openai_reply(parsed: dict) -> _Resp:
    return _Resp(json.dumps({"choices": [{"message": {"content": json.dumps(parsed)}}]}).encode())


def _anthropic_reply(parsed: dict) -> _Resp:
    return _Resp(json.dumps({"content": [{"type": "text", "text": json.dumps(parsed)}]}).encode())


class NormaliseTest(unittest.TestCase):
    def test_the_reported_cases(self) -> None:
        self.assertEqual(normalise_cited_fact_ids([""]), [])
        self.assertEqual(normalise_cited_fact_ids(["F1", " ", "F1"]), ["F1"])

    def test_strips_whitespace_drops_empties_and_keeps_first_seen_order(self) -> None:
        self.assertEqual(normalise_cited_fact_ids([" F2 ", "", "F1", "\n", "F2", "F3"]), ["F2", "F1", "F3"])

    def test_only_string_items_are_kept(self) -> None:
        self.assertEqual(normalise_cited_fact_ids([1, None, "F1", ["F2"], {"id": "F3"}, 2.5, True]), ["F1"])

    def test_an_empty_list_stays_empty(self) -> None:
        self.assertEqual(normalise_cited_fact_ids([]), [])

    def test_a_value_that_is_not_a_list_is_malformed(self) -> None:
        for bad in (None, "F1", {"F1": 1}, 3, ("F1",)):
            with self.subTest(bad=bad):
                with self.assertRaises(TypeError):
                    normalise_cited_fact_ids(bad)


class AdaptersUseTheNormaliserTest(unittest.TestCase):
    """Each adapter, for each draft type, cleans the ids it parses (and still fails closed on a malformed value)."""

    ADAPTERS = {
        "openai-compatible": (lambda: OpenAICompatibleAdapter(api_key="k", model="m"), _openai_reply),
        "anthropic": (lambda: AnthropicAdapter(api_key="k", model="m"), _anthropic_reply),
    }

    def _drafts(self, make, reply, cited):
        adapter = make()
        answer = {"answer": "This is a Bell circuit.", "cited_fact_ids": cited}
        debug = {"observed": "o", "mismatch": "m", "next_experiment": "n", "cited_fact_ids": cited}
        with mock.patch("urllib.request.urlopen", lambda r, timeout: reply(answer)):
            first = adapter.generate("q", [])
        with mock.patch("urllib.request.urlopen", lambda r, timeout: reply(debug)):
            second = adapter.generate_debug([], None)
        return first, second

    def test_an_empty_string_citation_becomes_no_citation(self) -> None:
        for name, (make, reply) in self.ADAPTERS.items():
            with self.subTest(adapter=name):
                for draft in self._drafts(make, reply, [""]):
                    self.assertEqual(draft.cited_fact_ids, [])

    def test_padding_and_duplicates_are_removed(self) -> None:
        for name, (make, reply) in self.ADAPTERS.items():
            with self.subTest(adapter=name):
                for draft in self._drafts(make, reply, ["F1", " ", "F1"]):
                    self.assertEqual(draft.cited_fact_ids, ["F1"])

    def test_a_missing_key_is_still_no_citation(self) -> None:
        for name, (make, reply) in self.ADAPTERS.items():
            with self.subTest(adapter=name):
                adapter = make()
                with mock.patch("urllib.request.urlopen", lambda r, timeout: reply({"answer": "This is a Bell circuit."})):
                    self.assertEqual(adapter.generate("q", []).cited_fact_ids, [])

    def test_a_citation_that_is_not_a_list_is_unavailable_not_silently_empty(self) -> None:
        for name, (make, reply) in self.ADAPTERS.items():
            for bad in ("F1", None, {"F1": 1}):
                with self.subTest(adapter=name, bad=bad):
                    adapter = make()
                    with mock.patch("urllib.request.urlopen", lambda r, timeout, b=bad: reply({"answer": "x", "cited_fact_ids": b})):
                        with self.assertRaises(LLMUnavailable):
                            adapter.generate("q", [])


class GuardIsUnchangedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.record = _record({"execution_id": "aer-local-fake", "probabilities": {"00": 0.5, "11": 0.5}, "counts": {"00": 500, "11": 500}})
        self.facts = build_fact_sheet(BELL, self.record)
        self.circuit_fact = next(f for f in self.facts if f.kind == "circuit_summary")

    def test_a_nonexistent_id_is_still_rejected_by_the_guard(self) -> None:
        with self.assertRaises(GuardRejection) as raised:
            validate_llm_draft(LLMDraft(answer=f"This is a Bell circuit ({self.circuit_fact.id}).", cited_fact_ids=["F99"]), self.facts)
        self.assertIn("F99", str(raised.exception))

    def test_an_empty_string_id_that_reaches_the_guard_is_still_rejected(self) -> None:
        # The guard itself was not loosened: only the adapters clean the ids before building a draft.
        with self.assertRaises(GuardRejection):
            validate_llm_draft(LLMDraft(answer=f"This is a Bell circuit ({self.circuit_fact.id}).", cited_fact_ids=[""]), self.facts)

    def test_a_good_draft_with_a_padded_citation_list_is_now_used(self) -> None:
        adapter = OpenAICompatibleAdapter(api_key="k", model="m")
        reply = {"answer": f"This is a Bell circuit ({self.circuit_fact.id}).", "cited_fact_ids": [""]}
        with mock.patch("urllib.request.urlopen", lambda r, timeout: _openai_reply(reply)):
            answer, used_fallback = answer_question_with_llm("What does this circuit do?", self.facts, self.record, adapter)
        self.assertFalse(used_fallback)
        self.assertEqual(answer, f"This is a Bell circuit ({self.circuit_fact.id}).")

    def test_a_real_citation_next_to_an_unknown_one_is_still_a_fallback(self) -> None:
        adapter = OpenAICompatibleAdapter(api_key="k", model="m")
        reply = {"answer": f"This is a Bell circuit ({self.circuit_fact.id}).", "cited_fact_ids": ["", self.circuit_fact.id, "F99"]}
        with mock.patch("urllib.request.urlopen", lambda r, timeout: _openai_reply(reply)):
            with self.assertLogs("qentor.tutor", "WARNING") as logs:
                _, used_fallback = answer_question_with_llm("What does this circuit do?", self.facts, self.record, adapter)
        self.assertTrue(used_fallback)
        self.assertIn("F99", logs.output[0])

    def test_a_claim_the_facts_do_not_support_is_still_rejected_with_clean_ids(self) -> None:
        adapter = OpenAICompatibleAdapter(api_key="k", model="m")
        reply = {"answer": "The result was 73% on outcome 01.", "cited_fact_ids": [self.circuit_fact.id, ""]}
        with mock.patch("urllib.request.urlopen", lambda r, timeout: _openai_reply(reply)):
            with self.assertLogs("qentor.tutor", "WARNING"):
                _, used_fallback = answer_question_with_llm("What was the result?", self.facts, self.record, adapter)
        self.assertTrue(used_fallback)


if __name__ == "__main__":
    unittest.main()
