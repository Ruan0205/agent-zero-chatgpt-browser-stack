"""Run a bounded project test and read-only HTTP/container checks in this chat's workspace."""

from __future__ import annotations

import asyncio
import http.client
import json
import os
import re
import socket
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

from helpers.tool import Response, Tool


CHAT_ID = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
TEST_COMMAND = re.compile(
    r"^(?:python(?:3)? -m pytest|pytest|npm test|pnpm test|yarn test|go test|cargo test|dotnet test|npx vitest)(?: [A-Za-z0-9_./=:-]+)*$"
)


def _auto_command(workspace: Path) -> str | None:
    if (workspace / "pyproject.toml").exists() or (workspace / "pytest.ini").exists():
        return "python -m pytest -q"
    if (workspace / "package.json").exists():
        try:
            package = json.loads((workspace / "package.json").read_text(encoding="utf-8"))
            if package.get("scripts", {}).get("test"):
                return "npm test"
        except (OSError, ValueError):
            pass
    if (workspace / "go.mod").exists():
        return "go test ./..."
    if (workspace / "Cargo.toml").exists():
        return "cargo test"
    return None


def _vscode_test(context_id: str, command: str, timeout: int) -> dict[str, Any]:
    payload = json.dumps({"context_id": context_id, "command": command, "timeout": timeout}).encode()
    request = urllib.request.Request(
        "http://agent-zero-vscode:8765/exec", data=payload, method="POST",
        headers={"Authorization": f"Bearer {os.environ.get('VSCODE_EXEC_TOKEN', '')}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout + 30) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError) as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def _http_check(url: str) -> dict[str, Any]:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return {"error": "Only absolute HTTP(S) URLs are accepted."}
    try:
        request = urllib.request.Request(url, method="GET", headers={"User-Agent": "AgentZeroProjectCheck/1"})
        with urllib.request.urlopen(request, timeout=12) as response:
            return {"status": response.status, "final_url": response.url, "content_type": response.headers.get("Content-Type", "")}
    except urllib.error.HTTPError as exc:
        return {"status": exc.code, "final_url": exc.url}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def _container_check(name: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name):
        return {"error": "Invalid container name."}
    connection = http.client.HTTPConnection("localhost", timeout=5)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(5)
    try:
        sock.connect("/var/run/docker.sock")
        connection.sock = sock
        connection.request("GET", f"/containers/{quote(name)}/json")
        response = connection.getresponse()
        if response.status != 200:
            return {"status": response.status, "error": "Container not found or unavailable."}
        data = json.loads(response.read(200_000))
        state = data.get("State", {})
        return {"name": name, "running": state.get("Running"), "status": state.get("Status"), "health": state.get("Health", {}).get("Status"), "exit_code": state.get("ExitCode")}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}
    finally:
        connection.close()


class ProjectCheck(Tool):
    async def execute(
        self, test_command: str = "", http_url: str = "", container: str = "", timeout: int = 120, **_kwargs
    ) -> Response:
        context_id = str(self.agent.context.id)
        if not CHAT_ID.fullmatch(context_id):
            return Response(message="Invalid chat ID.", break_loop=False)
        workspace = Path("/workspace/chats") / context_id
        if not workspace.is_dir():
            return Response(message=f"Chat workspace does not exist: {workspace}. Open it with vscode first.", break_loop=False)
        command = str(test_command or "").strip() or _auto_command(workspace)
        report: dict[str, Any] = {"workspace": str(workspace), "checks_only": True}
        if command:
            if not TEST_COMMAND.fullmatch(command):
                report["test_error"] = "Unsupported test command. Use a single pytest/npm/pnpm/yarn/go/cargo/dotnet/vitest test invocation without shell operators."
            else:
                report["test_command"] = command
                report["test"] = await asyncio.to_thread(_vscode_test, context_id, command, max(1, min(int(timeout), 600)))
        else:
            report["test_note"] = "No test manifest found; provide test_command to run tests."
        if http_url:
            report["http"] = await asyncio.to_thread(_http_check, str(http_url))
        if container:
            report["container"] = await asyncio.to_thread(_container_check, str(container))
        return Response(message=json.dumps(report, ensure_ascii=False), break_loop=False)
