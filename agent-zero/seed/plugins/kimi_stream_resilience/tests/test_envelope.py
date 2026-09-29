"""Before/after regression for a redundant {tool_name, tool_args} tool envelope.

Reproduces the real chat SMBI2AAc failure (events 782/784/790): the provider
emitted a complete DSML call whose parameters were ``tool_args`` and ``tool_name``
instead of the tool's flat arguments. The previous adapter preserved that wrapper,
so ``code_execution_tool`` never saw ``runtime`` and logged
``code_execution_tool - unknown`` while executing nothing.

These assertions fail on the old adapter and pass with the strict unwrap. They
also prove ambiguous, conflicting or truncated data is rejected instead of
guessed, and that flat calls, aliases and LLMResult metadata keep working.
"""

import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dsml import (  # noqa: E402
    InvalidDSML,
    normalize_result,
    parse_dsml,
    unwrap_tool_envelope,
)
from test_dsml import call as quoted_call, wrap as quoted_wrap  # noqa: E402

M = '\uff5c\uff5cDSML\uff5c\uff5c'

# The exact arguments the model nested in chat SMBI2AAc event 782.
NESTED = {
    'code': "echo 'FALLBACK: aguardar proximo passo'",
    'reset': False,
    'runtime': 'terminal',
    'session': 1,
}


def param(name, value, is_string):
    kind = 'true' if is_string else 'false'
    return f'<{M} parameter name="{name}" string="{kind}">{value}</{M} parameter>'


def invoke(name, params):
    return f'<{M} invoke name="{name}">' + ''.join(params) + f'</{M} invoke>'


def wrap(body):
    return f'<{M} calls>\n' + body + f'\n</{M} calls>'


def wrapped_dsml(name='code_execution_tool', inner=None):
    """Real bug shape: tool_args (typed JSON) plus redundant tool_name (string)."""
    inner = NESTED if inner is None else inner
    return wrap(invoke(name, [
        param('tool_args', json.dumps(inner), False),
        param('tool_name', name, True),
    ]))


class EnvelopeUnitTests(unittest.TestCase):
    def test_real_captured_shape_is_unwrapped_to_flat_args(self):
        # BEFORE: {'tool_args': {...}, 'tool_name': 'code_execution_tool'} was kept.
        self.assertEqual(parse_dsml(wrapped_dsml()), [('code_execution_tool', NESTED)])

    def test_flat_arguments_are_never_modified(self):
        flat = {'runtime': 'terminal', 'code': 'ls', 'session': 0}
        self.assertEqual(unwrap_tool_envelope('code_execution_tool', dict(flat)), flat)
        self.assertEqual(unwrap_tool_envelope('code_execution_tool', {}), {})

    def test_envelope_is_unwrapped_at_most_once(self):
        nested_inner = {
            'tool_name': 'code_execution_tool',
            'tool_args': {'tool_name': 'code_execution_tool', 'tool_args': {'a': 1}},
        }
        with self.assertRaises(InvalidDSML):
            unwrap_tool_envelope('code_execution_tool', nested_inner)

    def test_conflicting_inner_name_is_rejected(self):
        with self.assertRaises(InvalidDSML):
            unwrap_tool_envelope(
                'text_editor',
                {'tool_name': 'code_execution_tool', 'tool_args': {'a': 1}},
            )

    def test_envelope_mixed_with_extra_keys_is_ambiguous(self):
        with self.assertRaises(InvalidDSML):
            unwrap_tool_envelope('code_execution_tool', {
                'tool_name': 'code_execution_tool',
                'tool_args': {'a': 1},
                'session': 1,
            })

    def test_non_object_and_missing_name_are_rejected(self):
        with self.assertRaises(InvalidDSML):
            unwrap_tool_envelope(
                'code_execution_tool',
                {'tool_name': 'code_execution_tool', 'tool_args': 'not json'},
            )
        with self.assertRaises(InvalidDSML):
            unwrap_tool_envelope('code_execution_tool', {'tool_name': '', 'tool_args': {'a': 1}})

    def test_alias_is_still_translated(self):
        self.assertEqual(
            parse_dsml(wrap(invoke('tasks.list_tasks', [param('message', 'OK', True)]))),
            [('tasks.list_tasks', {'message': 'OK'})],
        )


