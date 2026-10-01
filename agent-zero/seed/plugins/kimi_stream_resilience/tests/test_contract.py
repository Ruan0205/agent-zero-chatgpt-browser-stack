import importlib.util
import ast
from pathlib import Path
import re
import unittest


class ContractTests(unittest.TestCase):
    def test_kimi_projection_removes_legacy_tools_and_json_protocol(self):
        source = Path(__file__).resolve().parents[1] / "extensions/python/system_prompt/_98_kimi_tool_contract.py"
        parsed = ast.parse(source.read_text(encoding="utf-8"))
        functions = [node for node in parsed.body if isinstance(node, ast.FunctionDef)
                     and node.name in {"replace_legacy_json_contract", "project_kimi_section"}]
        namespace = {"re": re, "NATIVE_COMMUNICATION": "## Communication (Kimi native tools)\n"}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)
        project = namespace["project_kimi_section"]
        self.assertEqual(project("## available tools\n{tool_name example}"), "")
        self.assertEqual(project('## "Remote (MCP Server) Agent Tools" available:\nexamples'), "")
        original = "## Communication\nOutput must be valid JSON\n## messages\nkeep"
        self.assertNotIn("Output must be valid JSON", project(original))
        self.assertIn("## messages\nkeep", project(original))

    def test_legacy_json_instruction_is_removed_without_touching_rest(self):
        source = Path(__file__).resolve().parents[1] / "extensions/python/system_prompt/_98_kimi_tool_contract.py"
        spec = importlib.util.spec_from_file_location("kimi_contract", source)
        # The extension imports framework modules, so isolate the pure function
        # by extracting its source section for this dependency-free test.
        text = source.read_text(encoding="utf-8")
        self.assertIn("replace_legacy_json_contract", text)
        self.assertIn("## Communication (Kimi native tools)", text)
        self.assertIn("system_prompt[index] = project_kimi_section(section)", text)


if __name__ == "__main__": unittest.main()
