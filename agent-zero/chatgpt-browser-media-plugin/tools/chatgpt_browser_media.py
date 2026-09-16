from __future__ import annotations

import shutil
import uuid
import re
from pathlib import Path
from typing import Any

from helpers.tool import Response, Tool

OUTBOX = Path('/a0/usr/browser-media')
UPLOADS = Path('/a0/usr/uploads')
WORKSPACES = Path('/workspace/chats')
LOCAL_WORKDIR = Path('/a0/usr/workdir')
CONTEXT_RE = re.compile(r'^[A-Za-z0-9_-]{1,96}$')

def _name_parts(requested: str, fallback: str) -> tuple[str, str]:
    lower = requested.lower()
    suffix = '.tar.gz' if lower.endswith('.tar.gz') else (Path(requested).suffix or Path(fallback).suffix)
    raw_stem = requested[:-len(suffix)] if suffix and lower.endswith(suffix.lower()) else Path(requested).stem
    stem = ''.join(ch if ch.isalnum() or ch in '-_' else '-' for ch in raw_stem).strip('-')[:60] or 'chatgpt-file'
    return stem, suffix.lower()[:12]

class ChatgptBrowserMedia(Tool):
    async def after_execution(self, response: Response, **kwargs: Any) -> None:
        await super().after_execution(response, **kwargs)
        additional = response.additional or {}
        attachments = additional.get('attachments')
        if isinstance(attachments, list) and attachments:
            kvps = dict(self.log.kvps or {})
            kvps['attachments'] = attachments
            kvps['media_paths'] = additional.get('media_paths', [])
            kvps['vscode_paths'] = additional.get('vscode_paths', [])
            self.log.update(kvps=kvps)

    async def execute(
        self,
        text: str = 'Arquivos prontos.',
        files: list[dict[str, Any]] | None = None,
        local_paths: list[str | dict[str, Any]] | None = None,
        file_path: str | None = None,
        path: str | None = None,
        action: str | None = None,
        **kwargs: Any,
    ) -> Response:
        imported: list[str] = []
        paths: list[str] = []
        vscode_paths: list[str] = []
        UPLOADS.mkdir(parents=True, exist_ok=True)
        context_id = str(getattr(getattr(self.agent, 'context', None), 'id', '') or '').strip()
        workspace = WORKSPACES / context_id / 'chatgpt-files' if CONTEXT_RE.fullmatch(context_id) else None
        if workspace:
            workspace.mkdir(parents=True, exist_ok=True)
        for item in files or []:
            source = str(item.get('source') or '')
            if not source or Path(source).name != source:
                continue
            src = (OUTBOX / source).resolve()
            try:
                src.relative_to(OUTBOX.resolve())
            except ValueError:
                continue
            if not src.is_file():
                continue
            requested = Path(str(item.get('name') or source)).name
            stem, suffix = _name_parts(requested, source)
            name = f'{stem}-{uuid.uuid4().hex[:12]}{suffix}'
            dst = UPLOADS / name
            shutil.copy2(src, dst)
            imported.append(name)
            paths.append(str(dst))
            if workspace:
                workspace_dst = workspace / name
                shutil.copy2(src, workspace_dst)
                vscode_paths.append(str(workspace_dst))
        # Large artifacts created by Agent Zero's own execution tool should not
        # be round-tripped through ChatGPT as base64. Publish only files rooted
        # in Agent Zero's persistent workdir (or this chat's own workspace),
        # resolving symlinks first so a model cannot use this as an arbitrary
        # host-file exfiltration primitive.
        allowed_local_roots = [LOCAL_WORKDIR.resolve()]
        if workspace:
            allowed_local_roots.append(workspace.resolve())
        requested_local_paths = list(local_paths or [])
        # Normalize common, unambiguous upload aliases emitted by browser LLMs.
        # They still pass through the exact same allowlist and symlink checks
        # below; `action` never broadens access. File size is intentionally not
        # capped here: available storage and the surrounding transport are the
        # only practical limits.
        single_path = file_path or path
        if isinstance(single_path, str) and single_path.strip():
            requested_local_paths.append(single_path)
        for item in requested_local_paths:
            raw_path = item if isinstance(item, str) else item.get('path')
            requested_raw = None if isinstance(item, str) else item.get('name')
            if not isinstance(raw_path, str) or not raw_path.strip():
                continue
            src = Path(raw_path).resolve()
            if not any(src == root or root in src.parents for root in allowed_local_roots):
                continue
            if not src.is_file():
                continue
            requested = Path(str(requested_raw or src.name)).name
            stem, suffix = _name_parts(requested, src.name)
            name = f'{stem}-{uuid.uuid4().hex[:12]}{suffix}'
            dst = UPLOADS / name
            shutil.copy2(src, dst)
            imported.append(name)
            paths.append(str(dst))
            if workspace:
                workspace_dst = workspace / name
                shutil.copy2(src, workspace_dst)
                vscode_paths.append(str(workspace_dst))
        if not imported:
            return Response(message='O ChatGPT informou um arquivo, mas o bridge não conseguiu importá-lo.', break_loop=True)
        # A successful tool call must be followed by Agent Zero's normal
        # closing model turn. Ending the loop here leaves a dangling tool result;
        # the next human message would first close the previous media request
        # and could be incorrectly consumed without execution.
        return Response(message=str(text or 'Arquivos prontos.'), break_loop=False, additional={'attachments': imported, 'media_paths': paths, 'vscode_paths': vscode_paths})
