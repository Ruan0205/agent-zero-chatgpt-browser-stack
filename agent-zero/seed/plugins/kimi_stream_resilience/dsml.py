"""Strict adapter for complete Kimi DSML calls leaked as text by a provider.

No execution, dirty JSON repair, XML entity expansion, or argument guessing.
Incomplete or ambiguous envelopes are rejected as a whole.
"""
from __future__ import annotations

import json
import re
import uuid


class InvalidDSML(ValueError):
    pass


MARKER = r'[｜|]{2}DSML[｜|]{2}'
ENVELOPE = re.compile(rf'(?s)\A(?P<prefix>.*?)<{MARKER}\s+calls>\s*(?P<body>.*?)\s*</{MARKER}\s+calls>\s*\Z')
INVOKE = re.compile(rf'(?s)\s*<{MARKER}\s+invoke\s+name="(?P<name>[A-Za-z_][\w.:-]*)"\s*>(?P<body>.*?)</{MARKER}\s+invoke>\s*')
PARAMETER = re.compile(rf'(?s)\s*<{MARKER}\s+parameter\s+(?P<attrs>[^<>]*?)>(?P<value>.*?)</{MARKER}\s+parameter>\s*')
ATTRIBUTE = re.compile(r'\s*(name|string)="([^"<>]*)"\s*')
ENVELOPE_KEYS = frozenset({'tool_name', 'tool_args'})


