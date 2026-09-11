from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from helpers.tool import Response, Tool


SERVICE = "http://agent-zero-vscode:8765"
WORKSPACE_ROOT = Path("/workspace/chats")
CONTEXT_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")


def _context_id(agent: Any) -> str:
    value = str(getattr(getattr(agent, "context", None), "id", "") or "").strip()
    if not CONTEXT_RE.fullmatch(value):
        raise ValueError("O identificador deste chat não pode ser usado como workspace.")
    return value


def _request(path: str, payload: dict[str, Any], timeout: int = 630) -> dict[str, Any]:
    token = os.environ.get("VSCODE_EXEC_TOKEN", "")
    request = urllib.request.Request(
        SERVICE + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw)
        except ValueError:
            return {"ok": False, "error": raw or str(exc)}


class Vscode(Tool):
    async def execute(
        self,
        action: str = "open",
        command: str = "",
        timeout: int = 120,
        **_kwargs: Any,
    ) -> Response:
        context_id = _context_id(self.agent)
        workspace = WORKSPACE_ROOT / context_id
        action = str(action or "open").strip().lower()

        if action in {"open", "status"}:
            result = _request("/ensure", {"context_id": context_id})
            if not result.get("ok"):
                return Response(message=f"VS Code indisponível: {result.get('error', 'erro desconhecido')}", break_loop=False)
            if action == "open":
                self.agent.set_data("_vscode_workspace_active", True)
            file_count = sum(1 for item in workspace.rglob("*") if item.is_file())
            return Response(
                message=(
                    f"VS Code pronto para este chat. Workspace: {workspace}. "
                    f"Arquivos atuais: {file_count}."
                ),
                break_loop=False,
                additional={
                    "vscode_workspace": str(workspace),
                    "vscode_context_id": context_id,
                    "vscode_open": action == "open",
                },
            )

        if action != "terminal":
            return Response(message="Ação inválida. Use open, status ou terminal.", break_loop=False)
        result = _request(
            "/exec",
            {
                "context_id": context_id,
                "command": str(command or ""),
                "timeout": max(1, min(int(timeout or 120), 600)),
            },
        )
        return Response(
            message=json.dumps(result, ensure_ascii=False, indent=2),
            break_loop=False,
            additional={
                "vscode_workspace": str(workspace),
                "vscode_context_id": context_id,
            },
        )
