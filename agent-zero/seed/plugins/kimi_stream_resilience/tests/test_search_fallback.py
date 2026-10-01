"""Run in the Agent Zero container where its tool package is importable."""

import importlib.util
import asyncio
from pathlib import Path
import unittest


class SearchFallbackTests(unittest.TestCase):
    @staticmethod
    def module():
        path = Path("/a0/usr/agents/agent0/tools/search_engine.py")
        if not path.exists():
            return None
        spec = importlib.util.spec_from_file_location("local_search_fallback", path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(module)
        return module

    def test_extracts_bounded_public_results(self):
        module = self.module()
        if module is None:
            self.skipTest("requires deployed Agent Zero tool")
        results = module.parse_bing_results(
            '<li class="b_algo"><h2><a href="https://www.python.org/">Python</a></h2>'
            '<div class="b_caption"><p>Official site</p></div></li>'
            '<li class="b_algo"><h2><a href="javascript:bad()">Ignore</a></h2></li>'
        )
        self.assertEqual(results, [("Python", "https://www.python.org/", "Official site")])

    def test_live_public_fallback(self):
        module = self.module()
        if module is None:
            self.skipTest("requires deployed Agent Zero tool")
        results = asyncio.run(module.fetch_bing_results("python.org official website"))
        self.assertTrue(results)


if __name__ == "__main__":
    unittest.main()
