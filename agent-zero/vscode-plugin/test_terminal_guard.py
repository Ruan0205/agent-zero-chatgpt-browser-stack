import importlib.util
from pathlib import Path
import sys
import types
import unittest

helpers = types.ModuleType("helpers")
extension = types.ModuleType("helpers.extension")
extension.Extension = object
sys.modules.setdefault("helpers", helpers)
sys.modules.setdefault("helpers.extension", extension)

spec=importlib.util.spec_from_file_location('vscode_terminal_guard', Path(__file__).parent/'extensions/python/tool_execute_before/_20_vscode_terminal_guard.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class TerminalGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_terminal_and_keyboard_transport_are_not_rewritten(self):
        guard=object.__new__(module.VscodeTerminalGuard)
        for name,args in [('code_execution_tool',{'runtime':'terminal','code':'read x','session':3}),
                          ('input',{'keyboard':'hello','session':3})]:
            before=dict(args)
            await guard.execute(tool_name=name,tool_args=args)
            self.assertEqual(args,before)

    async def test_editor_alias_remains_available(self):
        guard=object.__new__(module.VscodeTerminalGuard)
        args={'action':'patch','find':'old','replace':'new'}
        await guard.execute(tool_name='text_editor',tool_args=args)
        self.assertEqual(args,{'action':'patch','old_text':'old','new_text':'new'})


if __name__ == '__main__':
    unittest.main()
