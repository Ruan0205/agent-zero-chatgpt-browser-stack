from typing import Any

from helpers.extension import Extension

MAX_TOOL_RESULT_CHARS = 48000
TOOL_RESULT_PREVIEW_CHARS = 12000

def bound_tool_result(data: dict[str, Any], max_chars: int = MAX_TOOL_RESULT_CHARS) -> bool:
    result = data.get('tool_result')
    raw_file = data.get('file')
    if result is None or not raw_file:
        return False
    text = str(result)
    if len(text) <= max_chars:
        return False
    edge = min(TOOL_RESULT_PREVIEW_CHARS, max(1, (max_chars - 1024) // 2))
    data['tool_result'] = f'[Tool result compacted for model context; original_chars={len(text)}; full_output_file={raw_file}]\n{text[:edge]}\n...[middle omitted from model context]...\n{text[-edge:]}'
    data['tool_result_compacted'] = True
    data['tool_result_original_chars'] = len(text)
    return True

class BoundLargeToolResult(Extension):
    def execute(self, data: dict[str, Any] | None = None, **kwargs):
        if data:
            bound_tool_result(data)
