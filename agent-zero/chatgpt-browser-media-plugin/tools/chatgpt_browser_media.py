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
CHAT_DATA = Path('/a0/usr/chats')
LOCAL_WORKDIR = Path('/a0/usr/workdir')
CONTEXT_RE = re.compile(r'^[A-Za-z0-9_-]{1,96}$')

def _allowed_local_roots(context_id: str) -> list[Path]:
    roots = [LOCAL_WORKDIR.resolve()]
    if CONTEXT_RE.fullmatch(context_id):
        chat_dir = WORKSPACES / context_id
        roots.extend((
            (chat_dir / 'chatgpt-files').resolve(),
            (chat_dir / 'images').resolve(),
            (CHAT_DATA / context_id / 'images').resolve(),
        ))
    return roots

def _allowed_local_file(path: str, roots: list[Path]) -> Path | None:
    try:
        src = Path(path).resolve()
    except (OSError, RuntimeError):
        return None
    if not src.is_file() or not any(src == root or root in src.parents for root in roots):
        return None
    return src

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
        failures: list[str] = []
        try:
            UPLOADS.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return Response(message=f'Falha recuperável: pasta de mídia indisponível ({type(exc).__name__}). Verifique o armazenamento antes de tentar novamente.', break_loop=False)
        context_id = str(getattr(getattr(self.agent, 'context', None), 'id', '') or '').strip()
        workspace = WORKSPACES / context_id / 'chatgpt-files' if CONTEXT_RE.fullmatch(context_id) else None
        if workspace:
            try:
                workspace.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                failures.append(f'Pasta do VS Code indisponível: {type(exc).__name__}.')
                workspace = None
        for item in files or []:
            if not isinstance(item, dict):
                failures.append('Referência do arquivo do navegador inválida.')
                continue
            source = str(item.get('source') or '')
            if not source or Path(source).name != source:
                failures.append('Nome do arquivo do navegador inválido.')
                continue
            try:
                src = (OUTBOX / source).resolve()
            except (OSError, RuntimeError):
                failures.append(f'Arquivo do navegador com caminho inválido: {source}.')
                continue
            try:
                src.relative_to(OUTBOX.resolve())
            except ValueError:
                failures.append('Arquivo do navegador fora da pasta permitida.')
                continue
            if not src.is_file():
                failures.append(f'Arquivo do navegador não encontrado: {source}.')
                continue
            requested = Path(str(item.get('name') or source)).name
            stem, suffix = _name_parts(requested, source)
            name = f'{stem}-{uuid.uuid4().hex[:12]}{suffix}'
            dst = UPLOADS / name
            try:
                shutil.copy2(src, dst)
            except OSError as exc:
                failures.append(f'Falha ao copiar {source}: {type(exc).__name__}.')
                continue
            imported.append(name)
            paths.append(str(dst))
            if workspace:
                workspace_dst = workspace / name
                try:
                    shutil.copy2(src, workspace_dst)
                    vscode_paths.append(str(workspace_dst))
                except OSError as exc:
                    failures.append(f'Arquivo {source} publicado no chat, mas não copiado ao VS Code: {type(exc).__name__}.')
        # Large artifacts created by Agent Zero's own execution tool should not
        # be round-tripped through ChatGPT as base64. Publish only files rooted
        # in Agent Zero's persistent workdir (or this chat's own workspace),
        # resolving symlinks first so a model cannot use this as an arbitrary
        # host-file exfiltration primitive. Screenshots captured by this chat's
        # execution tools are stored in its images directory, so include only
        # that same-chat directory as another permitted source.
        allowed_local_roots = _allowed_local_roots(context_id)
        requested_local_paths = list(local_paths) if isinstance(local_paths, list) else ([local_paths] if local_paths else [])
        # Normalize common, unambiguous upload aliases emitted by browser LLMs.
        # They still pass through the exact same allowlist and symlink checks
        # below; `action` never broadens access. File size is intentionally not
        # capped here: available storage and the surrounding transport are the
        # only practical limits.
        single_path = file_path or path
        if isinstance(single_path, str) and single_path.strip():
            requested_local_paths.append(single_path)
        for item in requested_local_paths:
            if not isinstance(item, (str, dict)):
                failures.append('Referência local inválida.')
                continue
            raw_path = item if isinstance(item, str) else item.get('path')
            requested_raw = None if isinstance(item, str) else item.get('name')
            if not isinstance(raw_path, str) or not raw_path.strip():
                failures.append('Caminho local vazio ou inválido.')
                continue
            src = _allowed_local_file(raw_path, allowed_local_roots)
            if src is None:
                failures.append(f'Arquivo local indisponível ou fora deste chat: {raw_path}.')
                continue
            requested = Path(str(requested_raw or src.name)).name
            stem, suffix = _name_parts(requested, src.name)
            name = f'{stem}-{uuid.uuid4().hex[:12]}{suffix}'
            dst = UPLOADS / name
            try:
                shutil.copy2(src, dst)
            except OSError as exc:
                failures.append(f'Falha ao copiar arquivo local: {type(exc).__name__}.')
                continue
            imported.append(name)
            paths.append(str(dst))
            if workspace:
                workspace_dst = workspace / name
                try:
                    shutil.copy2(src, workspace_dst)
                    vscode_paths.append(str(workspace_dst))
                except OSError as exc:
                    failures.append(f'Arquivo publicado no chat, mas não copiado ao VS Code: {type(exc).__name__}.')
        if not imported:
            detail = ' '.join(failures[:3]) or 'Nenhum arquivo ou caminho foi informado.'
            return Response(
                message=(
                    f'Falha recuperável ao publicar mídia: {detail} '
                    'Confira o caminho e a existência do arquivo; não repita a mesma chamada sem mudar algo. '
                    'Se o arquivo estiver indisponível, informe a limitação e continue as partes da tarefa que não dependem dele.'
                ),
                break_loop=False,
            )
        # A successful tool call must be followed by Agent Zero's normal
        # closing model turn. Ending the loop here leaves a dangling tool result;
        # the next human message would first close the previous media request
        # and could be incorrectly consumed without execution.
        message = str(text or 'Arquivos prontos.')
        if failures:
            message += ' Publicação parcial: ' + ' '.join(failures[:3])
        return Response(message=message, break_loop=False, additional={'attachments': imported, 'media_paths': paths, 'vscode_paths': vscode_paths})
