"""Durable control plane for the isolated Agent Zero repair instance.

This service is deliberately outside the main Agent Zero container: restarting
the main UI cannot cancel a repair already running in the dedicated instance.
"""

import json
import http.client
import os
import re
import socket
import tempfile
import threading
import time
import urllib.request
import urllib.error
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(os.environ.get("REPAIR_STATE_DIR", "/data/incidents"))
SESSIONS = ROOT / "repair-sessions.json"
INPUTS = ROOT / "repair-inputs"
CONTROL = Path(os.environ.get("REPAIR_CONTROL_DIR", "/repair-control"))
CHATS = Path(os.environ.get("SOURCE_CHATS_DIR", "/source-chats"))
TOKEN = os.environ.get("REPAIR_AGENT_API_TOKEN", "")
MAIN_TOKEN = os.environ.get("MAIN_AGENT_API_TOKEN", "")
REPAIR_URL = os.environ.get("REPAIR_AGENT_URL", "http://agent-zero-repair/api/api_message")
MAIN_URL = os.environ.get("MAIN_AGENT_API_URL", "http://agent-zero/api/api_message")
MAIN_SETTINGS = Path(os.environ.get("MAIN_SETTINGS_FILE", "/main-settings/settings.json"))
LOCK = threading.RLock()
RUN_LOCK = threading.Lock()


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, timeout=15):
        super().__init__("localhost", timeout=timeout)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


def container_action(name, action):
    if name not in {"chatgpt-browser-repair", "agent-zero-repair"} or action not in {"start", "stop"}:
        raise ValueError("Ação Docker fora dos containers de reparo")
    connection = DockerConnection()
    try:
        connection.request("POST", f"/v1.47/containers/{name}/{action}")
        response = connection.getresponse()
        message = response.read().decode("utf-8", errors="replace")
        if response.status not in {204, 304}:
            raise RuntimeError(f"Docker {action} {name}: HTTP {response.status} {message[:300]}")
    finally:
        connection.close()


def runtime_main_token():
    """Read the main Agent Zero API token without logging or persisting it."""
    command = [
        "/opt/venv-a0/bin/python", "-c",
        "import sys; sys.path.insert(0, '/a0'); "
        "from helpers.settings import get_settings; "
        "print(get_settings().get('mcp_server_token', ''))",
    ]
    headers = {"Content-Type": "application/json"}
    connection = DockerConnection(timeout=120)
    try:
        connection.request("POST", "/v1.47/containers/agent-zero/exec",
                           body=json.dumps({"AttachStdout": True, "AttachStderr": True,
                                            "Tty": True, "Cmd": command}), headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        if response.status != 201 or not payload.get("Id"):
            raise RuntimeError("Não foi possível consultar o token da API principal")
        exec_id = payload["Id"]
    finally:
        connection.close()
    connection = DockerConnection(timeout=120)
    try:
        connection.request("POST", f"/v1.47/exec/{exec_id}/start",
                           body=json.dumps({"Detach": False, "Tty": True}), headers=headers)
        response = connection.getresponse()
        output = response.read().decode("utf-8", errors="replace").strip()
        if response.status != 200:
            raise RuntimeError("Falha ao consultar a API principal")
        token = output.splitlines()[-1].strip() if output else ""
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", token):
            raise RuntimeError("Token da API principal inválido")
        return token
    finally:
        connection.close()


def wait_http(url, timeout=240):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.HTTPError):
            pass
        time.sleep(3)
    raise TimeoutError(f"Serviço de reparo não ficou pronto: {url}")


def ensure_services():
    container_action("chatgpt-browser-repair", "start")
    wait_http("http://chatgpt-browser-repair:8000/health", timeout=900)
    container_action("agent-zero-repair", "start")
    wait_http("http://agent-zero-repair/login")


def stop_services():
    # Only exact repair containers are stopped; the main Agent Zero is never
    # touched by this lifecycle manager.
    container_action("agent-zero-repair", "stop")
    container_action("chatgpt-browser-repair", "stop")


def now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o660)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def sessions():
    value = read_json(SESSIONS, {})
    return value if isinstance(value, dict) else {}


def change(source_id, **fields):
    with LOCK:
        all_sessions = sessions()
        entry = all_sessions.get(source_id, {"source_id": source_id})
        entry.update(fields)
        entry["updated_at"] = now()
        all_sessions[source_id] = entry
        write_json(SESSIONS, all_sessions)
        return dict(entry)


def invoke(url, token, message, context_id=""):
    body = {"message": message}
    if context_id:
        body["context_id"] = context_id
    request = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "X-API-KEY": token},
    )
    with urllib.request.urlopen(request, timeout=1800) as response:
        value = json.loads(response.read().decode("utf-8"))
    if value.get("error") or not value.get("context_id"):
        raise RuntimeError(str(value.get("error") or "Resposta sem context_id"))
    return value


def run_repair(source_id, repair_id, message, phase):
    with RUN_LOCK:
        try:
            ensure_services()
            result = invoke(REPAIR_URL, TOKEN, message, repair_id)
            next_phase = "awaiting_approval" if phase in {"diagnosing", "answering"} else "repaired"
            change(source_id, context_id=result["context_id"], phase=next_phase,
                   response=str(result.get("response") or ""), error="")
        except Exception as error:
            change(source_id, phase="error", error=str(error)[:3000])
        finally:
            if phase == "repairing" and repair_id:
                (CONTROL / f"{repair_id}.approved").unlink(missing_ok=True)
                try:
                    stop_services()
                except Exception as error:
                    change(source_id, lifecycle_error=str(error)[:1000])


