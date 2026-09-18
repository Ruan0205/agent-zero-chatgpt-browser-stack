import json
import os
import re
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from helpers.api import ApiHandler, Request, Response


ROOT = Path(os.environ.get("BROWSER_INCIDENTS_DIR", "/a0/usr/browser-incidents"))
SETTINGS = ROOT / "settings.json"
INCIDENTS = ROOT / "incidents.json"
STATUS = ROOT / "status.json"
SHARED_UID = int(os.environ.get("BROWSER_INCIDENTS_UID", "1000"))
SHARED_GID = int(os.environ.get("BROWSER_INCIDENTS_GID", "1000"))
AUDIT_URL = os.environ.get("BROWSER_AUDIT_URL", "http://chatgpt-browser-agent:8000/v1/audit-chat")
AUDIT_TOKEN = os.environ.get("BROWSER_POOL_NOTICE_TOKEN", "")
CHATS_ROOT = Path(os.environ.get("A0_CHATS_DIR", "/a0/usr/chats"))


def _read(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return fallback


def _write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o770)
    os.chown(path.parent, SHARED_UID, SHARED_GID)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o660)
        os.chown(path, SHARED_UID, SHARED_GID)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _snapshot():
    settings = _read(SETTINGS, {"enabled": True})
    incidents = _read(INCIDENTS, [])
    status = _read(STATUS, {"active": False, "queued": 0})
    if not isinstance(incidents, list):
        incidents = []
    incidents.sort(key=lambda item: str(item.get("createdAt", "")), reverse=True)
    return {
        "success": True,
        "enabled": settings.get("enabled") is not False,
        "incidents": incidents,
        "status": status,
        "counts": {
            "total": len(incidents),
            "open": sum(1 for item in incidents if not item.get("resolved")),
            "resolved": sum(1 for item in incidents if item.get("resolved")),
        },
    }


def _request_manual_audit(input: dict) -> None:
    context_id = str(input.get("context_id", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", context_id):
        raise ValueError("Chat atual inválido ou ausente.")
    if not AUDIT_TOKEN:
        raise RuntimeError("Token interno da auditoria não configurado.")
    interface_snapshot = input.get("interface_snapshot", {})
    source_chat = CHATS_ROOT / context_id / "chat.json"
    if not source_chat.is_file():
        raise ValueError("O histórico completo do chat não foi encontrado.")
    inputs_dir = ROOT / "audit-inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(inputs_dir, 0o770)
    os.chown(inputs_dir, SHARED_UID, SHARED_GID)
    audit_input = inputs_dir / f"audit-context-{uuid.uuid4()}.json"
    temporary = inputs_dir / f".{audit_input.name}.tmp"
    try:
        with source_chat.open("rb") as source, temporary.open("wb") as target:
            target.write(b'{"chat_history":')
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
            target.write(b',"interface_snapshot":')
            target.write(json.dumps(interface_snapshot, ensure_ascii=False).encode("utf-8"))
            target.write(b"}")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, audit_input)
        os.chmod(audit_input, 0o660)
        os.chown(audit_input, SHARED_UID, SHARED_GID)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    encoded = json.dumps(
        {
            "context_id": context_id,
            "chat_name": str(input.get("chat_name", context_id))[:300],
            "audit_input": audit_input.name,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        AUDIT_URL,
        data=encoded,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Browser-Pool-Token": AUDIT_TOKEN,
        },
    )
    accepted = False
    try:
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"O auditor recusou a solicitação ({error.code}): {detail[:500]}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"O auditor está indisponível: {error.reason}") from error
        if not result.get("success"):
            raise RuntimeError(str(result.get("error") or "A auditoria não foi enfileirada."))
        accepted = True
    finally:
        if not accepted:
            audit_input.unlink(missing_ok=True)


class State(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict | Response:
        ROOT.mkdir(parents=True, exist_ok=True)
        os.chmod(ROOT, 0o770)
        os.chown(ROOT, SHARED_UID, SHARED_GID)
        action = str(input.get("action", "get"))
        if action == "get":
            return _snapshot()
        if action == "report_chat":
            try:
                _request_manual_audit(input)
            except (OSError, ValueError, RuntimeError) as error:
                return {"success": False, "error": str(error)}
            snapshot = _snapshot()
            snapshot["message"] = "O chat completo foi enviado para análise."
            return snapshot
        if action == "set_enabled":
            _write(SETTINGS, {"enabled": bool(input.get("enabled", True))})
            return _snapshot()
        if action == "resolve":
            incident_id = str(input.get("id", ""))
            incidents = _read(INCIDENTS, [])
            found = False
            for incident in incidents if isinstance(incidents, list) else []:
                if str(incident.get("id", "")) == incident_id:
                    incident["resolved"] = bool(input.get("resolved", True))
                    found = True
                    break
            if not found:
                return {"success": False, "error": "Incidente não encontrado."}
            _write(INCIDENTS, incidents)
            return _snapshot()
        if action == "clear_resolved":
            incidents = _read(INCIDENTS, [])
            remaining = [item for item in incidents if not item.get("resolved")]
            _write(INCIDENTS, remaining)
            if not remaining:
                status = _read(STATUS, {"active": False, "queued": 0})
                if not status.get("active") and not status.get("queued"):
                    status.update({"lastOutcome": None, "lastError": None, "lastAuditAt": None})
                    _write(STATUS, status)
            return _snapshot()
        if action == "clear_all":
            _write(INCIDENTS, [])
            return _snapshot()
        if action == "remove":
            incident_id = str(input.get("id", ""))
            if not incident_id:
                return {"success": False, "error": "ID do relatório ausente."}
            incidents = _read(INCIDENTS, [])
            if not isinstance(incidents, list):
                incidents = []
            remaining = [item for item in incidents if str(item.get("id", "")) != incident_id]
            if len(remaining) == len(incidents):
                return {"success": False, "error": "Relatório não encontrado."}
            _write(INCIDENTS, remaining)
            return _snapshot()
        return {"success": False, "error": f"Ação desconhecida: {action}"}
