from __future__ import annotations

import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path("/workspace/chats").resolve()
TOKEN = os.environ.get("VSCODE_EXEC_TOKEN", "")
CONTEXT_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")


def workspace_for(context_id: str) -> Path:
    context_id = str(context_id or "").strip()
    if not CONTEXT_RE.fullmatch(context_id):
        raise ValueError("invalid context id")
    path = (ROOT / context_id).resolve()
    path.relative_to(ROOT)
    path.mkdir(parents=True, exist_ok=True)
    return path


class Handler(BaseHTTPRequestHandler):
    server_version = "A0VSCodeExec/1.0"

    def log_message(self, *_args):
        return

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        return bool(TOKEN) and self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def do_GET(self):
        if self.path == "/healthz":
            self.send_json(200, {"ok": True})
            return
        self.send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.authorized():
            self.send_json(401, {"ok": False, "error": "unauthorized"})
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 1_000_000)
            data = json.loads(self.rfile.read(length) or b"{}")
            workspace = workspace_for(data.get("context_id", ""))
            if self.path == "/ensure":
                self.send_json(200, {"ok": True, "workspace": str(workspace)})
                return
            if self.path != "/exec":
                self.send_json(404, {"ok": False, "error": "not found"})
                return

            command = str(data.get("command") or "")
            if not command.strip():
                raise ValueError("command is required")
            timeout = max(1, min(int(data.get("timeout") or 120), 600))
            result = subprocess.run(
                ["/bin/bash", "-lc", command],
                cwd=workspace,
                text=True,
                capture_output=True,
                timeout=timeout,
                env={**os.environ, "A0_CHAT_WORKSPACE": str(workspace)},
            )
            self.send_json(
                200,
                {
                    "ok": result.returncode == 0,
                    "workspace": str(workspace),
                    "exit_code": result.returncode,
                    "stdout": result.stdout[-120_000:],
                    "stderr": result.stderr[-120_000:],
                },
            )
        except subprocess.TimeoutExpired as exc:
            self.send_json(
                408,
                {
                    "ok": False,
                    "error": "command timed out",
                    "stdout": str(exc.stdout or "")[-20_000:],
                    "stderr": str(exc.stderr or "")[-20_000:],
                },
            )
        except Exception as exc:
            self.send_json(400, {"ok": False, "error": str(exc)})


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", 8765), Handler).serve_forever()