class EnvelopeFrameworkTests(unittest.TestCase):
    def test_native_wrapped_alias_is_unwrapped_before_alias_translation(self):
        result = normalize_result(self._result(response='', output_items=[{
            'type': 'function_call', 'name': 'tasks.list_tasks', 'call_id': 'alias-wrap',
            'arguments': json.dumps({'tool_name': 'tasks.list_tasks', 'tool_args': {'message': 'OK'}}),
        }]))
        self.assertEqual(result.function_calls[0].name, 'tasks')
        self.assertEqual(result.function_calls[0].arguments, {'message': 'OK', 'action': 'list_tasks'})

    def test_typed_dsml_duplicate_keys_are_rejected(self):
        with self.assertRaises(InvalidDSML):
            parse_dsml(wrap(invoke('code_execution_tool', [
                param('tool_args', '{"runtime":"terminal","runtime":"python"}', False),
                param('tool_name', 'code_execution_tool', True),
            ])))

    def test_native_non_object_arguments_are_rejected(self):
        with self.assertRaises(InvalidDSML):
            normalize_result(self._result(response='', output_items=[{
                'type': 'function_call', 'name': 'text_editor', 'call_id': 'array', 'arguments': '[]',
            }]))

    def _result(self, **kwargs):
        from helpers.llm_result import LLMResult
        return LLMResult.from_chat(**kwargs)

    def test_wrapped_dsml_reaches_dispatch_flat(self):
        # BEFORE: arguments stayed {'tool_args': {...}, 'tool_name': ...} and the
        # code execution tool resolved runtime to 'unknown'.
        result = normalize_result(self._result(response=wrapped_dsml()))
        call = result.function_calls[0]
        self.assertEqual(call.name, 'code_execution_tool')
        self.assertEqual(call.arguments, NESTED)
        self.assertIn('runtime', call.arguments)

    def test_wrapped_native_function_call_is_flattened(self):
        raw = json.dumps({'tool_name': 'code_execution_tool', 'tool_args': dict(NESTED)})
        result = normalize_result(self._result(response='', output_items=[{
            'type': 'function_call',
            'name': 'code_execution_tool',
            'arguments': raw,
            'call_id': 'native-wrap',
        }]))
        self.assertEqual(result.function_calls[0].arguments, NESTED)

    def test_flat_native_call_is_untouched(self):
        raw = json.dumps({'runtime': 'terminal', 'code': 'ls', 'session': 0})
        result = self._result(response='', output_items=[{
            'type': 'function_call',
            'name': 'code_execution_tool',
            'arguments': raw,
            'call_id': 'native-flat',
        }])
        before = result.output_items[0].data['arguments']
        result = normalize_result(result)
        self.assertEqual(result.output_items[0].data['arguments'], before)

    def test_alias_and_metadata_survive_unwrap(self):
        result = self._result(
            response=wrap(invoke('tasks.list_tasks', [param('message', 'OK', True)])),
            usage={'input_tokens': 7},
            capability={'finish_reason': 'stop'},
        )
        result = normalize_result(result)
        self.assertEqual(result.function_calls[0].name, 'tasks')
        self.assertEqual(
            result.function_calls[0].arguments,
            {'message': 'OK', 'action': 'list_tasks'},
        )
        self.assertEqual(result.usage, {'input_tokens': 7})

    def test_duplicate_json_keys_are_rejected_not_silently_overwritten(self):
        duplicate = (
            '{"tool_name":"code_execution_tool",'
            '"tool_args":{"a":1},"tool_args":{"b":2}}'
        )
        with self.assertRaises(InvalidDSML):
            normalize_result(self._result(response=duplicate))

    def test_conflicting_text_envelope_is_rejected(self):
        bad = json.dumps({
            'tool_name': 'text_editor',
            'tool_args': {'tool_name': 'code_execution_tool', 'tool_args': {'a': 1}},
        })
        with self.assertRaises(InvalidDSML):
            normalize_result(self._result(response=bad))

    def test_truncated_arguments_are_rejected(self):
        with self.assertRaises(InvalidDSML):
            normalize_result(self._result(response='', output_items=[{
                'type': 'function_call',
                'name': 'code_execution_tool',
                'arguments': '{"tool_args": {"runtime": "term',
                'call_id': 'trunc',
            }]))

    def test_json_reply_quoting_dsml_content_is_data_not_a_call(self):
        # A legitimate text_editor.write whose content quotes a DSML example.
        # BEFORE: parse_dsml matched the marker inside the string and rejected
        # the whole reply as an ambiguous envelope, so no tool ever ran.
        content = quoted_wrap(quoted_call())
        payload = json.dumps({
            'tool_name': 'text_editor',
            'tool_args': {
                'action': 'write',
                'path': '/tmp/example.md',
                'content': content,
            },
        }, ensure_ascii=False)
        # The payload must carry the literal marker, not an ASCII escape, or this
        # test would pass even on the broken adapter.
        self.assertIn('\uff5c\uff5cDSML', payload)
        self.assertIsNone(parse_dsml(payload))
        normalized = normalize_result(self._result(response=payload))
        self.assertEqual(normalized.function_calls, [])
        self.assertEqual(normalized.response, payload)
        self.assertEqual(json.loads(normalized.response)['tool_args']['content'], content)


if __name__ == '__main__':
    unittest.main()
