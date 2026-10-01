import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_transport import build_request, parse_response, promote_complete_text_call


TOOLS = [{"type": "function", "function": {"name": "response"}}]


class Model:
    model_name = "openai/kimi-k3"
    kwargs = {"api_key": "test-secret", "api_base": "https://example.invalid/v1",
              "timeout": 1200, "tools": TOOLS, "tool_choice": "required"}

    def _convert_messages(self, messages):
        return [{"role": "user" if m.type == "human" else "system", "content": m.content}
                for m in messages]


class NativeTransportTests(unittest.TestCase):
    def test_build_request_preserves_catalog_and_current_user_message(self):
        url, headers, payload, timeout = build_request(Model(), {"user_message": "Oi", "messages": []})
        self.assertEqual(url, "https://example.invalid/v1/chat/completions")
        self.assertEqual(payload["tool_choice"], "required")
        self.assertEqual(payload["messages"][-1]["content"], "Oi")
        self.assertEqual(len(payload["tools"]), 1)
        self.assertEqual(timeout, 1200)
        self.assertTrue(headers["Authorization"].startswith("Bearer "))

    def test_native_provider_call_becomes_dispatchable_function(self):
        result = parse_response({"choices": [{"finish_reason": "tool_calls", "message": {
            "tool_calls": [{"id": "call_1", "function": {"name": "response",
                             "arguments": '{"text":"Olá"}'}}]}}], "usage": {"prompt_tokens": 2}},
            model_name="openai/kimi-k3", input_messages=[])
        self.assertEqual(result.function_calls[0].name, "response")
        self.assertEqual(result.function_calls[0].arguments, {"text": "Olá"})
        self.assertEqual(result.usage["prompt_tokens"], 2)

    def test_exact_legacy_envelope_is_only_safe_fallback(self):
        from helpers.llm_result import LLMResult
        result = LLMResult.from_chat(response='{"tool_name":"response","tool_args":{"text":"Olá"}}')
        promoted = promote_complete_text_call(result, TOOLS)
        self.assertEqual(promoted.function_calls[0].arguments["text"], "Olá")
        self.assertTrue(promoted.capability["kimi_text_tool_fallback"])
        action_tools = TOOLS + [{"type": "function", "function": {"name": "code_execution_tool"}}]
        rejected_action = promote_complete_text_call(
            LLMResult.from_chat(response='{"tool_name":"code_execution_tool","tool_args":{"code":"echo no"}}'),
            action_tools,
        )
        self.assertFalse(rejected_action.function_calls)
        for content in (
            '{"tool_name":"response","tool_name":"response","tool_args":{"text":"Olá"}}',
            '{"tool_name":"unknown","tool_args":{}}',
            '```json\n{"tool_name":"response","tool_args":{}}\n```',
            '{"tool_name":"response","tool_args":',
        ):
            with self.subTest(content=content):
                rejected = promote_complete_text_call(LLMResult.from_chat(response=content), TOOLS)
                self.assertFalse(rejected.function_calls)

    def test_plain_final_text_only_maps_to_response(self):
        from helpers.llm_result import LLMResult
        result = promote_complete_text_call(LLMResult.from_chat(response="As pastas são src e docs."), TOOLS)
        self.assertEqual(result.function_calls[0].name, "response")
        self.assertEqual(result.function_calls[0].arguments["text"], "As pastas são src e docs.")
        self.assertTrue(result.capability["kimi_plain_final_adapter"])
        explanatory = promote_complete_text_call(
            LLMResult.from_chat(response="Concluído com office_artifact; tool_name foi apenas parte do diagnóstico."),
            TOOLS,
        )
        self.assertEqual(explanatory.function_calls[0].name, "response")
        unsafe = promote_complete_text_call(LLMResult.from_chat(response="tool_name: code_execution_tool"), TOOLS)
        self.assertFalse(unsafe.function_calls)


if __name__ == "__main__":
    unittest.main()
