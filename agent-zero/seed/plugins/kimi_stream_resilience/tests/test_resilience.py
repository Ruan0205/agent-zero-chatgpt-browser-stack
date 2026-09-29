import asyncio
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resilience import DSML_CORRECTION, KimiRetryModel, KimiRetriesExhausted, has_answer, is_kimi, is_retryable, is_rate_limit


class KimiResilienceTests(unittest.TestCase):
    def test_only_kimi_is_wrapped(self):
        self.assertTrue(is_kimi(types.SimpleNamespace(model_name="other/kimi-k3")))
        self.assertFalse(is_kimi(types.SimpleNamespace(model_name="other/chatgpt-browser")))

    def test_retryable_vs_permanent(self):
        self.assertTrue(is_retryable(RuntimeError("模型服务返回了无法解析或不完整的响应")))
        self.assertFalse(is_retryable(RuntimeError("invalid api key")))
        self.assertTrue(is_retryable(type("RateLimitError", (Exception,), {})()))
        self.assertTrue(is_rate_limit(type("RateLimitError", (Exception,), {})()))

    def test_atomic_retry_then_success(self):
        class Model:
            model_name = "other/kimi-k3"
            calls = 0

            async def unified_turn(self, **kwargs):
                self.calls += 1
                assert kwargs["response_callback"] is None
                assert kwargs["reasoning_callback"] is None
                assert kwargs["a0_retry_attempts"] == 0
                if self.calls < 3:
                    raise RuntimeError("incomplete response")
                return types.SimpleNamespace(response="done", reasoning="", function_calls=[])

        waits = []

        async def no_wait(seconds):
            waits.append(seconds)

        model = Model()
        result = asyncio.run(KimiRetryModel(model, sleep=no_wait).unified_turn())
        self.assertEqual(result.response, "done")
        self.assertEqual(model.calls, 3)
        self.assertEqual(waits, [3, 8])

    def test_empty_response_retried_but_invalid_key_not_retried(self):
        class Model:
            calls = 0

            async def unified_turn(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    return types.SimpleNamespace(response="", reasoning="", function_calls=[])
                return types.SimpleNamespace(response="ok", reasoning="", function_calls=[])

        async def no_wait(_):
            return None

        model = Model()
        self.assertEqual(asyncio.run(KimiRetryModel(model, sleep=no_wait).unified_turn()).response, "ok")
        self.assertEqual(model.calls, 2)
        self.assertFalse(has_answer(types.SimpleNamespace(response="", reasoning="", function_calls=[])))

    def test_rate_limit_waits_at_least_thirty_seconds(self):
        class Model:
            calls = 0

            async def unified_turn(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    raise type("RateLimitError", (Exception,), {})()
                return types.SimpleNamespace(response="ok")

        waits = []

        async def no_wait(seconds):
            waits.append(seconds)

        asyncio.run(KimiRetryModel(Model(), sleep=no_wait).unified_turn())
        self.assertEqual(waits, [30])

    def test_reasoning_only_is_not_a_finished_answer(self):
        self.assertFalse(has_answer(types.SimpleNamespace(response='',reasoning='still reasoning',function_calls=[])))
        self.assertTrue(has_answer(types.SimpleNamespace(response='',reasoning='thoughts',function_calls=[{'name':'response'}])))

    def test_reasoning_only_retried_inside_same_turn(self):
        class Model:
            calls=0
            async def unified_turn(self, **kwargs):
                self.calls+=1
                return types.SimpleNamespace(response='' if self.calls==1 else 'done',reasoning='thoughts',function_calls=[])
        async def no_wait(_): pass
        model=Model()
        result=asyncio.run(KimiRetryModel(model,sleep=no_wait).unified_turn())
        self.assertEqual(result.response,'done')
        self.assertEqual(model.calls,2)

    def test_exhaustion_stops_after_four_llm_calls(self):
        class Model:
            calls = 0

            async def unified_turn(self, **kwargs):
                self.calls += 1
                raise RuntimeError("incomplete response")

        async def no_wait(_):
            return None

        model = Model()
        with self.assertRaises(KimiRetriesExhausted):
            asyncio.run(KimiRetryModel(model, sleep=no_wait).unified_turn())
        self.assertEqual(model.calls, 4)

    def test_invalid_dsml_retry_gets_ephemeral_format_feedback(self):
        class Model:
            def __init__(self):
                self.requests = []

            async def unified_turn(self, **kwargs):
                self.requests.append(kwargs)
                if len(self.requests) == 1:
                    return types.SimpleNamespace(
                        response='<｜｜DSML｜｜ calls><bad></｜｜DSML｜｜ calls>',
                        capability={}, function_calls=[],
                    )
                return types.SimpleNamespace(response='ok', capability={}, function_calls=[])

        async def no_wait(_): pass
        model = Model()
        history = ['original history']
        result = asyncio.run(KimiRetryModel(model, sleep=no_wait).unified_turn(
            messages=history, user_message='original user request',
        ))
        self.assertEqual(result.response, 'ok')
        self.assertEqual(history, ['original history'])
        self.assertEqual(len(model.requests), 2)
        self.assertEqual(model.requests[0]['user_message'], 'original user request')
        self.assertEqual(model.requests[1]['user_message'], 'original user request\n\n' + DSML_CORRECTION)
        self.assertIsNot(model.requests[1]['messages'], history)

    def test_network_retry_does_not_add_dsml_feedback(self):
        class Model:
            def __init__(self): self.requests = []
            async def unified_turn(self, **kwargs):
                self.requests.append(kwargs)
                if len(self.requests) == 1:
                    raise RuntimeError('connection reset')
                return types.SimpleNamespace(response='ok', capability={}, function_calls=[])
        async def no_wait(_): pass
        model = Model()
        asyncio.run(KimiRetryModel(model, sleep=no_wait).unified_turn(messages=[]))
        self.assertNotIn('user_message', model.requests[1])

    def test_provider_invalid_dsml_error_gets_same_feedback(self):
        class InvalidDSML(Exception): pass
        class Model:
            def __init__(self): self.requests = []
            async def unified_turn(self, **kwargs):
                self.requests.append(kwargs)
                if len(self.requests) == 1: raise InvalidDSML('provider rejected call')
                return types.SimpleNamespace(response='ok', capability={}, function_calls=[])
        async def no_wait(_): pass
        model = Model()
        asyncio.run(KimiRetryModel(model, sleep=no_wait).unified_turn(messages=[]))
        self.assertEqual(model.requests[1]['user_message'], DSML_CORRECTION)


if __name__ == "__main__":
    unittest.main()
