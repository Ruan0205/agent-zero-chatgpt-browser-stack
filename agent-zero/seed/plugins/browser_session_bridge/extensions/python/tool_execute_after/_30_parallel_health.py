"""Add subordinate progress evidence to parallel job status snapshots."""

import json
import time

from helpers.extension import Extension


class ParallelHealth(Extension):
    async def execute(self, tool_name: str = "", response=None, **kwargs):
        if tool_name != "parallel" or response is None:
            return
        try:
            payload = json.loads(response.message)
        except (TypeError, ValueError):
            return
        if not isinstance(payload, dict) or not isinstance(payload.get("jobs"), list):
            return
        from agent import AgentContext

        changed = False
        for job in payload["jobs"]:
            if not isinstance(job, dict) or job.get("tool_name") != "call_subordinate":
                continue
            context_id = job.get("context_id")
            if not isinstance(context_id, str) or not context_id:
                continue
            context = AgentContext.get(context_id)
            if context is None:
                continue
            logs = getattr(context.log, "logs", [])
            last = logs[-1] if logs else None
            job["health"] = {
                "context_running": bool(context.is_running()),
                "log_entries": len(logs),
                "seconds_since_last_log": round(max(0.0, time.time() - last.timestamp), 1) if last else None,
                "last_step": str(last.heading or last.type)[:120] if last else None,
                "note": "No recent log alone does not prove a hang; a model or external tool may still be working.",
            }
            changed = True
        if changed:
            response.message = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
