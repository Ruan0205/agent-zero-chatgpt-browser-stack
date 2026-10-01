import sys
from pathlib import Path
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from native_history import neutralize_initial_greeting


class Message(SimpleNamespace):
    def model_copy(self, update):
        return Message(**{**self.__dict__, **update})


class NativeHistoryTests(unittest.TestCase):
    def test_only_bundled_ai_greeting_is_rewritten_in_request_copy(self):
        greeting = Message(type="ai", content='{"headline":"Greeting user and starting conversation","tool_name":"response"}')
        user = Message(type="human", content=greeting.content)
        messages = [greeting, user]
        projected = neutralize_initial_greeting(messages)
        self.assertIsNot(projected, messages)
        self.assertIn("native API functions", projected[0].content)
        self.assertEqual(projected[1].content, user.content)
        self.assertEqual(messages[0].content, greeting.content)


if __name__ == "__main__":
    unittest.main()
