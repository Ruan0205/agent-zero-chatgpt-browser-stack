"""Usage totals with calendar-month buckets and cautious legacy attribution."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from .usage import _nonnegative_int, usage_month
except ImportError:  # standalone plugin unit tests
    from usage import _nonnegative_int, usage_month


BUCKETS = ("kimi", "browser", "other", "unattributed", "all")
MODEL_BUCKETS = ("kimi", "browser", "other")


def empty_usage() -> dict[str, Any]:
    return {"input": 0, "output": 0, "total": 0, "calls": 0, "estimated": False}


def _add(target: dict[str, Any], source: Any) -> None:
    if not isinstance(source, dict):
        return
    for key in ("input", "output", "calls"):
        target[key] += _nonnegative_int(source.get(key))
    target["total"] = target["input"] + target["output"]
    target["estimated"] = target["estimated"] or bool(source.get("estimated"))


def _subtract(source: Any, included: Any) -> dict[str, Any]:
    source = source if isinstance(source, dict) else {}
    included = included if isinstance(included, dict) else {}
    result = {key: max(0, _nonnegative_int(source.get(key)) - _nonnegative_int(included.get(key)))
              for key in ("input", "output", "calls")}
    result["total"] = result["input"] + result["output"]
    result["estimated"] = bool(source.get("estimated"))
    return result


def _model_hint(chat: dict[str, Any]) -> str:
    data = chat.get("data") or {}
    if not isinstance(data, dict):
        return ""
    lock = data.get("browser_model_lock") or {}
    override = data.get("chat_model_override") or {}
    chat_override = override.get("chat") if isinstance(override, dict) else {}
    names = [lock.get("model_name") if isinstance(lock, dict) else "",
             chat_override.get("name") if isinstance(chat_override, dict) else ""]
    if any("chatgpt-browser" in str(name).casefold() for name in names):
        return "browser"
    if any("kimi-k3" in str(name).casefold() for name in names):
        return "kimi"
    return ""


def _period(value: Any) -> str:
    value = str(value or "")
    return value[:7] if len(value) >= 7 and value[4] == "-" and value[:4].isdigit() and value[5:7].isdigit() else ""


def _attributed(totals: dict[str, dict[str, Any]], usage: Any, hint: str) -> int:
    """Add explicit model usage, then classify only the still-unattributed part."""
    if not isinstance(usage, dict):
        return 0
    _add(totals["all"], usage)
    by_model = usage.get("by_model")
    by_model = by_model if isinstance(by_model, dict) else {}
    for bucket in MODEL_BUCKETS:
        _add(totals[bucket], by_model.get(bucket))
    unknown = {
        key: max(0, _nonnegative_int(usage.get(key)) - sum(
            _nonnegative_int((by_model.get(bucket) or {}).get(key))
            for bucket in MODEL_BUCKETS if isinstance(by_model.get(bucket), dict)
        )) for key in ("input", "output", "calls")
    }
    unknown["estimated"] = True
    target = hint if hint in ("browser", "kimi") else "unattributed"
    _add(totals[target], unknown)
    return unknown["input"] + unknown["output"] if target != "unattributed" else 0


def _legacy_part(usage: dict[str, Any]) -> dict[str, Any]:
    months = usage.get("by_month")
    months = months if isinstance(months, dict) else {}
    included = empty_usage()
    included_models = {bucket: empty_usage() for bucket in MODEL_BUCKETS}
    for value in months.values():
        if not isinstance(value, dict):
            continue
        _add(included, value)
        by_model = value.get("by_model") or {}
        if isinstance(by_model, dict):
            for bucket in MODEL_BUCKETS:
                _add(included_models[bucket], by_model.get(bucket))
    legacy = _subtract(usage, included)
    lifetime_models = usage.get("by_model") or {}
    if isinstance(lifetime_models, dict):
        legacy["by_model"] = {
            bucket: _subtract(lifetime_models.get(bucket), included_models[bucket])
            for bucket in MODEL_BUCKETS
        }
    return legacy


def aggregate_usage(chats: dict[str, Any], month: str | None = None) -> dict[str, Any]:
    current_month = month or usage_month()
    lifetime = {key: empty_usage() for key in BUCKETS}
    monthly = {key: empty_usage() for key in BUCKETS}
    counted = inferred = 0
    first_month = ""
    for item in chats.values():
        record = item if isinstance(item, dict) else {}
        usage = record.get("usage", record)
        if not isinstance(usage, dict) or not usage:
            continue
        counted += 1
        hint = str(record.get("model_hint") or "")
        if not hint:
            explicit = usage.get("by_model") or {}
            if isinstance(explicit, dict) and len(explicit) == 1:
                sole = next(iter(explicit))
                hint = sole if sole in ("kimi", "browser") else ""
        inferred += _attributed(lifetime, usage, hint)
        created_month = _period(record.get("created_at"))
        if created_month and (not first_month or created_month < first_month):
            first_month = created_month
        by_month = usage.get("by_month") or {}
        if isinstance(by_month, dict):
            _attributed(monthly, by_month.get(current_month), "")
        legacy = _legacy_part(usage)
        # Pre-ledger counts cannot be split per call. For a chat created in the
        # selected month, classify its legacy subtotal as that month's estimate.
        if created_month == current_month:
            _attributed(monthly, legacy, hint)
    return {
        "buckets": lifetime,
        "monthly_buckets": monthly,
        "period": current_month,
        "tracked_since": first_month,
        "chats_counted": counted,
        "inferred_legacy_tokens": inferred,
    }


def read_saved_usage(chats_dir: Path) -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {}
    unreadable = 0
    for path in chats_dir.glob("*/chat.json"):
        try:
            with path.open(encoding="utf-8") as handle:
                chat = json.load(handle)
            result[str(chat.get("id") or path.parent.name)] = {
                "usage": (chat.get("output_data") or {}).get("chat_token_usage"),
                "created_at": chat.get("created_at"),
                "model_hint": _model_hint(chat),
            }
        except (OSError, UnicodeError, ValueError, TypeError):
            unreadable += 1
    return result, unreadable


def current_usage(chats_dir: Path, live_contexts=(), month: str | None = None) -> dict[str, Any]:
    chats, unreadable = read_saved_usage(chats_dir)
    for context in live_contexts:
        context_id = str(getattr(context, "id", "") or "")
        if not context_id:
            continue
        get_output = getattr(context, "get_output_data", None)
        if callable(get_output):
            live_usage = get_output("chat_token_usage")
            if isinstance(live_usage, dict):
                record = dict(chats.get(context_id) or {})
                record["usage"] = live_usage
                created_at = getattr(context, "created_at", None)
                if created_at and not record.get("created_at"):
                    record["created_at"] = created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at)
                if not record.get("model_hint"):
                    get_data = getattr(context, "get_data", None)
                    if callable(get_data):
                        lock = get_data("browser_model_lock") or {}
                        if isinstance(lock, dict) and "chatgpt-browser" in str(lock.get("model_name", "")).casefold():
                            record["model_hint"] = "browser"
                chats[context_id] = record
    result = aggregate_usage(chats, month)
    result["unreadable_chats"] = unreadable
    return result
