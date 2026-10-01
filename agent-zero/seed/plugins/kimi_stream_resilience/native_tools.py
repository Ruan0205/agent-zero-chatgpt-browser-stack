"""Adapt Agent Zero's *actual* per-turn tool inventory for Kimi Chat Completions.

This module only describes tools. The existing Agent Zero policy and approval
checks remain responsible for every eventual dispatch.
"""

from __future__ import annotations

from typing import Any


# Agent Zero's Responses descriptor builder cannot infer arguments from every
# prose tool prompt. In particular, its response descriptor has an empty
# schema even though Response.execute requires non-empty text/message. Never
# advertise that invalid shape to a native-calling model.
SCHEMA_OVERRIDES: dict[str, dict[str, Any]] = {
    "response": {
        "type": "object",
        "properties": {"text": {"type": "string", "minLength": 1}},
        "required": ["text"],
        "additionalProperties": True,
    },
    "artifact_verify": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "minLength": 1},
            "deep": {"type": "boolean"},
            "require_published": {"type": "boolean"},
        },
        "required": ["path"], "additionalProperties": False,
    },
    "browser_bridge_status": {
        "type": "object", "properties": {}, "additionalProperties": False,
    },
    "job_status": {
        "type": "object",
        "properties": {"job_id": {"type": "string"}, "session": {"type": "integer"}},
        "additionalProperties": False,
    },
    "project_check": {
        "type": "object",
        "properties": {
            "test_command": {"type": "string"}, "http_url": {"type": "string"},
            "container": {"type": "string"}, "timeout": {"type": "integer"},
        },
        "additionalProperties": False,
    },
    "server_diagnostics": {
        "type": "object", "properties": {}, "additionalProperties": False,
    },
    "search_engine": {
        "type": "object",
        "properties": {"query": {"type": "string", "minLength": 1}},
        "required": ["query"], "additionalProperties": False,
    },
    "tasks": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["list_tasks"]},
            "message": {"type": "string", "minLength": 1},
            "reset": {"type": "boolean"},
            "context_id": {"type": "string"},
            "profile": {"type": "string"},
            "name": {"type": "string"},
            "attachments": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["message"], "additionalProperties": False,
    },
}


def _object(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object", "properties": properties,
        "required": required or [], "additionalProperties": False,
    }


_str = {"type": "string"}
_bool = {"type": "boolean"}
_int = {"type": "integer"}
_str_list = {"type": "array", "items": _str}