def _object_without_duplicate_keys(pairs):
    """Reject duplicate JSON keys instead of silently keeping the last value."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidDSML(f'duplicate JSON key: {key}')
        result[key] = value
    return result


def unwrap_tool_envelope(call_name: str, args: dict) -> dict:
    """Unwrap exactly one redundant {tool_name, tool_args} envelope, or reject it.

    The model sometimes nests the whole tool request inside the argument map, so
    the dispatched tool receives tool_args/tool_name instead of its real
    parameters (for example code_execution_tool loses runtime and logs itself as
    unknown). Only an unambiguous envelope naming the very same invoked tool is
    unwrapped, once. Conflicting names, mixed keys, non-object payloads, nested
    envelopes and empty names are rejected as a whole instead of guessed.
    """
    if not isinstance(args, dict) or 'tool_args' not in args:
        return args
    if set(args) != ENVELOPE_KEYS:
        raise InvalidDSML('Ambiguous tool envelope: tool_args mixed with other arguments')
    inner = args['tool_args']
    if not isinstance(inner, dict):
        raise InvalidDSML('Tool envelope tool_args must be an object, not text')
    inner_name = args['tool_name']
    if not isinstance(inner_name, str) or not inner_name:
        raise InvalidDSML('Tool envelope tool_name must be a non-empty string')
    if inner_name != call_name:
        raise InvalidDSML(f'Tool envelope {inner_name!r} does not match invoked tool {call_name!r}')
    if 'tool_args' in inner:
        raise InvalidDSML('Nested tool_args inside an envelope payload is ambiguous')
    return dict(inner)


def _native_arguments(raw) -> dict | None:
    """Native function-call arguments as a dict, or reject malformed/truncated data.

    Empty arguments mean an all-defaults call and are left untouched (None).
    """
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return None
    if not raw.strip():
        return None
    try:
        args = json.loads(raw, object_pairs_hook=_object_without_duplicate_keys)
    except (ValueError, TypeError) as error:
        raise InvalidDSML('Malformed or duplicate-keyed tool call arguments') from error
    if not isinstance(args, dict):
        raise InvalidDSML('Native tool arguments must be a JSON object')
    return args


def _is_json_object(text: str) -> bool:
    """A complete JSON object is data, never a DSML envelope."""
    stripped = text.strip()
    return stripped.startswith('{') and stripped.endswith('}')


def parse_dsml(text: str) -> list[tuple[str, dict]] | None:
    if not isinstance(text, str):
        return None
    if _is_json_object(text):
        # Markers inside a JSON object are string content (for example a
        # text_editor.write whose body quotes a DSML example), not an
        # executable call. The text branch of normalize_result validates it.
        return None
    if not re.search(rf'<{MARKER}\s+calls>', text):
        return None
    envelope = ENVELOPE.fullmatch(text)
    if not envelope or re.search(MARKER, envelope['prefix']):
        raise InvalidDSML('Incomplete or ambiguous DSML envelope')
    # Do not interpret quoted demonstrations or code fences as executable calls.
    if '```' in envelope['prefix'] or envelope['prefix'].lstrip().startswith(('{', '[')):
        raise InvalidDSML('DSML example is not an executable envelope')
    body, cursor, calls = envelope['body'], 0, []
    while cursor < len(body):
        invoke = INVOKE.match(body, cursor)
        if not invoke:
            raise InvalidDSML('Malformed DSML invocation')
        args, parameters, offset = {}, invoke['body'], 0
        while offset < len(parameters):
            if not parameters[offset:].strip():
                break
            parameter = PARAMETER.match(parameters, offset)
            if not parameter:
                raise InvalidDSML('Malformed DSML parameter')
            attrs, attr_offset = {}, 0
            while attr_offset < len(parameter['attrs']):
                attribute = ATTRIBUTE.match(parameter['attrs'], attr_offset)
                if not attribute or attribute[1] in attrs:
                    raise InvalidDSML('Invalid or duplicate DSML attribute')
                attrs[attribute[1]] = attribute[2]
                attr_offset = attribute.end()
            if set(attrs) != {'name', 'string'} or attrs['string'] not in {'true', 'false'}:
                raise InvalidDSML('DSML parameter requires explicit name and string type')
            name, value = attrs['name'], parameter['value']
            if not re.fullmatch(r'[A-Za-z_][\w]*', name) or name in args:
                raise InvalidDSML('Invalid or duplicate DSML argument')
            if re.search(MARKER, value):
                raise InvalidDSML('Nested DSML markers are ambiguous')
            if attrs['string'] == 'false':
                try:
                    value = json.loads(value, object_pairs_hook=_object_without_duplicate_keys,
                                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
                except (ValueError, TypeError) as error:
                    raise InvalidDSML('Invalid typed DSML argument') from error
            args[name] = value
            offset = parameter.end()
        args = unwrap_tool_envelope(invoke['name'], args)
        calls.append((invoke['name'], args))
        cursor = invoke.end()
    if not calls:
        raise InvalidDSML('Empty DSML call list')
    return calls


def normalize_result(result):
    """Convert to framework-native function items, preserving usage and state.

    Existing native calls and terminal cutoffs are never modified. Only response
    text is interpreted: reasoning is not an authorization to execute a tool.
    """
    if getattr(result, 'capability', {}).get('finish_reason') in {'length', 'content_filter'}:
        return result
    if getattr(result, 'function_calls', None):
        # Narrow, explicitly documented alias; never guess an unknown tool.
        for item in result.output_items:
            if item.type != 'function_call':
                continue
            name = item.data.get('name')
            if not isinstance(name, str) or not name:
                continue
            args = _native_arguments(item.data.get('arguments'))
            original_args = args
            if args is not None:
                args = unwrap_tool_envelope(name, args)
            if name == 'tasks.list_tasks':
                args = args if args is not None else {}
                args.setdefault('action', 'list_tasks')
                item.data.update(name='tasks', arguments=json.dumps(args, ensure_ascii=False))
                continue
            if args is None or args is original_args:
                continue
            item.data['arguments'] = json.dumps(args, ensure_ascii=False)
        return result
    calls = parse_dsml(getattr(result, 'response', ''))
    if calls is None:
        # Text JSON alias is accepted only when the full reply is valid JSON.
        try:
            request = json.loads(getattr(result, 'response', ''), object_pairs_hook=_object_without_duplicate_keys)
        except (json.JSONDecodeError, TypeError):
            return result
        if not isinstance(request, dict):
            return result
        changed = False
        if isinstance(request.get('tool_name'), str) and isinstance(request.get('tool_args'), dict):
            unwrapped = unwrap_tool_envelope(request['tool_name'], request['tool_args'])
            changed = unwrapped is not request['tool_args']
            request['tool_args'] = unwrapped
        if request.get('tool_name') == 'tasks.list_tasks' and isinstance(request.get('tool_args'), dict):
            request['tool_name'] = 'tasks'
            request['tool_args'].setdefault('action', 'list_tasks')
            changed = True
        if changed:
            result.response = json.dumps(request, ensure_ascii=False)
        return result
    calls = [('tasks', {**args, 'action': args.get('action', 'list_tasks')})
             if name == 'tasks.list_tasks' else (name, args) for name, args in calls]
    from helpers.llm_result import ResponseItem
    result.output_items = [item for item in result.output_items if item.type != 'message'] + [
        ResponseItem('function_call', {
            'type': 'function_call', 'name': name,
            'arguments': json.dumps(args, ensure_ascii=False),
            'call_id': 'kimi_dsml_' + uuid.uuid4().hex,
        }) for name, args in calls
    ]
    result.response = result.function_calls_text()
    result.capability = {**result.capability, 'kimi_dsml_normalized': True}
    return result
