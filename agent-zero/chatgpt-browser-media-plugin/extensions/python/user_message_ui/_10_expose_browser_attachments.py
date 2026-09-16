from __future__ import annotations

import json
from typing import Any

from helpers.extension import Extension
from plugins._model_config.helpers import model_config


MARKER = "[A0_BROWSER_ATTACHMENTS_JSON]"


class ExposeBrowserAttachments(Extension):
    """Expose UI attachment paths only to the ChatGPT browser transport."""

    def execute(self, data: dict[str, Any] | None = None, **kwargs: Any) -> None:
        if not self.agent or not isinstance(data, dict):
            return
        config = model_config.get_chat_model_config(self.agent)
        if str(config.get("name") or "").strip() != "chatgpt-browser":
            return
        paths = data.get("attachment_paths")
        if not isinstance(paths, list):
            return
        clean = [
            str(path).strip()
            for path in paths
            if isinstance(path, str)
            and str(path).strip().startswith(
                ("/a0/usr/uploads/", "/a0/usr/chats/", "/a0/usr/whatsapp/media/", "/workspace/")
            )
        ]
        if not clean:
            return
        message = str(data.get("message") or "")
        if MARKER in message:
            return
        data["message"] = (
            message.rstrip()
            + "\n"
            + MARKER
            + json.dumps(clean, ensure_ascii=False, separators=(",", ":"))
        )
