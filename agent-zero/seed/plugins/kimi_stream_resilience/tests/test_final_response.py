import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "kimi_final_response", ROOT / "extensions/python/tool_execute_after/_95_kimi_final_response.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FinalResponseTests(unittest.TestCase):
    def test_nonstreaming_kimi_final_updates_generating_log_once(self):
        events = []
        generating = SimpleNamespace(update=lambda **kwargs: events.append(kwargs))
        params = {"kimi_native_turn": True, "log_item_generating": generating}
        agent = SimpleNamespace(loop_data=SimpleNamespace(params_temporary=params))
        instance = SimpleNamespace(agent=agent)
        response = SimpleNamespace(message="Encontrei as pastas src e docs.")
        asyncio.run(MODULE.KimiFinalResponse.execute(instance, response=response, tool_name="response"))
        asyncio.run(MODULE.KimiFinalResponse.execute(instance, response=response, tool_name="response"))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "response")
        self.assertTrue(events[0]["finished"])
        self.assertIs(params["log_item_response"], generating)

    def test_other_models_are_untouched(self):
        params = {"log_item_generating": SimpleNamespace(update=lambda **kwargs: self.fail("changed"))}
        agent = SimpleNamespace(loop_data=SimpleNamespace(params_temporary=params))
        instance = SimpleNamespace(agent=agent)
        asyncio.run(MODULE.KimiFinalResponse.execute(instance,
            response=SimpleNamespace(message="olá"), tool_name="response"))
        self.assertNotIn("log_item_response", params)


if __name__ == "__main__":
    unittest.main()
