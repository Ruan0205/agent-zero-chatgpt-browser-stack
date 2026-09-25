from pathlib import Path
import sys
import types
import unittest

sys.modules["helpers"] = types.ModuleType("helpers")
sys.modules["helpers.tokens"] = types.ModuleType("helpers.tokens")
sys.modules["helpers.tokens"].approximate_prompt_tokens = lambda text: len(text) // 4
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from usage import accumulate, record, usage_delta


class UsageTests(unittest.TestCase):
    def test_reported_usage(self):
        result = types.SimpleNamespace(usage={"prompt_tokens": 100, "completion_tokens": 25})
        self.assertEqual(usage_delta(result, [], "qwen"), {"input": 100, "output": 25, "estimated": False})

    def test_browser_usage_is_estimated(self):
        result = types.SimpleNamespace(usage={"prompt_tokens": 100, "completion_tokens": 25})
        self.assertTrue(usage_delta(result, [], "chatgpt-browser")["estimated"])

    def test_fallback_and_accumulation(self):
        result = types.SimpleNamespace(usage={}, reasoning="", response="answer")
        delta = usage_delta(result, [{"content": "hello world"}], "qwen")
        self.assertTrue(delta["estimated"])
        total = accumulate({"input": 5, "output": 3, "calls": 1}, delta)
        self.assertEqual(total["total"], total["input"] + total["output"])
        self.assertEqual(total["calls"], 2)

    def test_record_is_chat_scoped(self):
        class Context:
            def __init__(self):
                self.output = {}

            def get_output_data(self, key):
                return self.output.get(key)

            def set_output_data(self, key, value):
                self.output[key] = value

        first, second = Context(), Context()
        result = types.SimpleNamespace(usage={"prompt_tokens": 10, "completion_tokens": 5})
        record(first, result, [], "qwen")
        record(first, result, [], "qwen")
        record(second, result, [], "qwen")
        self.assertEqual(first.output["chat_token_usage"]["total"], 30)
        self.assertEqual(second.output["chat_token_usage"]["total"], 15)


if __name__ == "__main__":
    unittest.main()
