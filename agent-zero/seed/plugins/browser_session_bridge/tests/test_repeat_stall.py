import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock


OVERRIDE = Path('/a0/extensions/python/message_loop_result/_30_repeat_response.py')
if not OVERRIDE.exists():
    OVERRIDE = Path(__file__).resolve().parents[4] / 'overrides' / '_30_repeat_response.py'
spec = importlib.util.spec_from_file_location('repeat_response_stall', OVERRIDE)
repeat = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repeat)


class RepeatStallTests(unittest.TestCase):
    def test_silent_running_session_forces_diagnosis_then_bounded_stop(self):
        call = json.dumps({'tool_name': 'code_execution_tool', 'tool_args': {'runtime': 'output', 'session': 0}})
        signature = 'stalled-output:0'
        persistent = {
            '_terminal_no_progress': {'0': 2},
            repeat.STATE_KEY: {'signature': signature, 'iteration': 1, 'count': 1},
        }
        loop = SimpleNamespace(
            last_response=call, iteration=2, params_persistent=persistent,
            params_temporary={}, protocol_temporary={},
        )
        agent = SimpleNamespace(
            loop_data=loop,
            context=SimpleNamespace(log=SimpleNamespace(log=MagicMock())),
            read_prompt=lambda *args, **kwargs: 'Repeated action warning',
            get_data=lambda key: SimpleNamespace(shells={0: SimpleNamespace(running=True)}) if key == '_cet_state' else None,
            agent_name='A0',
        )
        self.assertEqual(repeat._terminal_silent_polls(agent, call), 2)
        self.assertEqual(repeat._terminal_session_running(agent, call), True)
        first = {'llm_result': SimpleNamespace(response=call, reasoning='', output_items=[])}
        repeat.RepeatResponse(agent).execute(result_data=first)
        self.assertTrue(first.get('skip_default_processing'))
        self.assertIn('DIFFERENT terminal session', loop.protocol_temporary['repeat_guard'])

        loop.iteration = 3
        second = {'llm_result': SimpleNamespace(response=call, reasoning='', output_items=[])}
        repeat.RepeatResponse(agent).execute(result_data=second)
        final = json.loads(second['llm_result'].response)
        self.assertEqual(final['tool_name'], 'response')
        self.assertIn('não o matei', final['tool_args']['text'])


if __name__ == '__main__':
    unittest.main()
