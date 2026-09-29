"""Embed user-uploaded images in native vision-model turns.

The ordinary Agent Zero user template exposes attachment *paths* as JSON. A
vision-capable native model cannot see the pixels from those paths alone. Keep
the paths in persisted history and let the model transport expand them to data
URLs only while preparing the request.
"""

import json
import mimetypes
import hashlib
import os
from pathlib import Path

from PIL import Image

from helpers.extension import Extension
from plugins._model_config.helpers import model_config


UPLOADS = Path("/a0/usr/uploads").resolve()
CACHE = UPLOADS / ".native-vision-cache"


def _provider_image_path(path: Path) -> Path:
    """Keep the original; cache a high-quality JPEG for unusually large PNGs."""
    if path.suffix.lower() != ".png" or path.stat().st_size <= 512_000:
        return path
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    destination = CACHE / f"{digest}-q88.jpg"
    if destination.is_file():
        return destination
    try:
        CACHE.mkdir(mode=0o700, exist_ok=True)
        temporary = CACHE / f".{digest}-{os.getpid()}.jpg"
        with Image.open(path) as source:
            if source.mode in ("RGBA", "LA"):
                background = Image.new("RGB", source.size, "white")
                background.paste(source, mask=source.getchannel("A"))
                image = background
            else:
                image = source.convert("RGB")
            image.save(temporary, format="JPEG", quality=88, optimize=True)
        if temporary.stat().st_size >= path.stat().st_size:
            temporary.unlink(missing_ok=True)
            return path
        os.replace(temporary, destination)
        destination.chmod(0o600)
        return destination
    except (OSError, ValueError):
        return path


def image_parts(content, chat_config):
    if not isinstance(content, dict) or not chat_config.get("vision"):
        return None
    if "chatgpt-browser" in str(chat_config.get("name") or ""):
        return None
    attachments = content.get("attachments")
    if not isinstance(attachments, list):
        return None

    maximum = int(chat_config.get("max_embeds") or 10)
    parts = []
    seen = set()
    for value in attachments:
        if not isinstance(value, str):
            continue
        path = Path(value).resolve()
        if path in seen or not path.is_relative_to(UPLOADS):
            continue
        seen.add(path)
        if not path.is_file() or not (mimetypes.guess_type(path.name)[0] or "").startswith("image/"):
            continue
        parts.append({"type": "image_url", "image_url": {"url": str(_provider_image_path(path))}})
        if maximum > 0 and len(parts) >= maximum:
            break
    if not parts:
        return None
    preview = json.dumps(content, ensure_ascii=False, separators=(",", ":"))
    return {"preview": preview, "raw_content": [{"type": "text", "text": preview}, *parts]}


class NativeImageAttachments(Extension):
    def execute(self, **kwargs):
        if kwargs.get("ai") or not self.agent:
            return
        content_data = kwargs.get("content_data")
        if not isinstance(content_data, dict):
            return
        config = model_config.get_chat_model_config(self.agent)
        converted = image_parts(content_data.get("content"), config)
        if converted:
            content_data["content"] = converted
