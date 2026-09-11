from __future__ import annotations

import json
from typing import Any

from helpers.extension import Extension
from helpers.llm_result import LLMResult


STATE_KEY = "_meta_ai_image_request"


class RouteMetaAiImageRequest(Extension):
    def execute(self, data: dict[str, Any] | None = None, **kwargs: Any) -> None:
        # Never replace the active model's answer with a fabricated image tool
        # call.  The model receives the documented meta_ai_image tool and alone
        # decides whether the current request requires it.
        return

        if not self.agent or not isinstance(data, dict):
            return
        request = self.agent.get_data(STATE_KEY)
        if not isinstance(request, dict):
            return
        prompt = str(request.get("prompt") or "").strip()
        request_id = str(request.get("request_id") or "").strip()
        source_filename = str(request.get("source_filename") or "").strip()
        mode = str(request.get("mode") or "create").strip()
        if not prompt or not request_id:
            self.agent.set_data(STATE_KEY, None)
            return
        response = json.dumps(
            {
                "thoughts": ["A solicitação de imagem será roteada deterministicamente para a Meta AI pelo WhatsApp."],
                "headline": "Gerando imagem pela Meta AI",
                "tool_name": "meta_ai_image",
                "tool_args": {
                    "prompt": prompt,
                    "request_id": request_id,
                    "mode": mode,
                    "source_filename": source_filename,
                },
            },
            ensure_ascii=False,
        )
        data["result"] = LLMResult(response=response, mode="chat", state="local")
