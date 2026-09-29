import ast
from pathlib import Path
import unittest


class StartupContractTest(unittest.TestCase):
    def test_sync_init_a0_extension_never_returns_a_coroutine(self):
        path = Path(__file__).resolve().parents[1] / 'extensions/python/_functions/__main__/init_a0/start/_06_queue.py'
        tree = ast.parse(path.read_text())
        methods = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == 'execute']
        self.assertEqual(len(methods), 1)
        self.assertIsInstance(methods[0], ast.FunctionDef)
        self.assertFalse(any(isinstance(node, ast.Await) for node in ast.walk(methods[0])))


if __name__ == '__main__': unittest.main()
