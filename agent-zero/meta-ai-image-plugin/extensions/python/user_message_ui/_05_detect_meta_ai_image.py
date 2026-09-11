from __future__ import annotations

import re
import uuid
from typing import Any

from helpers.extension import Extension


STATE_KEY = "_meta_ai_image_request"
LAST_IMAGE_KEY = "meta_ai_last_image"

_IMAGE_NOUN = r"(?:imagem|imagens|foto|fotos|ilustra(?:ção|cao|ções|coes)|desenho|arte|image|images|picture|pictures|photo|photos|illustration|artwork)"
_CREATE_VERB = r"(?:cri(?:e|ar)|ger(?:e|ar)|faça|faca|produz(?:a|ir)|desenh(?:e|ar)|imagin(?:e|ar)|create|generate|make|draw|produce)"
_EDIT_VERB = r"(?:edit(?:e|ar)|modifi(?:que|car)|alter(?:e|ar)|transform(?:e|ar)|remov(?:a|er)|tir(?:e|ar)|apag(?:ue|ar)|adicione|adicionar|coloque|colocar|deixe|deixar|torne|tornar|troque|trocar|mude|mudar|retoc(?:ar|que)|edit|modify|change|transform|remove|delete|add|apply|replace|retouch)"
_PATTERNS = (
    re.compile(rf"\b{_CREATE_VERB}\b[\s\S]{{0,100}}\b{_IMAGE_NOUN}\b", re.IGNORECASE),
    re.compile(rf"\b(?:quero|preciso|gostaria de|i want|i need)\b[\s\S]{{0,80}}\b{_IMAGE_NOUN}\b", re.IGNORECASE),
    re.compile(rf"^\s*{_IMAGE_NOUN}\s+(?:de|do|da|dos|das|of)\b", re.IGNORECASE),
)
_NEGATIVE = re.compile(
    r"\b(?:analise|analisar|descreva|descrever|leia|ler|extraia|extrair|"
    r"analyze|describe|read|extract)\b[\s\S]{0,40}\b" + _IMAGE_NOUN + r"\b",
    re.IGNORECASE,
)
_EDIT_PATTERN = re.compile(rf"\b{_EDIT_VERB}\b[\s\S]{{0,140}}(?:\b{_IMAGE_NOUN}\b|\b(?:nela|nesta|nessa|isso|it|this)\b)", re.IGNORECASE)
_FOLLOWUP_EDIT_PATTERN = re.compile(
    rf"(?:\b(?:no lugar|em vez (?:de|do|da)|nessa imagem|nesta imagem|essa imagem|"
    rf"na imagem|nela|nele)\b|\b(?:{_EDIT_VERB})\b)",
    re.IGNORECASE,
)
_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def is_image_generation_request(message: str) -> bool:
    text = str(message or "").strip()
    if not text or len(text) > 12000:
        return False
    if _NEGATIVE.search(text) and not re.search(rf"\b(?:{_CREATE_VERB}|{_EDIT_VERB})\b", text, re.IGNORECASE):
        return False
    return bool(_EDIT_PATTERN.search(text)) or any(pattern.search(text) for pattern in _PATTERNS)


def _attachment_filename(value: Any) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""
    name = candidate.replace("\\", "/").rsplit("/", 1)[-1]
    if "." not in name or ("." + name.rsplit(".", 1)[-1].lower()) not in _IMAGE_EXTENSIONS:
        return ""
    return name


def _find_latest_image(agent: Any, current_paths: list[Any]) -> str:
    for value in reversed(current_paths):
        if name := _attachment_filename(value):
            return name
    try:
        messages = agent.history.output()
    except Exception:
        messages = []

    def collect(value: Any) -> list[str]:
        found: list[str] = []
        if isinstance(value, dict):
            attachments = value.get("attachments")
            if isinstance(attachments, list):
                found.extend(str(item) for item in attachments)
            for child in value.values():
                found.extend(collect(child))
        elif isinstance(value, list):
            for child in value:
                found.extend(collect(child))
        return found

    for message in reversed(messages):
        for value in reversed(collect(message.get("content"))):
            if name := _attachment_filename(value):
                return name
    try:
        if name := _attachment_filename(agent.get_data(LAST_IMAGE_KEY)):
            return name
    except Exception:
        pass
    return ""


class DetectMetaAiImageRequest(Extension):
    def execute(self, data: dict[str, Any] | None = None, **kwargs: Any) -> None:
        # Image intent is deliberately decided by the active LLM.  This hook
        # used to classify user text with broad regular expressions and then a
        # second hook replaced the LLM response with a forced tool call.  Words
        # such as "remova" in ordinary server work were therefore mistaken for
        # image edits.  Keep the helpers for backwards-compatible imports, but
        # never create deterministic routing state here.
        return

        if not self.agent or not isinstance(data, dict):
            return
        message = str(data.get("message") or "").strip()
        attachment_paths = data.get("attachment_paths")
        if not isinstance(attachment_paths, list):
            attachment_paths = []
        attached_image = _find_latest_image(self.agent, attachment_paths)
        is_edit = bool(_EDIT_PATTERN.search(message)) or bool(
            attached_image and _FOLLOWUP_EDIT_PATTERN.search(message)
        )
        if not is_edit and not is_image_generation_request(message):
            return
        self.agent.set_data(
            STATE_KEY,
            {
                "request_id": str(uuid.uuid4()),
                "prompt": message,
                "mode": "edit" if is_edit else "create",
                "source_filename": attached_image if is_edit else "",
            },
        )
