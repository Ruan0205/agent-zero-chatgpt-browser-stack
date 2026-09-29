"""Durable control plane for the isolated Agent Zero repair instance.

This service is deliberately outside the main Agent Zero container: restarting
the main UI cannot cancel a repair already running in the dedicated instance.
"""

import json
import hashlib
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
REPAIR_REPO = Path(os.environ.get("REPAIR_REPO_DIR", "/repair-repo"))
TOKEN = os.environ.get("REPAIR_AGENT_API_TOKEN", "")
MAIN_TOKEN = os.environ.get("MAIN_AGENT_API_TOKEN", "")
REPAIR_URL = os.environ.get("REPAIR_AGENT_URL", "http://agent-zero-repair/api/api_message")
MAIN_URL = os.environ.get("MAIN_AGENT_API_URL", "http://agent-zero/api/api_message")
MAIN_SETTINGS = Path(os.environ.get("MAIN_SETTINGS_FILE", "/main-settings/settings.json"))
LOCK = threading.RLock()
RUN_LOCK = threading.Lock()
ACTIVE_PHASES = {"diagnosing", "answering", "repairing", "resuming"}
_repair_api_token_cache = ""


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
    # Docker may take longer than 15 seconds to start the repair browser/agent
    # on a memory-constrained host. Do not mark a healthy delayed start failed.
    connection = DockerConnection(timeout=300)
    try:
        connection.request("POST", f"/v1.47/containers/{name}/{action}")
        response = connection.getresponse()
        message = response.read().decode("utf-8", errors="replace")
        if response.status not in {204, 304}:
            raise RuntimeError(f"Docker {action} {name}: HTTP {response.status} {message[:300]}")
    finally:
        connection.close()


