"""Verify a current-chat artifact without trusting the model's description."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import zipfile
from pathlib import Path

from helpers.tool import Response, Tool


CHAT_ID = re.compile(r"^[A-Za-z0-9_-]{1,96}$")


def _inspect_file(path: Path, deep: bool) -> dict:
    size = path.stat().st_size
    report = {"exists": True, "size_bytes": size, "format": path.suffix.lower(), "openable": False}
    with path.open("rb") as stream:
        head = stream.read(16)
    suffix = path.suffix.lower()
    try:
        if suffix == ".png":
            if head[:8] != b"\x89PNG\r\n\x1a\n":
                raise ValueError("Invalid PNG signature")
            from PIL import Image

            with Image.open(path) as image:
                image.verify()
            report["openable"] = True
        elif suffix in {".jpg", ".jpeg", ".webp", ".gif"}:
            from PIL import Image

            with Image.open(path) as image:
                image.verify()
            report["openable"] = True
        elif suffix == ".pdf":
            if not head.startswith(b"%PDF-"):
                raise ValueError("Invalid PDF signature")
            try:
                from pypdf import PdfReader

                report["pages"] = len(PdfReader(str(path)).pages)
            except ImportError:
                with path.open("rb") as stream:
                    stream.seek(max(0, size - 2048))
                    if b"%%EOF" not in stream.read():
                        raise ValueError("PDF EOF marker missing")
            report["openable"] = True
        elif suffix == ".zip":
            with zipfile.ZipFile(path) as archive:
                report["entries"] = len(archive.infolist())
                if deep:
                    bad = archive.testzip()
                    if bad:
                        raise ValueError(f"ZIP entry failed CRC: {bad}")
            report["openable"] = True
        else:
            with path.open("rb") as stream:
                stream.read(1)
            report["openable"] = True
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                digest.update(chunk)
        report["sha256"] = digest.hexdigest()
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
    return report


class ArtifactVerify(Tool):
    async def execute(self, path: str = "", deep: bool = False, require_published: bool = False, **_kwargs) -> Response:
        context_id = str(self.agent.context.id)
        if not CHAT_ID.fullmatch(context_id):
            return Response(message="Invalid chat ID.", break_loop=False)
        allowed = [
            (Path("/workspace/chats") / context_id).resolve(),
            (Path("/a0/usr/chats") / context_id).resolve(),
            Path("/a0/usr/uploads").resolve(),
            Path("/a0/usr/workdir").resolve(),
        ]
        try:
            target = Path(path).resolve(strict=True)
        except (OSError, RuntimeError):
            return Response(message=json.dumps({"path": path, "exists": False}), break_loop=False)
        if not target.is_file() or not any(root in target.parents for root in allowed):
            return Response(message="Artifact must be a file under the current chat, uploads, or workdir.", break_loop=False)
        report = await asyncio.to_thread(_inspect_file, target, bool(deep))
        report["path"] = str(target)
        published = False
        for item in self.agent.context.log.logs:
            if item.type == "user":
                continue
            values = item.kvps or {}
            attachments = values.get("attachments") or []
            media_paths = values.get("media_paths") or []
            for value in [*attachments, *media_paths]:
                if isinstance(value, str) and (value == str(target) or value == target.name):
                    published = True
                elif isinstance(value, dict) and any(str(v) in {str(target), target.name} for v in value.values()):
                    published = True
        report["published_in_chat"] = published
        report["verified"] = report["openable"] and (published or not require_published)
        if require_published and not published:
            report["publication_note"] = "No attachment record found in this chat; do not claim delivery."
        return Response(message=json.dumps(report, ensure_ascii=False), break_loop=False)
