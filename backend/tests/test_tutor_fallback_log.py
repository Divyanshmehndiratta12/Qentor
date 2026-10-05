"""The tutor logs why a model draft was not used, and never logs the API key, the question or the prompt."""

from __future__ import annotations

import ast
import io
import json
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from qentor.tutor.answer import answer_question_with_llm
from qentor.tutor.fallback_log import MAX_DETAIL_CHARS, log_llm_fallback, one_line
from qentor.tutor.guard import GuardRejection
from qentor.tutor.llm import LLMDraft, LLMUnavailable, OpenAICompatibleAdapter
from qentor.tutor.facts import build_fact_sheet
from tests.test_tutor_llm import BELL, FakeLLMAdapter, _record

QENTOR = Path(__file__).resolve().parents[1] / "qentor"
# Every module that catches an unusable model draft.
HANDLER_MODULES = ["tutor/answer.py", "tutor/reasoning_facts.py", "tutor/comparison.py", "tutor/debugger.py", "api/app.py"]
FALLBACK_EXCEPTIONS = {"LLMUnavailable", "GuardRejection", "DebugGuardRejection"}


def _names(node: ast.expr | None) -> set[str]:
    if node is None:
        return set()
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


class EveryFallbackHandlerLogsTest(unittest.TestCase):
    def test_no_except_clause_for_an_unusable_draft_is_silent(self) -> None:
        checked = 0
        for relative in HANDLER_MODULES:
            tree = ast.parse((QENTOR / relative).read_text(encoding="utf-8"))
            for handler in (n for n in ast.walk(tree) if isinstance(n, ast.ExceptHandler)):
                if not (_names(handler.type) & FALLBACK_EXCEPTIONS):
                    continue
                checked += 1
                calls = {c.func.id for c in ast.walk(ast.Module(body=handler.body, type_ignores=[])) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)}
                self.assertIn("log_llm_fallback", calls, f"{relative}:{handler.lineno} falls back without logging why")
                self.assertIsNotNone(handler.name, f"{relative}:{handler.lineno} does not bind the exception it logs")
        self.assertGreaterEqual(checked, 7)  # three in answer.py, reasoning, comparison, debugger, and the generate-circuit endpoint


class LogHelperTest(unittest.TestCase):
    def test_one_line_collapses_whitespace_and_caps_length(self) -> None:
        text = one_line("first\nsecond\t third " + "x" * 1000)
        self.assertNotIn("\n", text)
        self.assertTrue(text.startswith("first second third x"))
        self.assertLessEqual(len(text), MAX_DETAIL_CHARS + 3)
        self.assertTrue(text.endswith("..."))

    def test_the_warning_names_the_place_the_exception_type_and_message(self) -> None:
        with self.assertLogs("qentor.tutor", "WARNING") as logs:
            log_llm_fallback("somewhere", LLMUnavailable("openai-compatible request failed: HTTP Error 429: Too Many Requests"))
        self.assertEqual(len(logs.output), 1)
        self.assertEqual(len(logs.records[0].getMessage().splitlines()), 1)
        message = logs.records[0].getMessage()
        for part in ("somewhere", "LLMUnavailable", "HTTP Error 429", "deterministic template"):
            self.assertIn(part, message)


class AnswerFallbackLoggingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.record = _record({"execution_id": "aer-local-fake", "probabilities": {"00": 0.5, "11": 0.5}, "counts": {"00": 500, "11": 500}})
        self.facts = build_fact_sheet(BELL, self.record)

    def test_an_unavailable_model_is_logged_and_the_template_answers(self) -> None:
        fake = FakeLLMAdapter(raises=LLMUnavailable("openai-compatible request failed: timed out"))
        with self.assertLogs("qentor.tutor", "WARNING") as logs:
            answer, used_fallback = answer_question_with_llm("What was the result?", self.facts, self.record, fake)
        self.assertTrue(used_fallback)
        self.assertTrue(answer)
        self.assertEqual(len(logs.records), 1)
        self.assertIn("LLMUnavailable", logs.output[0])
        self.assertIn("timed out", logs.output[0])
        self.assertIn("answer_question_with_llm", logs.output[0])

    def test_a_rejected_draft_is_logged_with_the_guards_reason(self) -> None:
        fake = FakeLLMAdapter(draft=LLMDraft(answer="Trust me (F999).", cited_fact_ids=["F999"]))
        with self.assertLogs("qentor.tutor", "WARNING") as logs:
            _, used_fallback = answer_question_with_llm("What was the result?", self.facts, self.record, fake)
        self.assertTrue(used_fallback)
        self.assertIn("GuardRejection", logs.output[0])
        self.assertIn("F999", logs.output[0])

    def test_a_used_draft_and_a_missing_model_log_nothing(self) -> None:
        circuit_fact = next(f for f in self.facts if f.kind == "circuit_summary")
        good = FakeLLMAdapter(draft=LLMDraft(answer=f"A Bell circuit ({circuit_fact.id}).", cited_fact_ids=[circuit_fact.id]))
        with self.assertNoLogs("qentor.tutor", "WARNING"):
            answer_question_with_llm("What does this circuit do?", self.facts, self.record, good)
            answer_question_with_llm("What was the result?", self.facts, self.record, None)

    def test_a_failing_real_adapter_never_puts_the_key_or_the_question_in_the_log(self) -> None:
        adapter = OpenAICompatibleAdapter(api_key="SECRET-KEY-123", model="m", base_url="https://example.test/v1")
        question = "UNIQUE-QUESTION-TEXT about the result"
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("connection refused")):
            with self.assertLogs("qentor.tutor", "WARNING") as logs:
                _, used_fallback = answer_question_with_llm(question, self.facts, self.record, adapter)
        self.assertTrue(used_fallback)
        everything = "\n".join(logs.output)
        self.assertIn("connection refused", everything)
        self.assertNotIn("SECRET-KEY-123", everything)
        self.assertNotIn("UNIQUE-QUESTION-TEXT", everything)
        self.assertNotIn("Bearer", everything)


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _reply(content) -> _Resp:
    return _Resp(json.dumps({"choices": [{"message": {"content": content}}]}).encode())


class ReplyLoggingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.adapter = OpenAICompatibleAdapter(api_key="SECRET-KEY-123", model="m")

    def test_an_unparseable_reply_logs_its_first_300_characters_and_no_more(self) -> None:
        reply = "I am not JSON. " + "a" * 285 + "TAIL-BEYOND-300 " + "z" * 200
        with mock.patch("urllib.request.urlopen", lambda r, timeout: _reply(reply)):
            with self.assertLogs("qentor.tutor", "WARNING") as logs:
                with self.assertRaises(LLMUnavailable):
                    self.adapter.generate("a question", [])
        message = logs.records[0].getMessage()
        self.assertEqual(len(message.splitlines()), 1)
        self.assertIn("I am not JSON.", message)
        self.assertIn(repr(reply[:300]), message)
        self.assertNotIn("TAIL-BEYOND-300", message)
        self.assertNotIn("SECRET-KEY-123", message)
        self.assertNotIn("a question", message)

    def test_a_fenced_reply_that_is_still_not_json_is_logged_too(self) -> None:
        with mock.patch("urllib.request.urlopen", lambda r, timeout: _reply("```json\n{broken\n```")):
            with self.assertLogs("qentor.tutor", "WARNING") as logs:
                with self.assertRaises(LLMUnavailable):
                    self.adapter.generate_circuit("make a bell pair", [])
        self.assertIn("{broken", logs.output[0])

    def test_a_valid_reply_logs_nothing(self) -> None:
        with mock.patch("urllib.request.urlopen", lambda r, timeout: _reply('{"answer": "ok", "cited_fact_ids": []}')):
            with self.assertNoLogs("qentor.tutor", "WARNING"):
                self.assertEqual(self.adapter.generate("q", []).answer, "ok")

    def test_a_reply_with_no_text_content_is_unavailable_not_a_crash(self) -> None:
        for content in (None, 7, ["x"]):
            with self.subTest(content=content):
                with mock.patch("urllib.request.urlopen", lambda r, timeout, c=content: _reply(c)):
                    with self.assertRaises(LLMUnavailable):
                        self.adapter.generate("q", [])


if __name__ == "__main__":
    unittest.main()