def runtime_agent_token(container_name):
    """Read the running Agent Zero API token without logging or persisting it."""
    if container_name not in {"agent-zero", "agent-zero-repair"}:
        raise ValueError("Container de Agent Zero inválido")
    command = [
        "/opt/venv-a0/bin/python", "-c",
        "import sys; sys.path.insert(0, '/a0'); "
        "from helpers.settings import get_settings; "
        "print(get_settings().get('mcp_server_token', ''))",
    ]
    headers = {"Content-Type": "application/json"}
    connection = DockerConnection(timeout=120)
    try:
        connection.request("POST", f"/v1.47/containers/{container_name}/exec",
                           body=json.dumps({"AttachStdout": True, "AttachStderr": True,
                                            "Tty": True, "Cmd": command}), headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        if response.status != 201 or not payload.get("Id"):
            raise RuntimeError(f"Não foi possível consultar o token da API de {container_name}")
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
            raise RuntimeError(f"Falha ao consultar a API de {container_name}")
        token = output.splitlines()[-1].strip() if output else ""
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", token):
            raise RuntimeError(f"Token da API de {container_name} inválido")
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
    # API-based repair models must not depend on a browser/VNC lifecycle.
    # Opt in only for installations that explicitly use a browser repair model.
    if os.environ.get("REPAIR_REQUIRES_BROWSER", "false").lower() == "true":
        container_action("chatgpt-browser-repair", "start")
        wait_http("http://chatgpt-browser-repair:8000/health", timeout=900)
    container_action("agent-zero-repair", "start")
    wait_http("http://agent-zero-repair/login")


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


def recent_chat_evidence(source_id):
    """Bounded, read-only evidence for diagnosis without a second LLM file parser."""
    chat = read_json(CHATS / source_id / "chat.json", {})
    logs = chat.get("log", {}).get("logs", []) if isinstance(chat, dict) else []
    if not isinstance(logs, list):
        return []
    evidence = []
    for item in logs[-24:]:
        if not isinstance(item, dict):
            continue
        evidence.append({
            "no": item.get("no"),
            "type": item.get("type"),
            "heading": str(item.get("heading") or "")[:180],
            "content": str(item.get("content") or "")[:500],
        })
    return evidence


def remove_sessions(source_id=None):
    """Remove idle audits; never hide a repair that is still modifying state."""
    with LOCK:
        all_sessions = sessions()
        targets = [source_id] if source_id else list(all_sessions)
        busy = [key for key in targets if all_sessions.get(key, {}).get("phase") in ACTIVE_PHASES]
        if busy and source_id:
            raise ValueError("Aguarde a auditoria em execução terminar antes de apagá-la: " + ", ".join(busy))
        removed = 0
        for key in targets:
            if key in busy:
                continue
            entry = all_sessions.pop(key, None)
            if not entry:
                continue
            removed += 1
            snapshot = entry.get("snapshot", "")
            if re.fullmatch(r"snapshot-[a-f0-9-]+\.json", str(snapshot)):
                (INPUTS / snapshot).unlink(missing_ok=True)
        if removed:
            write_json(SESSIONS, all_sessions)
        return {"removed": removed, "busy": busy}


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
    # A repair can include long diagnostics/builds.  The prior 30-minute
    # socket deadline incorrectly marked an active Agent Zero turn as failed.
    # Keep the call bounded, but allow a full supervised repair window.
    with urllib.request.urlopen(request, timeout=21600) as response:
        value = json.loads(response.read().decode("utf-8"))
    if value.get("error") or not value.get("context_id"):
        raise RuntimeError(str(value.get("error") or "Resposta sem context_id"))
    return value


def repair_was_not_executed(answer):
    lowered = answer.casefold()
    return any(phrase in lowered for phrase in (
        "nenhuma alteração foi feita", "nenhuma modific", "você autoriza",
        "voce autoriza", "no changes were made", "do you authorize",
        "reintegração no serviço em execução/produção depende",
        "deploy/restart correspondente do stack, que não foi executado",
    ))


def repair_validation_incomplete(answer):
    lowered = answer.casefold()
    return any(phrase in lowered for phrase in (
        "não considero satisfeita a validação final completa",
        "não vou declarar o reparo totalmente concluído",
        "validacao final completa nao foi satisfeita",
        "end-to-end validation remains blocked",
    ))


def repair_repo_fingerprint():
    """Hash repository source, not HEAD: dirty fixes may predate this turn."""
    if not REPAIR_REPO.is_dir():
        raise RuntimeError("Repositório de reparo não montado no controlador")
    digest = hashlib.sha256()
    count = 0
    allowed = {".js", ".mjs", ".ts", ".py", ".json", ".yaml", ".yml",
               ".toml", ".html", ".css", ".sh", ".md"}
    excluded = {".git", "node_modules", "backups", "backup", "data", "outbox",
                "dist", "build", "__pycache__", ".next", "vendor"}
    for directory, dirs, names in os.walk(REPAIR_REPO):
        dirs[:] = sorted(name for name in dirs if name not in excluded)
        for name in sorted(names):
            path = Path(directory) / name
            if path.is_symlink() or (path.suffix.lower() not in allowed and name not in {"Dockerfile", "entrypoint.sh"}):
                continue
            stat = path.stat()
            if not path.is_file() or stat.st_size > 2_000_000:
                continue
            relative = str(path.relative_to(REPAIR_REPO)).replace(os.sep, "/")
            digest.update(relative.encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
            count += 1
            if count > 20_000:
                raise RuntimeError("Repositório grande demais para provar reparo")
    return digest.hexdigest()


def run_repair(source_id, repair_id, message, phase):
    with RUN_LOCK:
        try:
            ensure_services()
            # Agent Zero derives its effective API token from the persistent
            # runtime ID and login fields; neither the Compose token nor the
            # redacted settings.json contains it. Read it once per controller
            # lifetime and reuse it instead of doing a Docker exec every turn.
            global _repair_api_token_cache
            if not _repair_api_token_cache:
                _repair_api_token_cache = runtime_agent_token("agent-zero-repair")
            api_token = _repair_api_token_cache
            result = invoke(REPAIR_URL, api_token, message, repair_id)
            answer = str(result.get("response") or "")
            # A returned API response is not proof that an approved repair ran.
            # Some model turns repeat the read-only diagnosis and ask for
            # approval again. Keep those cases actionable instead of falsely
            # marking the incident repaired.
            entry = sessions().get(source_id, {})
            old_fingerprint = entry.get("repair_start_fingerprint")
            unchanged_repo = phase == "repairing" and (not old_fingerprint or old_fingerprint == repair_repo_fingerprint())
            incomplete_repair = phase == "repairing" and (repair_was_not_executed(answer) or unchanged_repo)
            validation_incomplete = phase == "repairing" and repair_validation_incomplete(answer)
            next_phase = ("awaiting_approval" if phase in {"diagnosing", "answering"} or incomplete_repair
                          else "error" if validation_incomplete else "repaired")
            change(source_id, context_id=result["context_id"], phase=next_phase,
                   response=answer, error=("Nenhuma mudança nova foi comprovada no repositório desde a aprovação."
                                             if incomplete_repair else
                                             "Correção implantada, mas a validação final ficou pendente. Não retome automaticamente o chat original."
                                             if validation_incomplete else ""))
        except Exception as error:
            change(source_id, phase="error", error=str(error)[:3000])
        finally:
            if phase == "repairing" and repair_id:
                (CONTROL / f"{repair_id}.approved").unlink(missing_ok=True)


def run_resume(source_id):
    try:
        token = runtime_agent_token("agent-zero")
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
    if kind == "clear_audits":
        return remove_sessions()
    if kind == "request_improvement":
        description = str(payload.get("description", "")).strip()
        if not description or len(description) > 20_000:
            raise ValueError("Descreva a melhoria (até 20.000 caracteres)")
        improvement_id = "improvement-" + uuid.uuid4().hex[:16]
        change(improvement_id, type="improvement", chat_name="Melhoria do Agent Zero",
               source_chat_id=str(payload.get("context_id", ""))[:160],
               error_description=description, phase="diagnosing", context_id="",
               response="", error="")
        message = (
            "Diagnostique em modo SOMENTE LEITURA a melhoria proposta para TODO o Agent Zero: "
            + json.dumps(description, ensure_ascii=False)
            + ". Planeje uma mudança persistente, testes e possíveis riscos. "
              "Use apenas o repositório local montado e os acessos autorizados nesta instalação. "
              "Não execute ferramentas nem altere arquivos nesta fase: apresente o plano e "
              "pergunte se autorizo implementá-lo. Só use GitHub quando eu pedir explicitamente "
              "commit, release ou atualização do repositório."
        )
        launch(run_repair, improvement_id, "", message, "diagnosing")
        return sessions()[improvement_id]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", source_id):
        raise ValueError("Chat de origem inválido")
    if kind == "remove_audit":
        return remove_sessions(source_id)
    with LOCK:
        entry = sessions().get(source_id)
        if kind == "reopen_unfinished_repair":
            if not entry or not entry.get("context_id") or entry.get("phase") not in {"repaired", "error"}:
                raise ValueError("Somente um reparo interrompido pode ser reaberto")
            if (entry.get("phase") == "repaired" and entry.get("repair_start_fingerprint")
                    and not repair_was_not_executed(str(entry.get("response") or ""))):
                raise ValueError("Este reparo não foi comprovado como incompleto")
            change(source_id, phase="awaiting_approval", error="O turno anterior não executou o reparo.")
            return sessions()[source_id]
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
                "O controlador já leu, sem modificar, o trecho recente do chat de origem "
                "e o apresenta abaixo como evidência. Use-o diretamente; não é necessário "
                "invocar document_query ou outra ferramenta para repetir essa leitura. "
                "Se o trecho não bastar, diga precisamente qual evidência adicional falta. "
                "Não reabra nem tente reparar problemas antigos já resolvidos. "
                "Identifique evidências, causa raiz e correção persistente para todos os chats. "
                "Não chame ferramentas neste turno: as evidências necessárias já foram "
                "fornecidas pelo controlador, e o guard bloqueia ferramentas antes da aprovação. "
                "Não faça modificações; pergunte se autorizo o reparo. "
                "TRECHO_RECENTE_DO_CHAT_JSON="
                + json.dumps(recent_chat_evidence(source_id), ensure_ascii=False)
                + " SNAPSHOT_DA_INTERFACE_JSON="
                + json.dumps(payload.get("interface_snapshot", {}), ensure_ascii=False)[:2500]
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
            change(source_id, phase="repairing", error="",
                   repair_start_fingerprint=repair_repo_fingerprint())
            instruction = (
                "Autorizo a melhoria. Faça checkpoint, implemente-a de forma persistente para "
                "todos os chats, teste e verifique o resultado. Só faça commit/release no meu "
                "repositório se eu pedir explicitamente nesta conversa."
                if entry.get("type") == "improvement" else
                "AUTORIZAÇÃO FORMAL JÁ CONCEDIDA pelo usuário e registrada no controlador para "
                "este contexto e este turno. A restrição somente leitura valia apenas para o "
                "diagnóstico anterior; não peça outra aprovação. Faça checkpoint, investigue "
                "a causa real (inclusive código, runtime e logs; não presuma que o primeiro "
                "diagnóstico acertou), corrija de forma persistente para todos os chats, "
                "teste e verifique o resultado. Antes de declarar sucesso, compare o código "
                "com a versão que JÁ estava em produção, prove qual alteração nova foi feita "
                "e valide o fluxo real de ponta a ponta. Testes antigos passando ou diff "
                "preexistente não são reparo. O commit HEAD não é o estado anterior: o "
                "worktree já possuía alterações antes deste turno. Rastreie o erro concreto "
                "do chat de origem nos logs/turnos, produza um teste que falhe antes de uma "
                "mudança nova e prove o antes/depois. Erro atual descrito pelo usuário: "
                f"{json.dumps(str(entry.get('error_description') or '')[:1800], ensure_ascii=False)}. "
                "Se houver bloqueio técnico, informe qual foi "
                "e não declare o reparo concluído. Não retome o chat original sem aprovação "
                "separada. Só faça commit/release no meu repositório se eu pedir explicitamente."
            )
            launch(run_repair, source_id, repair_id, instruction, "repairing")
        elif kind == "decline_repair":
            change(source_id, phase="declined")
        elif kind == "resume_source":
            if entry.get("type") == "improvement":
                raise ValueError("Melhorias não possuem chat de origem para retomar")
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
        elif entry.get("phase") == "repaired" and repair_validation_incomplete(str(entry.get("response") or "")):
            change(source_id, phase="error",
                   error="Correção implantada, mas a validação final ficou pendente. Não retome automaticamente o chat original.")
    ThreadingHTTPServer(("0.0.0.0", 8099), Handler).serve_forever()
