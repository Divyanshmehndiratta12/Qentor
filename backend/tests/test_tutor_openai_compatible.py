"""OpenAI-compatible tutor adapter: request shape, parsing, failure -> LLMUnavailable, and config selection."""

import io
import json
import os
import unittest
from unittest import mock

from qentor.tutor import config
from qentor.tutor.llm import LLMUnavailable, OpenAICompatibleAdapter


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _reply(content: str) -> _Resp:
    return _Resp(json.dumps({"choices": [{"message": {"content": content}}]}).encode())


class OpenAICompatibleAdapterTest(unittest.TestCase):
    def test_request_and_parse(self):
        seen = {}

        def fake(req, timeout):
            seen["url"], seen["auth"], seen["body"] = req.full_url, req.get_header("Authorization"), json.loads(req.data)
            return _reply('{"answer": "Uses F1.", "cited_fact_ids": ["F1"]}')

        a = OpenAICompatibleAdapter(api_key="k", model="m", base_url="https://example.test/v1/")
        with mock.patch("urllib.request.urlopen", fake):
            d = a.generate("why?", [])
        self.assertEqual(seen["url"], "https://example.test/v1/chat/completions")
        self.assertEqual(seen["auth"], "Bearer k")
        self.assertEqual(seen["body"]["model"], "m")
        self.assertEqual(seen["body"]["messages"][0]["role"], "system")
        self.assertEqual((d.answer, d.cited_fact_ids), ("Uses F1.", ["F1"]))

    def test_fenced_json_is_accepted(self):
        a = OpenAICompatibleAdapter(api_key="k", model="m")
        with mock.patch("urllib.request.urlopen", lambda r, timeout: _reply('```json\n{"answer": "ok"}\n```')):
            self.assertEqual(a.generate("q", []).answer, "ok")

    def test_bad_reply_and_network_errors_raise_unavailable(self):
        a = OpenAICompatibleAdapter(api_key="k", model="m")
        with mock.patch("urllib.request.urlopen", lambda r, timeout: _reply("not json")):
            with self.assertRaises(LLMUnavailable):
                a.generate("q", [])
        with mock.patch("urllib.request.urlopen", side_effect=OSError("down")):
            with self.assertRaises(LLMUnavailable):
                a.generate_debug([], None)

    def test_config_selects_adapter_and_requires_model(self):
        env = {"QENTOR_TUTOR_LLM_ENABLED": "true", "QENTOR_TUTOR_LLM_API_KEY": "k",
               "QENTOR_TUTOR_LLM_PROVIDER": "openai-compatible"}
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("QENTOR_TUTOR_LLM_MODEL", None)
            self.assertIsNone(config.build_default_llm_adapter())
            os.environ["QENTOR_TUTOR_LLM_MODEL"] = "some-model"
            adapter = config.build_default_llm_adapter()
            self.assertIsInstance(adapter, OpenAICompatibleAdapter)
            self.assertEqual(adapter.model_name, "some-model")


if __name__ == "__main__":
    unittest.main()
