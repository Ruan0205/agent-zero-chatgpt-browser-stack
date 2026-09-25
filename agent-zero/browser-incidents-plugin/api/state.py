"""Authenticated UI facade for incident reports and the isolated repair controller."""

import json
import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from helpers.api import ApiHandler, Request, Response


ROOT = Path(os.environ.get("BROWSER_INCIDENTS_DIR", "/a0/usr/browser-incidents"))
SETTINGS = ROOT / "settings.json"
INCIDENTS = ROOT / "incidents.json"
STATUS = ROOT / "status.json"
REPAIR_SESSIONS = ROOT / "repair-sessions.json"
SHARED_UID = int(os.environ.get("BROWSER_INCIDENTS_UID", "1000"))
SHARED_GID = int(os.environ.get("BROWSER_INCIDENTS_GID", "1000"))
CONTROLLER_URL = os.environ.get("REPAIR_CONTROLLER_URL", "http://repair-controller:8099/action")
CONTROLLER_TOKEN = os.environ.get("REPAIR_AGENT_API_TOKEN", "")


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
        "repair_sessions": _read(REPAIR_SESSIONS, {}),
        "repair_vnc_port": int(os.environ.get("REPAIR_VNC_PORT", "50087")),
        "counts": {
            "total": len(incidents),
            "open": sum(1 for item in incidents if not item.get("resolved")),
            "resolved": sum(1 for item in incidents if item.get("resolved")),
        },
    }


def _controller_action(action: str, input: dict):
    if not CONTROLLER_TOKEN:
        raise RuntimeError("Token do reparador não configurado")
    payload = {"action": action, "context_id": input.get("context_id", "")}
    if action == "diagnose_chat":
        payload["chat_name"] = input.get("chat_name", "")
        payload["interface_snapshot"] = input.get("interface_snapshot", {})
    elif action == "repair_message":
        payload["message"] = input.get("message", "")
    request = urllib.request.Request(
        CONTROLLER_URL, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST", headers={"Content-Type": "application/json", "X-Repair-Token": CONTROLLER_TOKEN},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Reparador recusou a ação ({error.code}): {details[:500]}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Reparador indisponível: {error.reason}") from error
    if not result.get("success"):
        raise RuntimeError(str(result.get("error") or "Ação recusada"))


class State(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict | Response:
        ROOT.mkdir(parents=True, exist_ok=True)
        action = str(input.get("action", "get"))
        if action == "get":
            return _snapshot()
        if action in {"diagnose_chat", "report_chat", "repair_message", "approve_repair",
                      "decline_repair", "resume_source"}:
            try:
                _controller_action("diagnose_chat" if action == "report_chat" else action, input)
            except (OSError, RuntimeError, ValueError) as error:
                return {"success": False, "error": str(error)}
            return _snapshot()
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
