from __future__ import annotations

import asyncio
import json
import shutil
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from helpers.tool import Response, Tool


STATE_KEY = "_meta_ai_image_request"
LAST_IMAGE_KEY = "meta_ai_last_image"
META_AI_BRIDGE = "http://meta-ai-whatsapp:8788"
UPLOAD_DIR = Path("/a0/usr/uploads")
ALLOWED_SOURCE_DIRS = (
    UPLOAD_DIR,
    Path("/a0/usr/whatsapp/media"),
    Path("/a0/usr/workdir"),
)
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
_REQUEST_LOCK = asyncio.Lock()


def _latest_user_prompt(agent: Any) -> str:
    """Read the unmodified text stored for the current user turn."""
    message = getattr(agent, "last_user_message", None)
    content = getattr(message, "content", None)
    if isinstance(content, dict):
        value = content.get("user_message")
        if isinstance(value, str):
            return value
    return ""


def _generate(prompt: str, source_filename: str = "") -> tuple[int, dict[str, Any]]:
    body = json.dumps(
        {"prompt": prompt, "source_filename": source_filename},
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        META_AI_BRIDGE + "/v1/images/generations",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=330) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = {"error": raw or str(exc)}
        return exc.code, parsed


def _prepare_source(value: str) -> tuple[str, str]:
    """Return a bridge-visible basename after validating/copying an input image."""
    raw = str(value or "").strip()
    if not raw:
        return "", ""

    candidate = Path(raw)
    if candidate.suffix.lower() not in IMAGE_EXTENSIONS:
        return "", "O formato da imagem de origem não é compatível."

    if candidate.is_absolute():
        resolved = candidate.resolve()
        allowed = False
        for root in ALLOWED_SOURCE_DIRS:
            try:
                resolved.relative_to(root.resolve())
                allowed = True
                break
            except ValueError:
                continue
        if not allowed:
            return "", "O caminho da imagem de origem não é permitido."
    else:
        if candidate.name != raw:
            return "", "O nome da imagem de origem é inválido."
        resolved = next(
            (
                (root / candidate.name).resolve()
                for root in ALLOWED_SOURCE_DIRS
                if (root / candidate.name).is_file()
            ),
            Path(),
        )

    if not resolved.is_file():
        return "", "A imagem de origem não foi encontrada no armazenamento do Agent Zero."

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    try:
        resolved.relative_to(UPLOAD_DIR.resolve())
        return resolved.name, ""
    except ValueError:
        bridge_name = f"meta-source-{uuid.uuid4().hex[:20]}{resolved.suffix.lower()}"
        shutil.copy2(resolved, UPLOAD_DIR / bridge_name)
        return bridge_name, ""


class MetaAiImage(Tool):
    async def after_execution(self, response: Response, **kwargs: Any) -> None:
        """Persist generated media on the visible tool log as WebUI attachments."""
        await super().after_execution(response, **kwargs)
        additional = response.additional or {}
        attachments = additional.get("attachments")
        if isinstance(attachments, list) and attachments:
            kvps = dict(self.log.kvps or {})
            kvps["attachments"] = attachments
            media_paths = additional.get("media_paths")
            if isinstance(media_paths, list) and media_paths:
                kvps["media_paths"] = media_paths
            self.log.update(kvps=kvps)

    async def execute(
        self,
        prompt: str = "",
        request_id: str = "",
        mode: str = "create",
        source_filename: str = "",
        **kwargs: Any,
    ) -> Response:
        prompt = str(prompt or "")
        request_id = str(request_id or "").strip()
        pending = self.agent.get_data(STATE_KEY)

        # The model may call this tool directly and invent/rewrite arguments.
        # Never trust its prompt rewrite: use the exact current user message.
        # A request id is intentionally not required because the only possible
        # destination is the server-side, hard-coded Meta AI chat.
        original_prompt = _latest_user_prompt(self.agent)
        self.agent.set_data(STATE_KEY, None)

        if isinstance(pending, dict):
            prompt = str(pending.get("prompt") or original_prompt or prompt)
            mode = str(pending.get("mode") or mode or "create")
            source_filename = str(pending.get("source_filename") or source_filename or "").strip()
        else:
            prompt = original_prompt or prompt
        if not prompt.strip():
            return Response(message="Não recebi uma descrição para gerar a imagem.", break_loop=True)
        mode = str(mode or "create").strip().lower()
        source_filename = str(source_filename or "").strip()
        if mode == "edit" and not source_filename:
            source_filename = str(self.agent.get_data(LAST_IMAGE_KEY) or "").strip()
        if mode == "edit" and not source_filename:
            return Response(
                message="Para editar uma imagem, anexe a imagem ao pedido ou responda logo após uma imagem já exibida no chat.",
                break_loop=True,
            )
        if source_filename:
            source_filename, source_error = _prepare_source(source_filename)
            if source_error:
                return Response(message=source_error, break_loop=True)

        async with _REQUEST_LOCK:
            await self.set_progress("Enviando a descrição ao chat oficial da Meta AI pelo WhatsApp e aguardando a imagem…")
            status, result = await asyncio.to_thread(_generate, prompt[:3500], source_filename)
            if status != 200:
                return Response(
                    message=f"A Meta AI não concluiu a imagem: {result.get('error', 'erro desconhecido')}",
                    break_loop=True,
                )

            filename = str(result.get("filename") or "")
            if not filename or Path(filename).name != filename:
                return Response(message="A Meta AI retornou um nome de arquivo inválido.", break_loop=True)
            image = (UPLOAD_DIR / filename).resolve()
            try:
                image.relative_to(UPLOAD_DIR.resolve())
            except ValueError:
                return Response(message="A Meta AI retornou um caminho de arquivo inválido.", break_loop=True)
            if not image.is_file():
                return Response(message="A imagem foi gerada, mas não foi encontrada no armazenamento do Agent Zero.", break_loop=True)

            # Keep the most recent result as the implicit source for a natural
            # follow-up such as "faça uma mulher no lugar". The original user
            # prompt is forwarded unchanged as the image caption by the bridge.
            self.agent.set_data(LAST_IMAGE_KEY, filename)
            return Response(
                message="Imagem pronta.",
                break_loop=True,
                additional={
                    "attachments": [filename],
                    "media_paths": [str(image)],
                },
            )
