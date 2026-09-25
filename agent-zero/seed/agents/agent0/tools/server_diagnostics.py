"""Bounded, read-only snapshot of the Linux host and Docker runtime."""

from __future__ import annotations

import asyncio
import http.client
import json
import socket
import subprocess
from urllib.parse import quote

from helpers.tool import Response, Tool


class _DockerConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__("localhost", timeout=5)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(5)
        self.sock.connect("/var/run/docker.sock")


def _docker_get(path: str) -> object:
    connection = _DockerConnection()
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        data = response.read(2_000_000)
        if response.status != 200:
            raise RuntimeError(f"Docker API HTTP {response.status}")
        return json.loads(data)
    finally:
        connection.close()


def _read_command(argv: list[str], timeout: int = 5, max_chars: int = 5000) -> dict:
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        return {
            "exit_code": completed.returncode,
            "output": completed.stdout[:max_chars],
            "error": completed.stderr[:500],
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def _snapshot() -> dict:
    result = {"read_only": True}
    memory = _read_command(["free", "-m"])
    result["memory_mib"] = memory.get("output", "").splitlines()[1:3] if memory.get("exit_code") == 0 else memory
    processes = _read_command(["ps", "-eo", "pid,comm,%cpu,%mem,rss", "--sort=-rss"], max_chars=2800)
    result["top_processes"] = processes.get("output", "").splitlines()[1:6] if processes.get("exit_code") == 0 else processes
    disk = _read_command(["df", "-h", "/host"])
    result["disk"] = disk.get("output", "").splitlines()[1:2] if disk.get("exit_code") == 0 else disk
    ports = _read_command(["nsenter", "-t", "1", "-m", "-n", "--", "/usr/bin/ss", "-tuln"], max_chars=12000)
    if ports.get("exit_code") == 0:
        lines = ports.get("output", "").splitlines()[1:]
        result["listening_ports"] = {"count_in_capture": len(lines), "sample": lines[:4]}
    else:
        result["listening_ports"] = ports
    errors = _read_command(
        ["journalctl", "--directory=/host/var/log/journal", "-p", "err", "-n", "12", "--no-pager"],
        max_chars=2200,
    )
    result["recent_host_errors"] = [line[:180] for line in errors.get("output", "").splitlines()[-2:]] if errors.get("exit_code") == 0 else errors
    try:
        containers = _docker_get("/containers/json?all=0")
        result["containers"] = {"count": len(containers), "sample_names": [item.get("Names", [""])[0].lstrip("/") for item in containers[:12]]}
        problematic = [item for item in containers if "unhealthy" in item.get("Status", "").lower()][:2]
        result["recent_container_logs"] = {}
        for item in problematic:
            name = item.get("Names", [item["Id"]])[0].lstrip("/")
            connection = _DockerConnection()
            try:
                connection.request("GET", f"/containers/{quote(item['Id'])}/logs?stdout=1&stderr=1&tail=8&timestamps=0")
                response = connection.getresponse()
                result["recent_container_logs"][name] = response.read(500).decode("utf-8", "replace")
            finally:
                connection.close()
    except Exception as exc:
        result["docker_error"] = f"{type(exc).__name__}: {exc}"
    return result


class ServerDiagnostics(Tool):
    async def execute(self, **_kwargs) -> Response:
        result = await asyncio.to_thread(_snapshot)
        return Response(message=json.dumps(result, ensure_ascii=False, separators=(",", ":")), break_loop=False)
