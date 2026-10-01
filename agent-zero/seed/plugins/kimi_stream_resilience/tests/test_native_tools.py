import sys
from pathlib import Path
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_tools import chat_completion_tools, configure_kimi_native_tools


class NativeToolsTests(unittest.TestCase):
    def setUp(self):
        self.inventory = [
            {"type": "function", "name": "response", "description": "Finish",
             "parameters": {"type": "object", "properties": {"text": {"type": "string"}}}},
            {"type": "function", "name": "code_execution_tool", "description": "Run code",
             "parameters": {"type": "object", "properties": {}, "additionalProperties": True}},
        ]

    def test_converts_real_inventory_shape_without_losing_schema(self):
        tools = chat_completion_tools(self.inventory)
        self.assertEqual([tool["function"]["name"] for tool in tools],
                         ["response", "code_execution_tool"])
        self.assertEqual(tools[0]["function"]["parameters"]["required"], ["text"])
        self.assertEqual(tools[1]["function"]["parameters"], self.inventory[1]["parameters"])
        self.assertEqual(tools[0]["type"], "function")

    def test_kimi_only_and_no_global_mutation(self):
        kimi = SimpleNamespace(model_name="other/kimi-k3", kwargs={"temperature": 0.4})
        browser = SimpleNamespace(model_name="other/chatgpt-browser", kwargs={})
        self.assertEqual(configure_kimi_native_tools({"model": kimi,
                          "a0_responses_function_tools": self.inventory}), 2)
        self.assertEqual(kimi.kwargs["tool_choice"], "required")
        self.assertFalse(kimi.kwargs["parallel_tool_calls"])
        self.assertEqual(configure_kimi_native_tools({"model": browser,
                          "a0_responses_function_tools": self.inventory}), 0)
        self.assertEqual(browser.kwargs, {})

    def test_empty_authorized_inventory_fails_closed(self):
        kimi = SimpleNamespace(model_name="other/kimi-k3", kwargs={})
        with self.assertRaisesRegex(RuntimeError, "empty authorized inventory"):
            configure_kimi_native_tools({"model": kimi, "a0_responses_function_tools": []})

    def test_internal_utility_call_without_inventory_remains_text_only(self):
        utility = SimpleNamespace(model_name="other/kimi-k3", kwargs={})
        self.assertEqual(configure_kimi_native_tools({"model": utility}), 0)
        self.assertEqual(utility.kwargs, {})

    def test_prose_only_tools_get_executable_native_arguments(self):
        names = ("browser", "text_editor", "office_artifact", "document_query",
                 "scheduler", "parallel", "a2a_chat", "vscode", "chatgpt_browser_media")
        descriptors = [{"type": "function", "name": name, "description": name,
                        "parameters": {"type": "object", "properties": {}}} for name in names]
        tools = chat_completion_tools(descriptors)
        self.assertEqual([tool["function"]["name"] for tool in tools], list(names))
        for tool in tools:
            self.assertTrue(tool["function"]["parameters"]["properties"], tool["function"]["name"])
        self.assertEqual(tools[0]["function"]["parameters"]["required"], ["action"])
        self.assertEqual(tools[1]["function"]["parameters"]["required"], ["action", "path"])
        scheduler = tools[4]["function"]["parameters"]
        self.assertIn("uuid", scheduler["properties"])
        self.assertIn("delete_task", scheduler["properties"]["action"]["enum"])
        self.assertIn("create_planned_task", scheduler["properties"]["action"]["enum"])

    def test_search_query_is_not_lost_when_framework_descriptor_is_empty(self):
        descriptor = [{"type": "function", "name": "search_engine", "description": "Search",
                       "parameters": {"type": "object", "properties": {}}}]
        schema = chat_completion_tools(descriptor)[0]["function"]["parameters"]
        self.assertEqual(schema["required"], ["query"])
        self.assertEqual(schema["properties"]["query"]["type"], "string")


if __name__ == "__main__":
    unittest.main()
