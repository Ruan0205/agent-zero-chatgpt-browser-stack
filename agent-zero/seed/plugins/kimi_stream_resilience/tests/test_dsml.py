import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dsml import InvalidDSML, normalize_result, parse_dsml


def call(name='text_editor', params=None):
    parts = []
    for key, value, string in params or [('action', 'patch', True)]:
        parts.append(f'<｜｜DSML｜｜ parameter name="{key}" string="{str(string).lower()}">{value}</｜｜DSML｜｜ parameter>')
    return f'<｜｜DSML｜｜ invoke name="{name}">' + ''.join(parts) + '</｜｜DSML｜｜ invoke>'


def wrap(body):
    return '<｜｜DSML｜｜ calls>\n' + body + '\n</｜｜DSML｜｜ calls>'


class DSMLTest(unittest.TestCase):
    def test_real_patch_shape_preserves_code_and_whitespace(self):
        code = '  const x = "<&>\\n";\n\t// keep exactly\n'
        parsed = parse_dsml(wrap(call(params=[('action', 'patch', True), ('new_text', code, True)])))
        self.assertEqual(parsed, [('text_editor', {'action': 'patch', 'new_text': code})])

    def test_typed_values_and_alias_preserved_for_standard_dispatch(self):
        parsed = parse_dsml(wrap(call('tasks.list_tasks', [
            ('reset', 'true', False), ('count', '2', False),
            ('items', '[1, "two"]', False), ('options', '{"x":1}', False), ('nothing', 'null', False),
        ])))
        self.assertEqual(parsed[0][0], 'tasks.list_tasks')
        self.assertEqual(parsed[0][1], {'reset': True, 'count': 2, 'items': [1, 'two'], 'options': {'x': 1}, 'nothing': None})

    def test_all_calls_preserved_in_order(self):
        self.assertEqual([name for name, _ in parse_dsml(wrap(call('text_editor') + call('artifact_verify')))], ['text_editor', 'artifact_verify'])

    def test_ascii_marker_and_leading_commentary(self):
        self.assertEqual(parse_dsml(('Vou editar.\n' + wrap(call())).replace('｜', '|'))[0][0], 'text_editor')

    def test_non_dsml_and_json_are_not_changed(self):
        for text in ['OK', '{"tool_name":"response","tool_args":{"text":"OK"}}', '']:
            self.assertIsNone(parse_dsml(text))

    def test_dsml_example_in_valid_json_code_is_data_not_a_call(self):
        text=json.dumps({'tool_name':'text_editor','tool_args':{'action':'write','content':wrap(call())}})
        self.assertIsNone(parse_dsml(text))

    def test_missing_end_or_extra_suffix_is_rejected(self):
        for text in [wrap(call())[:-10], wrap(call()) + 'extra', wrap(call()) + wrap(call())]:
            with self.assertRaises(InvalidDSML): parse_dsml(text)

    def test_quoted_example_is_rejected(self):
        with self.assertRaises(InvalidDSML): parse_dsml('```xml\n' + wrap(call()))

    def test_duplicate_or_missing_type_is_rejected(self):
        for text in [wrap(call(params=[('x', 'a', True), ('x', 'b', True)])), wrap(call()).replace(' string="true"', ''), wrap(call()).replace('string="true"', 'string="maybe"')]:
            with self.assertRaises(InvalidDSML): parse_dsml(text)

    def test_invalid_typed_value_and_nan_are_rejected(self):
        for value in ['not json', 'NaN', '{"x":Infinity}']:
            with self.assertRaises(InvalidDSML): parse_dsml(wrap(call(params=[('x', value, False)])))

    def test_unknown_attribute_and_nested_markers_rejected(self):
        for text in [wrap(call()).replace('name="action"', 'name="action" other="x"'), wrap(call(params=[('x', wrap(call()), True)]))]:
            with self.assertRaises(InvalidDSML): parse_dsml(text)

    def test_empty_or_malformed_list_rejected_without_partial_calls(self):
        for text in [wrap(''), wrap(call() + 'oops'), wrap(call() + call().replace('</｜｜DSML｜｜ invoke>', ''))]:
            with self.assertRaises(InvalidDSML): parse_dsml(text)

    def test_real_framework_result_preserves_metadata_and_native_dispatch(self):
        try:
            from helpers.llm_result import LLMResult
        except ImportError:
            self.skipTest('Run this integration check in Agent Zero framework runtime')
        result = LLMResult.from_chat(response=wrap(call() + call('artifact_verify')),
            usage={'input_tokens': 123}, capability={'finish_reason': 'stop'})
        result = normalize_result(result)
        self.assertEqual([x.name for x in result.function_calls], ['text_editor', 'artifact_verify'])
        self.assertEqual(result.usage, {'input_tokens': 123})
        self.assertEqual(len(set(x.call_id for x in result.function_calls)), 2)
        self.assertTrue(result.capability['kimi_dsml_normalized'])
        self.assertIs(normalize_result(result), result)

    def test_terminal_cutoff_is_never_normalized(self):
        from types import SimpleNamespace
        result = SimpleNamespace(response=wrap(call()), capability={'finish_reason': 'length'}, function_calls=[])
        self.assertIs(normalize_result(result), result)

    def test_alias_is_normalized_in_native_json_and_dsml(self):
        try:
            from helpers.llm_result import LLMResult, ResponseItem
        except ImportError:
            self.skipTest('Run in framework runtime')
        for result in [
            LLMResult.from_chat(response=wrap(call('tasks.list_tasks', [('message', 'OK', True)]))),
            LLMResult.from_chat(response=json.dumps({'tool_name': 'tasks.list_tasks', 'tool_args': {'message': 'OK'}})),
            LLMResult.from_chat(response='', output_items=[{'type': 'function_call', 'name': 'tasks.list_tasks', 'arguments': '{"message":"OK"}', 'call_id': 'native1'}]),
        ]:
            result = normalize_result(result)
            if result.function_calls:
                self.assertEqual(result.function_calls[0].name, 'tasks')
                self.assertEqual(result.function_calls[0].arguments, {'message': 'OK', 'action': 'list_tasks'})
            else:
                self.assertEqual(json.loads(result.response), {'tool_name': 'tasks', 'tool_args': {'message': 'OK', 'action': 'list_tasks'}})


if __name__ == '__main__': unittest.main()
