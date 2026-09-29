"""Cumulative model usage for one Agent Zero chat.

Browser ChatGPT usage is synthesized by the bridge, not reported by ChatGPT.
Keep it explicitly estimated even when the bridge supplies token numbers.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

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


def model_bucket(model_name: str) -> str:
    name = str(model_name or "").casefold()
    if "chatgpt-browser" in name:
        return "browser"
    if "kimi-k3" in name:
        return "kimi"
    return "other"


def usage_month(now: datetime | None = None) -> str:
    moment = now or datetime.now(ZoneInfo("America/Sao_Paulo"))
    if moment.tzinfo is not None:
        moment = moment.astimezone(ZoneInfo("America/Sao_Paulo"))
    return moment.strftime("%Y-%m")


def record(context: Any, result: Any, messages: Any, model_name: str,
           now: datetime | None = None, elapsed_seconds: float | None = None) -> None:
    delta = usage_delta(result, messages, model_name)
    previous = context.get_output_data("chat_token_usage")
    previous = previous if isinstance(previous, dict) else {}
    by_model = previous.get("by_model")
    by_model = dict(by_model) if isinstance(by_model, dict) else {}
    bucket = model_bucket(model_name)
    by_model[bucket] = accumulate(by_model.get(bucket), delta)
    total = accumulate(previous, delta)
    total["by_model"] = by_model
    monthly = previous.get("by_month")
    monthly = dict(monthly) if isinstance(monthly, dict) else {}
    month = usage_month(now)
    month_previous = monthly.get(month)
    month_previous = month_previous if isinstance(month_previous, dict) else {}
    month_by_model = month_previous.get("by_model")
    month_by_model = dict(month_by_model) if isinstance(month_by_model, dict) else {}
    month_by_model[bucket] = accumulate(month_by_model.get(bucket), delta)
    month_total = accumulate(month_previous, delta)
    month_total["by_model"] = month_by_model
    monthly[month] = month_total
    total["by_month"] = monthly
    if elapsed_seconds is not None and elapsed_seconds > 0:
        total["last_call"] = {
            "output_tokens": delta["output"],
            "elapsed_seconds": round(elapsed_seconds, 3),
            "tokens_per_second": round(delta["output"] / elapsed_seconds, 1),
            "estimated": bool(delta["estimated"]),
            "model": bucket,
        }
    elif isinstance(previous.get("last_call"), dict):
        total["last_call"] = previous["last_call"]
    context.set_output_data(
        "chat_token_usage",
        total,
    )
