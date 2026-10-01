"""Keep the visible legacy greeting, but do not prime Kimi with JSON tool syntax."""

from __future__ import annotations

import re
from typing import Any


def neutralize_initial_greeting(messages: Any) -> Any:
    if not isinstance(messages, list):
        return messages
    projected = list(messages)
    for index, message in enumerate(projected[:6]):
        content = getattr(message, "content", None)
        role = getattr(message, "type", None)
        if (
            role == "ai" and isinstance(content, str)
            and "Greeting user and starting conversation" in content
            and re.search(r'"tool_name"\s*:\s*"response"', content)
        ):
            # This is the bundled fw.initial_message.md example, not a user
            # message. The UI greeting remains intact in persisted history.
            projected[index] = message.model_copy(update={
                "content": "The initial greeting was already delivered. For all new actions, use the native API functions supplied in this request."
            })
    return projected
