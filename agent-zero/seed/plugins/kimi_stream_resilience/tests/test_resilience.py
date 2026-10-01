import asyncio
from pathlib import Path
import sys
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from resilience import DSML_CORRECTION, EMPTY_RESPONSE_CORRECTION, MALFORMED_RESPONSE_CORRECTION, NATIVE_RESPONSE_CORRECTION, EmptyModelResponse, MalformedModelResponse, KimiRetryModel, KimiRetriesExhausted, has_answer, is_kimi, is_retryable, is_rate_limit, is_thoughts_only_response


class KimiResilienceTests(unittest.TestCase):
    def test_native_missing_required_argument_retries_before_dispatch(self):
        class Model:
            kwargs = {"tools": [{"type": "function", "function": {"name": "response", "parameters": {"required": ["text"]}}}], "tool_choice": "required"}
            def __init__(self): self.calls = 0
            async def unified_turn(self, **kwargs):
                self.calls += 1
                args = {} if self.calls == 1 else {"text": "olá"}
                return types.SimpleNamespace(response="", capability={}, output_items=[],
                    function_calls=[types.SimpleNamespace(name="response", arguments=args)])
        async def no_wait(_): pass
        async def native_turn(model, request): return await model.unified_turn(**request)
        model = Model()
        result = asyncio.run(KimiRetryModel(model, sleep=no_wait, native_turn=native_turn).unified_turn(messages=[]))
        self.assertEqual(model.calls, 2)
        self.assertEqual(result.function_calls[0].arguments["text"], "olá")

    def test_native_required_rejects_text_then_accepts_function_call(self):
        class Model:
            kwargs = {"tools": [{"type": "function", "function": {"name": "response", "parameters": {"required": ["text"]}}}], "tool_choice": "required"}
            def __init__(self): self.requests = []
            async def unified_turn(self, **kwargs):
                self.requests.append(kwargs)
                if len(self.requests) == 1:
                    return types.SimpleNamespace(response='{"tool_name":',
                                                 capability={}, function_calls=[])
                return types.SimpleNamespace(response="", capability={},
                    output_items=[types.SimpleNamespace(type="function_call", data={"name":"response", "arguments":'{"text":"ok"}'})],
                    function_calls=[types.SimpleNamespace(name="response", arguments={"text":"ok"})])
        async def no_wait(_): pass
        async def native_turn(model, request): return await model.unified_turn(**request)
        model = Model()
        result = asyncio.run(KimiRetryModel(model, sleep=no_wait, native_turn=native_turn).unified_turn(messages=[]))
        self.assertEqual(len(model.requests), 2)
        self.assertEqual(model.requests[1]["user_message"], NATIVE_RESPONSE_CORRECTION)
        self.assertEqual(result.function_calls[0].name, "response")

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

    def test_empty_result_metadata_exposes_finish_reason_without_content(self):
        error = EmptyModelResponse(types.SimpleNamespace(
            response='', reasoning='thinking', output_items=[],
            capability={'finish_reason': 'length'}))
        self.assertIn("finish_reason='length'", str(error))
        self.assertIn('reasoning_chars=8', str(error))
        self.assertTrue(is_retryable(error))

    def test_reasoning_only_retried_inside_same_turn(self):
        class Model:
            calls=0
            requests=[]
            async def unified_turn(self, **kwargs):
                self.calls+=1
                self.requests.append(kwargs.get('user_message', ''))
                return types.SimpleNamespace(response='' if self.calls==1 else 'done',reasoning='thoughts',function_calls=[])
        async def no_wait(_): pass
        model=Model()
        result=asyncio.run(KimiRetryModel(model,sleep=no_wait).unified_turn())
        self.assertEqual(result.response,'done')
        self.assertEqual(model.calls,2)
        self.assertEqual(model.requests, ['', EMPTY_RESPONSE_CORRECTION])

    def test_thoughts_only_json_retried_before_agent_dispatch(self):
        class Model:
            def __init__(self): self.requests = []
            async def unified_turn(self, **kwargs):
                self.requests.append(kwargs)
                if len(self.requests) == 1:
                    return types.SimpleNamespace(response='{"thoughts":["I will use browser"]}', function_calls=[])
                return types.SimpleNamespace(response='{"thoughts":[],"headline":"Continue","tool_name":"skills_tool","tool_args":{"action":"list"}}', function_calls=[])
        async def no_wait(_): pass
        model = Model()
        history = ['prior tool succeeded']
        result = asyncio.run(KimiRetryModel(model, sleep=no_wait).unified_turn(
            messages=history, user_message='inspect browser'))
        self.assertIn('"tool_name":"skills_tool"', result.response)
        self.assertEqual(len(model.requests), 2)
        self.assertEqual(model.requests[1]['user_message'], 'inspect browser\n\n' + MALFORMED_RESPONSE_CORRECTION)
        self.assertEqual(history, ['prior tool succeeded'])

    def test_only_root_thoughts_without_tool_is_retried(self):
        self.assertTrue(is_thoughts_only_response(types.SimpleNamespace(
            response='{"thoughts":["partial"]}', function_calls=[])))
        self.assertTrue(is_thoughts_only_response(types.SimpleNamespace(
            response='{"thoughts":["truncated"', function_calls=[])))
        self.assertFalse(is_thoughts_only_response(types.SimpleNamespace(
            response='{"thoughts":[],"tool_name":"response","tool_args":{}}', function_calls=[])))
        self.assertFalse(is_thoughts_only_response(types.SimpleNamespace(
            response='{"thoughts":["partial"]}', function_calls=[{'name':'response'}])))

    def test_malformed_response_exposes_safe_finish_metadata(self):
        error = MalformedModelResponse(types.SimpleNamespace(
            response='{"thoughts":["partial"]}', reasoning='', output_items=[],
            capability={'finish_reason': 'length'}))
        self.assertIn("finish_reason='length'", str(error))
        self.assertIn('response_chars=24', str(error))

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

    def test_retry_isolates_mutations_made_by_core_model(self):
        class Model:
            def __init__(self): self.requests = []
            async def unified_turn(self, **kwargs):
                messages = kwargs['messages']
                messages.insert(0, 'injected system')
                messages.append(kwargs['user_message'])
                self.requests.append(list(messages))
                if len(self.requests) < 3:
                    raise RuntimeError('incomplete response')
                return types.SimpleNamespace(response='ok', capability={}, function_calls=[])
        async def no_wait(_): pass
        history = ['original history']
        model = Model()
        asyncio.run(KimiRetryModel(model, sleep=no_wait).unified_turn(
            messages=history, user_message='original user request'))
        self.assertEqual(history, ['original history'])
        self.assertEqual(model.requests, [
            ['injected system', 'original history', 'original user request'],
        ] * 3)

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
