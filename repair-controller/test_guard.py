import asyncio
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path


helpers = types.ModuleType("helpers")
extension = types.ModuleType("helpers.extension")
extension.Extension = type("Extension", (), {})
sys.modules["helpers"] = helpers
sys.modules["helpers.extension"] = extension
guard_path = Path(__file__).resolve().parents[1] / "agent-zero/repair-guard-plugin/extensions/python/tool_execute_before/_05_require_approval.py"
spec = importlib.util.spec_from_file_location("repair_guard", guard_path)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class RepairGuardTest(unittest.TestCase):
    def test_only_approved_context_can_use_repair_tools(self):
        with tempfile.TemporaryDirectory() as temp:
            old = os.environ.get("REPAIR_CONTROL_DIR")
            os.environ["REPAIR_CONTROL_DIR"] = temp
            try:
                gate = guard.RequireRepairApproval()
                gate.agent = types.SimpleNamespace(context=types.SimpleNamespace(id="repair-one"))
                asyncio.run(gate.execute(tool_name="document_query"))
                with self.assertRaises(PermissionError):
                    asyncio.run(gate.execute(tool_name="code_execution_tool"))
                (Path(temp) / "repair-one.approved").write_text("approved")
                asyncio.run(gate.execute(tool_name="code_execution_tool"))
                gate.agent.context.id = "repair-two"
                with self.assertRaises(PermissionError):
                    asyncio.run(gate.execute(tool_name="code_execution_tool"))
            finally:
                if old is None:
                    os.environ.pop("REPAIR_CONTROL_DIR", None)
                else:
                    os.environ["REPAIR_CONTROL_DIR"] = old


if __name__ == "__main__":
    unittest.main()
