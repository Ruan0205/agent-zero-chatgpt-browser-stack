"""Read-only browser bridge binding and request status for the current chat."""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from helpers.tool import Response, Tool


def _fetch(context_id: str, scope: str) -> dict:
    query = urllib.parse.urlencode({"context_id": context_id, "call_scope": scope})
    request = urllib.request.Request(
        f"http://chatgpt-browser-agent:8000/v1/bridge/status?{query}",
        headers={"X-Bridge-Status-Token": os.environ.get("BROWSER_POOL_NOTICE_TOKEN", "")},
    )
    try:
        with urllib.request.urlopen(request, timeout=6) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError) as exc:
        return {"error": f"{type(exc).__name__}: {exc}", "context_id": context_id}


class BrowserBridgeStatus(Tool):
    async def execute(self, **_kwargs) -> Response:
        context_id = str(self.agent.context.id)
        scope = f"main:{int(self.agent.number)}"
        report = await asyncio.to_thread(_fetch, context_id, scope)
        return Response(message=json.dumps(report, ensure_ascii=False), break_loop=False)
