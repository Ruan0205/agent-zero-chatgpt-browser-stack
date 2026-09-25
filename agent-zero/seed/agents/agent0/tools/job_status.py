"""Read-only progress snapshot for this chat's parallel jobs and terminal sessions."""

from __future__ import annotations

import json
import time

from helpers import parallel_tools
from helpers.tool import Response, Tool


class JobStatus(Tool):
    async def execute(self, job_id: str = "", session: int | None = None, **_kwargs) -> Response:
        context = self.agent.context
        await parallel_tools.refresh_parallel_jobs(self.agent)
        now = time.time()
        jobs = context.get_data(parallel_tools.PARALLEL_JOBS_KEY) or {}
        result = {"context_id": context.id, "jobs": [], "terminal_sessions": []}

        for job in jobs.values():
            if not isinstance(job, parallel_tools.ParallelJob):
                continue
            if job_id and job.id != job_id:
                continue
            snapshot = parallel_tools._job_snapshot(job, include_result=False)
            snapshot["created_at"] = job.created_at
            snapshot["started_at"] = job.started_at
            snapshot["completed_at"] = job.completed_at
            last_activity = job.started_at or job.created_at
            if job.worker_context_id:
                from agent import AgentContext

                child = AgentContext.get(job.worker_context_id)
                if child and child.log.logs:
                    last_activity = max(last_activity, child.log.logs[-1].timestamp)
                    snapshot["progress_events"] = len(child.log.logs)
                    snapshot["last_event"] = str(child.log.logs[-1].heading)[:180]
            snapshot["last_activity_at"] = last_activity
            snapshot["idle_seconds"] = round(max(0, now - last_activity), 1)
            snapshot["liveness"] = (
                "finished" if job.state in parallel_tools.TERMINAL_STATES
                else "active" if job.deferred_task and job.deferred_task.is_alive()
                else "uncertain"
            )
            if snapshot["liveness"] == "active" and snapshot["idle_seconds"] >= 300:
                snapshot["note"] = "No recent log event; this alone does not prove a stall."
            result["jobs"].append(snapshot)

        if not job_id:
            state = self.agent.get_data("_cet_state")
            shells = getattr(state, "shells", {}) if state else {}
            for number, shell in shells.items():
                if session is not None and int(session) != int(number):
                    continue
                backend = shell.session
                result["terminal_sessions"].append({
                    "session": number,
                    "running": bool(shell.running),
                    "terminated": bool(backend.is_terminated()),
                    "exit_code": backend.get_exit_code(),
                    "output_chars": len(getattr(backend, "full_output", "")),
                })
        if job_id and not result["jobs"]:
            result["error"] = "No active or retained job with this ID in the current chat."
        if not result["terminal_sessions"]:
            result["terminal_note"] = "No terminal session exists. Do not call code_execution_tool runtime=output; there is nothing to poll."
        return Response(message=json.dumps(result, ensure_ascii=False), break_loop=False)