# These implementations accept **kwargs and their prose prompts do not produce
# machine-readable parameters in Agent Zero's Responses descriptor builder.
# Keep their native schemas aligned with the live execute() contracts rather
# than advertising empty objects, which prevented the model from using them.
SCHEMA_OVERRIDES.update({
    "a2a_chat": _object({"agent_url": _str, "message": _str, "attachments": _str_list, "reset": _bool}, ["agent_url", "message"]),
    "browser": _object({
        "action": _str, "browser_id": {"anyOf": [_int, _str]}, "url": _str,
        "ref": {"anyOf": [_int, _str]}, "target_ref": {"anyOf": [_int, _str]},
        "text": _str, "selector": _str, "selectors": _str_list,
        "script": _str, "modifiers": {"anyOf": [_str, _str_list]},
        "keys": _str_list, "key": _str, "include_content": _bool,
        "focus_popup": _bool, "event_type": _str,
        "x": {"type": "number"}, "y": {"type": "number"},
        "to_x": {"type": "number"}, "to_y": {"type": "number"},
        "offset_x": {"type": "number"}, "offset_y": {"type": "number"},
        "target_offset_x": {"type": "number"}, "target_offset_y": {"type": "number"},
        "delta_x": {"type": "number"}, "delta_y": {"type": "number"},
        "button": _str, "quality": _int, "full_page": _bool,
        "path": _str, "paths": _str_list, "value": _str,
        "values": _str_list, "checked": _bool, "width": _int,
        "height": _int, "calls": {"type": "array", "items": {"type": "object"}},
    }, ["action"]),
    "chatgpt_browser_image": _object({
        "prompt": _str, "action": {"type": "string", "enum": ["generate", "edit"]},
        "images": _str_list,
    }, ["prompt"]),
    "chatgpt_browser_media": _object({
        "text": _str, "files": {"type": "array", "items": {"type": "object"}},
        "local_paths": {"type": "array", "items": {"anyOf": [_str, {"type": "object"}]}},
        "file_path": _str, "path": _str, "action": _str,
    }),
    "document_query": _object({
        "document": {"anyOf": [_str, _str_list]}, "query": _str, "queries": _str_list,
    }, ["document"]),
    "office_artifact": _object({
        "action": _str, "kind": _str, "title": _str, "format": _str,
        "content": _str, "path": _str, "file_id": _str,
        "version_id": {"anyOf": [_int, _str]}, "operation": _str,
        "find": _str, "replace": _str, "sheet": _str,
        "cells": {}, "rows": {}, "chart": {}, "slides": {},
        "max_chars": {"anyOf": [_int, _str]},
        "open_in_canvas": _bool, "open_in_desktop": _bool,
    }, ["action"]),
    "parallel": _object({
        "tool_calls": {"type": "array", "items": {"type": "object"}},
        "calls": {"type": "array", "items": {"type": "object"}},
        "items": {"type": "array", "items": {"type": "object"}},
        "job_ids": {"anyOf": [_str, _str_list]}, "wait": _bool,
        "action": _str, "timeout": {"type": "number"},
    }),
    "scheduler": _object({
        "action": {"type": "string", "enum": [
            "list_tasks", "find_task_by_name", "show_task", "run_task",
            "delete_task", "update_task", "create_scheduled_task",
            "create_adhoc_task", "create_planned_task", "wait_for_task",
        ]},
        "uuid": _str, "name": _str, "prompt": _str,
        "system_prompt": _str, "attachments": _str_list,
        "dedicated_context": _bool, "context": _str,
        "state": {"anyOf": [_str, _str_list]},
        "type": _str_list, "next_run_within": _int, "next_run_after": _int,
        "schedule": {"anyOf": [_str, {"type": "object"}]},
        "timezone": _str, "plan": {"anyOf": [{"type": "array"}, {"type": "object"}]},
    }, ["action"]),
    "text_editor": _object({
        "action": {"type": "string", "enum": ["read", "write", "patch"]},
        "path": _str, "line_from": _int, "line_to": _int,
        "content": _str, "old_text": _str, "new_text": _str,
        "patch_text": _str, "edits": {"type": "array", "items": {"type": "object"}},
        "open_in_canvas": _bool,
    }, ["action", "path"]),
    "vscode": _object({
        "action": {"type": "string", "enum": ["open", "status", "terminal"]},
        "command": _str, "timeout": _int,
    }),
})


def chat_completion_tools(response_tools: Any) -> list[dict[str, Any]]:
    """Convert the framework's Responses descriptors to OpenAI tool records."""
    if not isinstance(response_tools, list):
        return []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in response_tools:
        if not isinstance(entry, dict) or entry.get("type") != "function":
            continue
        name = entry.get("name")
        parameters = SCHEMA_OVERRIDES.get(entry.get("name"), entry.get("parameters"))
        if not isinstance(name, str) or not name or name in seen:
            continue
        if not isinstance(parameters, dict) or parameters.get("type") != "object":
            continue
        seen.add(name)
        result.append({
            "type": "function",
            "function": {
                "name": name,
                "description": str(entry.get("description") or name),
                "parameters": parameters,
            },
        })
    return result


def configure_kimi_native_tools(call_data: dict[str, Any]) -> int:
    """Enable native calls on this Kimi model instance, never on Browser."""
    model = call_data.get("model")
    if "kimi-k3" not in str(getattr(model, "model_name", "")).casefold():
        return 0
    # Internal utility calls (document Q&A, summaries, compactors) use the
    # same model but are not Agent Zero action turns. They have no authorized
    # tool inventory at all and must remain ordinary text completions.
    if "a0_responses_function_tools" not in call_data:
        return 0
    tools = chat_completion_tools(call_data.get("a0_responses_function_tools"))
    if not tools:
        raise RuntimeError("Kimi native tools unavailable: empty authorized inventory")
    kwargs = getattr(model, "kwargs", None)
    if not isinstance(kwargs, dict):
        raise RuntimeError("Kimi native tools unavailable: model kwargs are not mutable")
    kwargs["tools"] = tools
    kwargs["tool_choice"] = "required"
    # Agent Zero's dispatcher is sequential. Use its explicit parallel tool
    # instead of allowing the provider to choose simultaneous native calls.
    kwargs["parallel_tool_calls"] = False
    return len(tools)
