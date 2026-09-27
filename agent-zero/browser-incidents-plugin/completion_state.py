"""Per-chat final-reply receipts for the sidebar's unread indicator."""

import json
import hashlib
import os
import re
import tempfile
import uuid
from pathlib import Path


ROOT = Path(os.environ.get("BROWSER_INCIDENTS_DIR", "/a0/usr/browser-incidents")) / "completed-chats"
VALID_ID = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")


def _path(chat_id: str, suffix: str) -> Path:
    if not VALID_ID.fullmatch(str(chat_id)):
        raise ValueError("ID de chat inválido")
    return ROOT / f"{chat_id}.{suffix}.json"


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".completion-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def completed(chat_id: str, log_no: object, content: str) -> None:
    fingerprint = f"{log_no}:{hashlib.sha256(content.encode('utf-8')).hexdigest()}"
    path = _path(chat_id, "done")
    if _read(path).get("fingerprint") == fingerprint:
        return
    _write(path, {"receipt": uuid.uuid4().hex, "fingerprint": fingerprint})


def mark_read(chat_id: str) -> None:
    receipt = _read(_path(chat_id, "done")).get("receipt")
    if receipt:
        _write(_path(chat_id, "read"), {"receipt": receipt})


def unread() -> list[str]:
    if not ROOT.is_dir():
        return []
    result = []
    for done in ROOT.glob("*.done.json"):
        chat_id = done.name[:-len(".done.json")]
        if not VALID_ID.fullmatch(chat_id):
            continue
        receipt = _read(done).get("receipt")
        if receipt and receipt != _read(_path(chat_id, "read")).get("receipt"):
            result.append(chat_id)
    return result
