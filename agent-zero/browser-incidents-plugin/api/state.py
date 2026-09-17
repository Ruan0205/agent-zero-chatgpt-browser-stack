import json
import os
import tempfile
from pathlib import Path

from helpers.api import ApiHandler, Request, Response


ROOT = Path(os.environ.get("BROWSER_INCIDENTS_DIR", "/a0/usr/browser-incidents"))
SETTINGS = ROOT / "settings.json"
INCIDENTS = ROOT / "incidents.json"
STATUS = ROOT / "status.json"
SHARED_UID = int(os.environ.get("BROWSER_INCIDENTS_UID", "1000"))
SHARED_GID = int(os.environ.get("BROWSER_INCIDENTS_GID", "1000"))


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


class State(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict | Response:
        ROOT.mkdir(parents=True, exist_ok=True)
        os.chmod(ROOT, 0o770)
        os.chown(ROOT, SHARED_UID, SHARED_GID)
        action = str(input.get("action", "get"))
        if action == "get":
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
