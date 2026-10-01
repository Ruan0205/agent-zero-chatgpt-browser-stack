"""Direct OpenAI-compatible Chat Completions transport for we64 Kimi.

The installed LiteLLM adapter silently drops/ignores native tool selection for
this provider. Keep Agent Zero's own message conversion and tool dispatcher,
but send the function catalog to we64 without that intermediary.
"""

from __future__ import annotations

import json
import uuid
from typing import Any


GENERATION_KEYS = {
    "temperature", "top_p", "max_tokens", "max_completion_tokens",
    "frequency_penalty", "presence_penalty", "stop", "response_format",
}


def build_request(model: Any, request: dict[str, Any]) -> tuple[str, dict[str, str], dict[str, Any], float]:
    from langchain_core.messages import HumanMessage, SystemMessage

    options = getattr(model, "kwargs", {})
    if not isinstance(options, dict) or not options.get("api_key") or not options.get("api_base"):
        raise RuntimeError("Kimi native transport requires configured API key and base URL")
    messages = list(request.get("messages") or [])
    if request.get("system_message"):
        messages.insert(0, SystemMessage(content=request["system_message"]))
    if request.get("user_message"):
        messages.append(HumanMessage(content=request["user_message"]))
    prepared = model._convert_messages(messages)
    payload: dict[str, Any] = {
        "model": str(model.model_name).split("/")[-1],
        "messages": prepared,
        "tools": options["tools"],
        "tool_choice": options.get("tool_choice", "required"),
        "parallel_tool_calls": options.get("parallel_tool_calls", False),
        "stream": False,
    }
    payload.update({key: value for key in GENERATION_KEYS if (value := options.get(key)) is not None})
    headers = {"Authorization": "Bearer " + str(options["api_key"]), "Content-Type": "application/json"}
    return str(options["api_base"]).rstrip("/") + "/chat/completions", headers, payload, float(options.get("timeout") or 1200)


def parse_response(data: dict[str, Any], *, model_name: str, input_messages: list[dict[str, Any]]) -> Any:
    from helpers.llm_result import LLMResult
    from helpers.litellm_transport import ResponsesTransport

    choices = data.get("choices") or []
    if not choices:
        raise ValueError("Kimi returned no choices")
    choice = choices[0]
    message = choice.get("message") or {}
    output_items = []
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        output_items.append({
            "type": "function_call",
            "id": str(call.get("id") or ""),
            "call_id": str(call.get("id") or ""),
            "name": str(function.get("name") or ""),
            "arguments": function.get("arguments") or "{}",
        })
    return LLMResult.from_chat(
        response=message.get("content") or "",
        reasoning=message.get("reasoning_content") or "",
        usage=data.get("usage") or {},
        input_items=ResponsesTransport.input_from_messages(input_messages),
        output_items=output_items,
        provider_model_key=model_name,
        capability={"mode": "chat_completions", "state": "off", "finish_reason": choice.get("finish_reason")},
    )


async def direct_kimi_turn(model: Any, request: dict[str, Any]) -> Any:
    import httpx

    url, headers, payload, timeout = build_request(model, request)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
    return parse_response(data, model_name=model.model_name, input_messages=payload["messages"])


def promote_complete_text_call(result: Any, tools: list[dict[str, Any]]) -> Any:
    """Bridge only a final response when the provider ignores native calling.

    No textual envelope may trigger a side-effecting tool. Such turns are
    retried by the native guard instead of being mistaken for API tool calls.
    Partial JSON, duplicate keys and ambiguous arguments are rejected.
    """
    if getattr(result, "function_calls", None):
        return result
    content = getattr(result, "response", "")
    if not isinstance(content, str) or not content.strip():
        return result
    stripped = content.strip()
    allowed = {item.get("function", {}).get("name") for item in tools}
    if not stripped.startswith("{"):
        # Chat Completions permits a normal assistant final message. Agent Zero
        # expects its final response function, so bridge only ordinary prose.
        # Never execute text that resembles a partial tool envelope.
        # An ordinary final explanation may legitimately *mention* a tool
        # name or even the word "tool_args" after reporting what it did.
        # Reject only content that begins like a call/envelope or fenced code;
        # this path dispatches the non-side-effecting response tool alone.
        if "response" not in allowed or stripped.casefold().startswith(
            ("tool_name", "tool_args", "dsml", "```", "<invoke", "<function")
        ):
            return result
        name, arguments = "response", {"text": content}
        fallback_kind = "kimi_plain_final_adapter"
    else:
        fallback_kind = "kimi_text_tool_fallback"

        def unique_pairs(pairs):
            obj = {}
            for key, value in pairs:
                if key in obj:
                    raise ValueError("duplicate tool-call key")
                obj[key] = value
            return obj

        try:
            request = json.loads(content, object_pairs_hook=unique_pairs)
        except (TypeError, ValueError):
            return result
        if not isinstance(request, dict):
            return result
        name, arguments = request.get("tool_name"), request.get("tool_args")
        if name == "tasks.list_tasks" and "tasks" in allowed:
            name = "tasks"
            if isinstance(arguments, dict):
                arguments = {**arguments, "action": "list_tasks"}
        if name != "response" or name not in allowed or not isinstance(arguments, dict):
            return result
    from helpers.llm_result import ResponseItem
    result.output_items = [ResponseItem("function_call", {
        "type": "function_call", "name": name,
        "arguments": json.dumps(arguments, ensure_ascii=False),
        "call_id": "kimi_compat_" + uuid.uuid4().hex,
    })]
    result.response = result.function_calls_text()
    result.capability = {**getattr(result, "capability", {}), fallback_kind: True}
    return result
