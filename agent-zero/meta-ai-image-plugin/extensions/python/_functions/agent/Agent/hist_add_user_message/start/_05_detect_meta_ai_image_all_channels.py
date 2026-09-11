from __future__ import annotations

import re
import uuid
from typing import Any

from helpers.extension import Extension
from plugins._meta_ai_image.extensions.python.user_message_ui._05_detect_meta_ai_image import (
    STATE_KEY,
    _EDIT_PATTERN,
    _EDIT_VERB,
    _find_latest_image,
    is_image_generation_request,
)


_WHATSAPP_ENVELOPE = re.compile(
    r"^\[WhatsApp from [^\]]+\]\s*\n\s*\n([\s\S]*)$",
    re.IGNORECASE,
)


class DetectMetaAiImageAllChannels(Extension):
    """Compatibility hook; image routing is now an LLM tool decision."""

    def execute(self, data: dict[str, Any] | None = None, **kwargs: Any) -> None:
        # Do not infer image intent before the model sees the request.
        return

        if not self.agent or not isinstance(data, dict):
            return
        args = data.get("args")
        if not isinstance(args, tuple) or len(args) < 2:
            return
        user_message = args[1]
        raw = str(getattr(user_message, "message", "") or "").strip()
        match = _WHATSAPP_ENVELOPE.match(raw)
        exact_prompt = (match.group(1) if match else raw).strip()
        attachments = getattr(user_message, "attachments", None)
        if not isinstance(attachments, list):
            attachments = []
        attached_image = _find_latest_image(self.agent, attachments) if attachments else ""
        is_edit = bool(_EDIT_PATTERN.search(exact_prompt)) or bool(
            attached_image and re.search(rf"\b{_EDIT_VERB}\b", exact_prompt, re.IGNORECASE)
        )
        if not is_edit and not is_image_generation_request(exact_prompt):
            return
        self.agent.set_data(
            STATE_KEY,
            {
                "request_id": str(uuid.uuid4()),
                "prompt": exact_prompt,
                "mode": "edit" if is_edit else "create",
                "source_filename": attached_image
                or (_find_latest_image(self.agent, []) if is_edit else ""),
            },
        )
