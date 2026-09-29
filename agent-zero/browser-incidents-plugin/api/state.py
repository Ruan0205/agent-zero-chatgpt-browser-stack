"""Authenticated UI facade for incident reports and the isolated repair controller."""

import json
import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from helpers.api import ApiHandler, Request, Response
from plugins._browser_incidents import completion_state


ROOT = Path(os.environ.get("BROWSER_INCIDENTS_DIR", "/a0/usr/browser-incidents"))
SETTINGS = ROOT / "settings.json"
INCIDENTS = ROOT / "incidents.json"
STATUS = ROOT / "status.json"
REPAIR_SESSIONS = ROOT / "repair-sessions.json"
SHARED_UID = int(os.environ.get("BROWSER_INCIDENTS_UID", "1000"))
SHARED_GID = int(os.environ.get("BROWSER_INCIDENTS_GID", "1000"))
CONTROLLER_URL = os.environ.get("REPAIR_CONTROLLER_URL", "http://repair-controller:8099/action")
CONTROLLER_TOKEN = os.environ.get("REPAIR_AGENT_API_TOKEN", "")
BRIDGE_TOKEN = os.environ.get("BROWSER_POOL_NOTICE_TOKEN") or os.environ.get("AGENT_ZERO_NOTICE_TOKEN", "")


def _profile_enabled(name: str) -> bool:
    return name in {part.strip() for part in os.environ.get("COMPOSE_PROFILES", "").split(",")}


def _hard_reload_browsers():
    if not BRIDGE_TOKEN:
        raise RuntimeError("Token da ponte não configurado")
    results = []
    bridges = ["chatgpt-browser-agent"]
    if _profile_enabled("browser-utility"):
        bridges.append("chatgpt-browser-utility")
    if _profile_enabled("browser-repair"):
        bridges.append("chatgpt-browser-repair")
    for name in bridges:
        request = urllib.request.Request(
            f"http://{name}:8000/v1/admin/hard-reload", data=b"{}", method="POST",
            headers={"Content-Type": "application/json", "X-Browser-Pool-Token": BRIDGE_TOKEN},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.loads(response.read().decode("utf-8"))
            results.append({"bridge": name, **result})
        except (urllib.error.URLError, ValueError, TimeoutError) as error:
            results.append({"bridge": name, "success": False, "error": str(error)[:200]})
    return {"success": True, "reload_results": results}


def _vnc_slots():
    """Live, read-only status; never infer availability from a static port."""
    services = [
        ("http://chatgpt-browser-agent:8000/health", (("Principal 1", int(os.environ.get("CHATGPT_VNC_PORT", "50081"))), ("Principal 2", int(os.environ.get("CHATGPT_VNC_2_PORT", "50083"))), ("Principal 3", int(os.environ.get("CHATGPT_VNC_3_PORT", "50085"))))),
    ]
    if _profile_enabled("browser-utility"):
        services.append(("http://chatgpt-browser-utility:8000/health", (("Utility", int(os.environ.get("CHATGPT_UTILITY_VNC_PORT", "50084"))),)))
    if _profile_enabled("browser-repair"):
        services.append(("http://chatgpt-browser-repair:8000/health", (("Reparador", int(os.environ.get("CHATGPT_REPAIR_VNC_PORT", "50087"))), ("Utility reparador", int(os.environ.get("CHATGPT_REPAIR_UTILITY_VNC_PORT", "50088"))))))
    slots = []
    for url, displays in services:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as response:
                health = json.loads(response.read().decode("utf-8"))
            browser_slots = health.get("slots", [])
        except (OSError, ValueError, TypeError):
            browser_slots = []
        for index, (label, port) in enumerate(displays):
            slot = browser_slots[index] if index < len(browser_slots) else {}
            status = "busy" if slot.get("busy") else "ready" if slot.get("state") == "ready" else "offline"
            slots.append({"label": label, "port": port, "status": status})
    return slots


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
    repairs = _read(REPAIR_SESSIONS, {})
    if not isinstance(repairs, dict):
        repairs = {}
    return {
        "success": True,
        "enabled": settings.get("enabled") is not False,
        "incidents": incidents,
        "status": status,
        "repair_sessions": repairs,
        "unread_completed_chats": completion_state.unread(),
        "repair_vnc_port": int(os.environ.get("REPAIR_VNC_PORT", "50087")),
        "vnc_slots": _vnc_slots(),
        "repair_has_vnc": os.environ.get("REPAIR_REQUIRES_BROWSER", "true").lower() == "true",
        "counts": {
            "total": len(incidents) + len(repairs),
            "open": sum(1 for item in incidents if not item.get("resolved")) + len(repairs),
            "resolved": sum(1 for item in incidents if item.get("resolved")),
        },
    }


def _controller_action(action: str, input: dict):
    if not CONTROLLER_TOKEN:
        raise RuntimeError("Token do reparador não configurado")
    payload = {"action": action, "context_id": input.get("context_id", "")}
    if action == "request_improvement":
        payload["description"] = input.get("description", "")
    elif action == "diagnose_chat":
        payload["chat_name"] = input.get("chat_name", "")
        payload["error_description"] = input.get("error_description", "")
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
    return result.get("session", {})


class State(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict | Response:
        ROOT.mkdir(parents=True, exist_ok=True)
        action = str(input.get("action", "get"))
        if action == "get":
            return _snapshot()
        if action == "unread_only":
            return {"success": True, "unread_completed_chats": completion_state.unread()}
        if action == "hard_reload_browsers":
            return _hard_reload_browsers()
        if action == "mark_read":
            try:
                completion_state.mark_read(str(input.get("context_id", "")))
            except ValueError as error:
                return {"success": False, "error": str(error)}
            return {"success": True, "unread_completed_chats": completion_state.unread()}
        if action in {"diagnose_chat", "report_chat", "request_improvement", "repair_message", "approve_repair",
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
            try:
                outcome = _controller_action("clear_audits", {})
            except (OSError, RuntimeError, ValueError) as error:
                return {"success": False, "error": str(error)}
            _write(INCIDENTS, [])
            snapshot = _snapshot()
            snapshot["preserved_active_audits"] = len(outcome.get("busy", []))
            return snapshot
        if action == "remove_audit":
            try:
                _controller_action("remove_audit", input)
            except (OSError, RuntimeError, ValueError) as error:
                return {"success": False, "error": str(error)}
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
