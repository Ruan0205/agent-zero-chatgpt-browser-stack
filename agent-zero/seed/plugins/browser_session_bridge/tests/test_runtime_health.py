import asyncio
import importlib.util
import json
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1] / 'extensions' / 'python'


def load(relative, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


before = load('tool_execute_before/_20_idle_terminal_output.py', 'idle_terminal_output')
parallel_before = load('tool_execute_before/_30_parallel_monitorable.py', 'parallel_monitorable')
after = load('tool_execute_after/_20_terminal_state.py', 'terminal_state')
health = load('tool_execute_after/_30_parallel_health.py', 'parallel_health')
no_progress = load('tool_execute_after/_40_terminal_no_progress.py', 'terminal_no_progress')


class RuntimeHealthTests(unittest.TestCase):
    def agent(self, running):
        shell = SimpleNamespace(running=running)
        state = SimpleNamespace(shells={0: shell})
        tool = SimpleNamespace(args={'runtime': 'output', 'session': 0})
        return SimpleNamespace(
            get_data=lambda key: state if key == '_cet_state' else None,
            loop_data=SimpleNamespace(current_tool=tool, params_persistent={}),
        )

    def test_idle_output_becomes_immediate_status(self):
        agent = self.agent(False)
        args = agent.loop_data.current_tool.args
        asyncio.run(before.IdleTerminalOutput(agent).execute(tool_name='code_execution_tool', tool_args=args))
        self.assertEqual(args['runtime'], 'terminal')
        self.assertIn('TERMINAL_SESSION_IDLE', args['code'])
        response = SimpleNamespace(message='shell prompt')
        asyncio.run(after.TerminalState(agent).execute(tool_name='code_execution_tool', response=response))
        self.assertIn('TERMINAL_SESSION_IDLE session=0', response.message)

    def test_running_output_is_not_rewritten(self):
        agent = self.agent(True)
        args = agent.loop_data.current_tool.args
        asyncio.run(before.IdleTerminalOutput(agent).execute(tool_name='code_execution_tool', tool_args=args))
        self.assertEqual(args['runtime'], 'output')
        response = SimpleNamespace(message='still working')
        asyncio.run(after.TerminalState(agent).execute(tool_name='code_execution_tool', response=response))
        self.assertIn('TERMINAL_SESSION_RUNNING session=0', response.message)

    def test_parallel_snapshot_shows_child_activity_without_declaring_hang(self):
        child = SimpleNamespace(
            log=SimpleNamespace(logs=[SimpleNamespace(timestamp=time.time() - 5, heading='Building', type='agent')]),
            is_running=lambda: True,
        )
        response = SimpleNamespace(message=json.dumps({
            'status': 'running',
            'jobs': [{'tool_name': 'call_subordinate', 'context_id': 'child', 'state': 'running'}],
        }))
        with patch('agent.AgentContext.get', return_value=child):
            asyncio.run(health.ParallelHealth(self.agent(False)).execute(tool_name='parallel', response=response))
        snapshot = json.loads(response.message)['jobs'][0]['health']
        self.assertTrue(snapshot['context_running'])
        self.assertEqual(snapshot['log_entries'], 1)
        self.assertLess(snapshot['seconds_since_last_log'], 30)
        self.assertIn('does not prove a hang', snapshot['note'])

    def test_subordinate_job_is_monitorable_and_tasks_alias_is_accepted(self):
        args = {'tasks': [{'tool_name': 'call_subordinate', 'tool_args': {'message': 'Review image'}}], 'wait': True}
        asyncio.run(parallel_before.ParallelMonitorable(self.agent(False)).execute(tool_name='parallel', tool_args=args))
        self.assertNotIn('tasks', args)
        self.assertEqual(args['tool_calls'][0]['tool_name'], 'call_subordinate')
        self.assertIs(args['wait'], False)

    def test_two_silent_polls_require_independent_diagnosis_without_killing_job(self):
        agent = self.agent(True)
        silent = '[SYSTEM: Returning control to agent after 120 seconds with no output. Process might be still running.]'
        for expected in (1, 2):
            response = SimpleNamespace(message=silent)
            asyncio.run(no_progress.TerminalNoProgress(agent).execute(tool_name='code_execution_tool', response=response))
            self.assertIn(f'consecutive_silent_polls={expected}', response.message)
        self.assertIn('DIFFERENT terminal', response.message)
        self.assertTrue(agent.get_data('_cet_state').shells[0].running)

        response = SimpleNamespace(message='new output bytes')
        asyncio.run(no_progress.TerminalNoProgress(agent).execute(tool_name='code_execution_tool', response=response))
        self.assertNotIn('0', agent.loop_data.params_persistent['_terminal_no_progress'])


if __name__ == '__main__':
    unittest.main()
