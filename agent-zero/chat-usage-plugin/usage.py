"""Cumulative model usage for one Agent Zero chat.

Browser ChatGPT usage is synthesized by the bridge, not reported by ChatGPT.
Keep it explicitly estimated even when the bridge supplies token numbers.
"""

from __future__ import annotations

from typing import Any

from helpers.tokens import approximate_prompt_tokens


def _nonnegative_int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return 0


def _message_text(message: Any) -> str:
    content = getattr(message, "content", None)
    if content is None and isinstance(message, dict):
        content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(part.get("text", "")) if isinstance(part, dict) else str(part)
            for part in content
        )
    return str(content or "")


def usage_delta(result: Any, messages: Any, model_name: str) -> dict[str, Any]:
    usage = getattr(result, "usage", None) or {}
    if not isinstance(usage, dict):
        usage = {}
    reported_input = _nonnegative_int(usage.get("input_tokens") or usage.get("prompt_tokens"))
    reported_output = _nonnegative_int(usage.get("output_tokens") or usage.get("completion_tokens"))
    has_reported = reported_input > 0 or reported_output > 0
    if not has_reported:
        prompt = "\n".join(_message_text(m) for m in (messages or []))
        reported_input = approximate_prompt_tokens(prompt)
        answer = f"{getattr(result, 'reasoning', '') or ''}\n{getattr(result, 'response', '') or ''}"
        reported_output = approximate_prompt_tokens(answer)
    browser = "chatgpt-browser" in model_name.lower()
    return {
        "input": reported_input,
        "output": reported_output,
        "estimated": browser or not has_reported,
    }


def accumulate(current: Any, delta: dict[str, Any]) -> dict[str, Any]:
    current = current if isinstance(current, dict) else {}
    input_tokens = _nonnegative_int(current.get("input")) + _nonnegative_int(delta.get("input"))
    output_tokens = _nonnegative_int(current.get("output")) + _nonnegative_int(delta.get("output"))
    return {
        "input": input_tokens,
        "output": output_tokens,
        "total": input_tokens + output_tokens,
        "calls": _nonnegative_int(current.get("calls")) + 1,
        "estimated": bool(current.get("estimated")) or bool(delta.get("estimated")),
    }


def record(context: Any, result: Any, messages: Any, model_name: str) -> None:
    delta = usage_delta(result, messages, model_name)
    context.set_output_data(
        "chat_token_usage",
        accumulate(context.get_output_data("chat_token_usage"), delta),
    )
