"""Disk-backed image references for this installation's ChatGPT Browser route."""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import shutil
import uuid
from pathlib import Path
from urllib.parse import unquote, urlparse


UPLOADS = Path("/a0/usr/uploads")
SHARED = (UPLOADS, Path("/a0/usr/chats"), Path("/a0/usr/whatsapp/media"))
STAGEABLE = (Path("/a0/usr/workdir"), Path("/workspace"))


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _stage(path: Path) -> Path:
    if any(_within(path, root) for root in SHARED):
        return path
    info = path.stat()
    fingerprint = hashlib.sha256(
        f"{path}:{info.st_size}:{info.st_mtime_ns}".encode()
    ).hexdigest()[:32]
    UPLOADS.mkdir(parents=True, exist_ok=True)
    target = UPLOADS / f"browser-ref-{fingerprint}{path.suffix}"
    if target.is_file() and target.stat().st_size == info.st_size:
        return target
    try:
        os.link(path, target)
    except FileExistsError:
        return target
    except OSError:
        temporary = UPLOADS / f".browser-ref-{uuid.uuid4().hex}.partial"
        try:
            shutil.copyfile(path, temporary)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return target


def _save_data_url(url: str) -> Path | None:
    header, separator, encoded = url.partition(",")
    if not separator or not header.startswith("data:image/") or ";base64" not in header:
        return None
    mime = header[5:].split(";", 1)[0]
    suffix = mimetypes.guess_extension(mime) or ".img"
    UPLOADS.mkdir(parents=True, exist_ok=True)
    target = UPLOADS / f"browser-inline-{uuid.uuid4().hex}{suffix}"
    try:
        with target.open("wb") as output:
            for start in range(0, len(encoded), 4 * 1024 * 1024):
                output.write(base64.b64decode(encoded[start : start + 4 * 1024 * 1024], validate=True))
        return target
    except Exception:
        target.unlink(missing_ok=True)
        raise


def _file_path(url: str) -> Path | None:
    if url.startswith("data:"):
        return _save_data_url(url)
    raw = unquote(urlparse(url).path) if url.startswith("file://") else url
    if not raw.startswith(("/a0/usr/", "/workspace/")):
        return None
    path = Path(raw).resolve()
    if not path.is_file() or not any(_within(path, root) for root in SHARED + STAGEABLE):
        return None
    return _stage(path)


def replace_images(content: object) -> object:
    if not isinstance(content, list):
        return content
    output: list[object] = []
    changed = False
    for item in content:
        if not isinstance(item, dict) or item.get("type") not in {"image_url", "input_image"}:
            output.append(item)
            continue
        image_url = item.get("image_url") or item.get("url")
        url = image_url.get("url") if isinstance(image_url, dict) else image_url
        path = _file_path(url) if isinstance(url, str) else None
        if path is None:
            output.append(item)
            continue
        changed = True
        value = str(path)
        output.append({
            "type": "text",
            "text": f"[A0_BROWSER_ATTACHMENTS_JSON] {json.dumps([value])}\n[Attached image file: {value}]",
        })
    return output if changed else content


def replace_messages(messages: list) -> list:
    updated = []
    for message in messages:
        old_content = getattr(message, "content", None)
        new_content = replace_images(old_content)
        updated.append(message.model_copy(update={"content": new_content})
                       if new_content is not old_content else message)
    return updated