def stop_when_idle():
    with RUN_LOCK:
        stop_services()


def run_resume(source_id):
    try:
        token = MAIN_TOKEN or read_json(MAIN_SETTINGS, {}).get("mcp_server_token") or runtime_main_token()
        if not token:
            raise RuntimeError("Token da API principal indisponível")
        result = invoke(MAIN_URL, token,
                        "Continue de onde parou. O reparador concluiu a correção aprovada; "
                        "confira o estado real antes de prosseguir.", source_id)
        change(source_id, phase="resumed", resume_response=str(result.get("response") or ""), error="")
    except Exception as error:
        change(source_id, phase="resume_error", error=str(error)[:3000])


def launch(target, *args):
    threading.Thread(target=target, args=args, daemon=True).start()


def action(payload):
    kind = str(payload.get("action", ""))
    source_id = str(payload.get("context_id", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", source_id):
        raise ValueError("Chat de origem inválido")
    with LOCK:
        entry = sessions().get(source_id)
        if kind == "diagnose_chat":
            description = str(payload.get("error_description", "")).strip()
            if not description or len(description) > 20_000:
                raise ValueError("Descreva o erro atual (até 20.000 caracteres) antes da análise")
            if entry and entry.get("phase") in {"diagnosing", "answering", "repairing", "resuming"}:
                return entry
            if entry and entry.get("phase") == "awaiting_approval" and entry.get("error_description") == description:
                return entry
            if not (CHATS / source_id / "chat.json").is_file():
                raise ValueError("Histórico completo do chat não encontrado")
            INPUTS.mkdir(parents=True, exist_ok=True)
            snapshot_name = f"snapshot-{uuid.uuid4()}.json"
            write_json(INPUTS / snapshot_name, payload.get("interface_snapshot", {}))
            change(source_id, chat_name=str(payload.get("chat_name", source_id))[:300],
                   phase="diagnosing", context_id=(entry or {}).get("context_id", ""),
                   response="", error="", snapshot=snapshot_name,
                   error_description=description)
            message = (
                "Diagnostique em modo SOMENTE LEITURA o erro ATUAL descrito pelo usuário: "
                f"{json.dumps(description, ensure_ascii=False)}. "
                f"Consulte /repair-inputs/repair-inputs/{snapshot_name} e procure no histórico "
                f"/source-chats/{source_id}/chat.json apenas os trechos relevantes a este sintoma, "
                "priorizando eventos recentes e os registros contemporâneos do erro. "
                "Não reabra nem tente reparar problemas antigos já resolvidos. "
                "Aumente o escopo da leitura somente quando necessário para confirmar a causa. "
                "Identifique evidências, causa raiz e correção persistente para todos os chats. "
                "Não faça modificações neste turno; pergunte se autorizo o reparo."
            )
            launch(run_repair, source_id, (entry or {}).get("context_id", ""), message, "diagnosing")
            return sessions()[source_id]
        if not entry or not entry.get("context_id"):
            raise ValueError("Diagnóstico ainda não concluído")
        if entry.get("phase") in {"diagnosing", "answering", "repairing", "resuming"}:
            raise ValueError("Reparador ainda está ocupado")
        repair_id = entry["context_id"]
        if kind == "repair_message":
            message = str(payload.get("message", "")).strip()
            if not message or len(message) > 20000:
                raise ValueError("Mensagem deve conter de 1 a 20.000 caracteres")
            change(source_id, phase="answering", error="")
            launch(run_repair, source_id, repair_id, message, "answering")
        elif kind == "approve_repair":
            if entry.get("phase") != "awaiting_approval":
                raise ValueError("Aguarde o diagnóstico antes de aprovar")
            CONTROL.mkdir(parents=True, exist_ok=True)
            marker = CONTROL / f"{repair_id}.approved"
            marker.write_text(now(), encoding="utf-8")
            os.chmod(marker, 0o600)
            change(source_id, phase="repairing", error="")
            launch(run_repair, source_id, repair_id,
                   "Autorizo o reparo. Faça checkpoint, corrija a causa raiz para todos os chats, "
                   "teste, reinicie a stack se necessário e verifique o resultado. Não retome o chat "
                   "original sem autorização separada.", "repairing")
        elif kind == "decline_repair":
            change(source_id, phase="declined")
            launch(stop_when_idle)
        elif kind == "resume_source":
            if entry.get("phase") != "repaired":
                raise ValueError("O reparo deve terminar antes da retomada")
            change(source_id, phase="resuming")
            launch(run_resume, source_id)
        else:
            raise ValueError("Ação desconhecida")
        return sessions()[source_id]


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/action":
            return self.reply(404, {"error": "not found"})
        if not TOKEN or self.headers.get("X-Repair-Token", "") != TOKEN:
            return self.reply(403, {"error": "forbidden"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 2_000_000:
                raise ValueError("Captura da interface excessiva")
            payload = json.loads(self.rfile.read(length))
            result = action(payload)
            self.reply(202, {"success": True, "session": result})
        except (ValueError, OSError, RuntimeError) as error:
            self.reply(400, {"success": False, "error": str(error)})

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    # Recovery after an unclean controller restart must not show eternal work.
    for source_id, entry in sessions().items():
        if entry.get("phase") in {"diagnosing", "answering", "repairing", "resuming"}:
            if entry.get("context_id"):
                (CONTROL / f"{entry['context_id']}.approved").unlink(missing_ok=True)
            change(source_id, phase="error", error="Coordenação interrompida; revise o chat antes de tentar novamente.")
    ThreadingHTTPServer(("0.0.0.0", 8099), Handler).serve_forever()
