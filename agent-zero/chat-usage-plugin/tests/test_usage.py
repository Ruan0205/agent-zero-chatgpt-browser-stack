from pathlib import Path
from datetime import datetime
import sys
import tempfile
import types
import unittest
import json

sys.modules["helpers"] = types.ModuleType("helpers")
sys.modules["helpers.tokens"] = types.ModuleType("helpers.tokens")
sys.modules["helpers.tokens"].approximate_prompt_tokens = lambda text: len(text) // 4
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from usage import accumulate, model_bucket, record, usage_delta
from totals import aggregate_usage, current_usage


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
        self.assertEqual(first.output["chat_token_usage"]["by_model"]["other"]["total"], 30)

    def test_model_buckets_and_legacy_unknown(self):
        self.assertEqual(model_bucket("other/kimi-k3"), "kimi")
        self.assertEqual(model_bucket("openai/chatgpt-browser"), "browser")
        result = aggregate_usage({
            "old": {"input": 100, "output": 20, "calls": 2},
            "new": {"input": 50, "output": 10, "calls": 1,
                    "by_model": {"kimi": {"input": 50, "output": 10, "calls": 1}}},
        })
        self.assertEqual(result["buckets"]["all"]["total"], 180)
        self.assertEqual(result["buckets"]["kimi"]["total"], 60)
        self.assertEqual(result["buckets"]["unattributed"]["total"], 120)

    def test_saved_usage_and_live_context_override_same_chat(self):
        with tempfile.TemporaryDirectory() as folder:
            chat_file = Path(folder) / "chat-1" / "chat.json"
            chat_file.parent.mkdir()
            chat_file.write_text(json.dumps({"id": "chat-1", "output_data": {
                "chat_token_usage": {"input": 10, "output": 2,
                                     "by_model": {"kimi": {"input": 10, "output": 2}}}
            }}), encoding="utf-8")

            class LiveContext:
                id = "chat-1"

                def get_output_data(self, key):
                    return {"input": 20, "output": 4,
                            "by_model": {"kimi": {"input": 20, "output": 4}}}

            result = current_usage(Path(folder), [LiveContext()])
            self.assertEqual(result["chats_counted"], 1)
            self.assertEqual(result["buckets"]["kimi"]["total"], 24)
            self.assertEqual(result["buckets"]["all"]["total"], 24)

    def test_monthly_rollover_preserves_lifetime_and_resets_first_day(self):
        class Context:
            def __init__(self):
                self.output = {}

            def get_output_data(self, key):
                return self.output.get(key)

            def set_output_data(self, key, value):
                self.output[key] = value

        context = Context()
        result = types.SimpleNamespace(usage={"prompt_tokens": 10, "completion_tokens": 2})
        record(context, result, [], "kimi-k3", now=datetime(2026, 9, 30, 23, 59))
        record(context, result, [], "kimi-k3", now=datetime(2026, 10, 1, 0, 1))
        usage = context.output["chat_token_usage"]
        self.assertEqual(usage["total"], 24)
        self.assertEqual(usage["by_month"]["2026-09"]["total"], 12)
        self.assertEqual(usage["by_month"]["2026-10"]["total"], 12)

    def test_last_call_speed_uses_output_tokens_and_elapsed_call_time(self):
        class Context:
            def __init__(self):
                self.output = {}

            def get_output_data(self, key):
                return self.output.get(key)

            def set_output_data(self, key, value):
                self.output[key] = value

        context = Context()
        result = types.SimpleNamespace(usage={"prompt_tokens": 100, "completion_tokens": 40})
        record(context, result, [], "kimi-k3", elapsed_seconds=2.0)
        last = context.output["chat_token_usage"]["last_call"]
        self.assertEqual(last["output_tokens"], 40)
        self.assertEqual(last["tokens_per_second"], 20.0)
        self.assertFalse(last["estimated"])
        record(context, result, [], "openai/chatgpt-browser", elapsed_seconds=4.0)
        last = context.output["chat_token_usage"]["last_call"]
        self.assertEqual(last["tokens_per_second"], 10.0)
        self.assertTrue(last["estimated"])

    def test_legacy_browser_backfill_only_in_creation_month(self):
        record = {"usage": {"input": 100, "output": 20,
                            "by_model": {"browser": {"input": 10, "output": 2}}},
                  "created_at": "2026-09-25T12:00:00-03:00",
                  "model_hint": "browser"}
        september = aggregate_usage({"browser-chat": record}, month="2026-09")
        october = aggregate_usage({"browser-chat": record}, month="2026-10")
        self.assertEqual(september["monthly_buckets"]["browser"]["total"], 120)
        self.assertEqual(september["buckets"]["browser"]["total"], 120)
        self.assertEqual(september["inferred_legacy_tokens"], 108)
        self.assertEqual(october["monthly_buckets"]["all"]["total"], 0)
        self.assertEqual(october["buckets"]["all"]["total"], 120)

    def test_monthly_entries_do_not_double_count_legacy(self):
        record = {"usage": {"input": 130, "output": 5,
                            "by_model": {"browser": {"input": 30, "output": 5}},
                            "by_month": {"2026-10": {"input": 30, "output": 5,
                                                      "by_model": {"browser": {"input": 30, "output": 5}}}}},
                  "created_at": "2026-09-25T12:00:00-03:00", "model_hint": "browser"}
        september = aggregate_usage({"chat": record}, month="2026-09")
        october = aggregate_usage({"chat": record}, month="2026-10")
        self.assertEqual(september["monthly_buckets"]["all"]["total"], 100)
        self.assertEqual(october["monthly_buckets"]["all"]["total"], 35)
        self.assertEqual(october["buckets"]["browser"]["total"], 135)


if __name__ == "__main__":
    unittest.main()
