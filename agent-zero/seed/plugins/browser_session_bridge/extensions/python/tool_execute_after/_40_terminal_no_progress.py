"""Record consecutive silent terminal polls without confusing silence with failure."""

from helpers.extension import Extension


STATE_KEY = "_terminal_no_progress"
SILENT_MARKER = "[SYSTEM: Returning control to agent after"


class TerminalNoProgress(Extension):
    async def execute(self, tool_name: str = "", response=None, **kwargs):
        if tool_name != "code_execution_tool" or self.agent is None or response is None:
            return
        tool = getattr(getattr(self.agent, "loop_data", None), "current_tool", None)
        args = getattr(tool, "args", None)
        if not isinstance(args, dict):
            return
        try:
            session = int(args.get("session", 0))
            state = self.agent.get_data("_cet_state")
            shell = state.shells.get(session) if state else None
        except (AttributeError, TypeError, ValueError):
            return
        if shell is None:
            return

        counters = self.agent.loop_data.params_persistent.setdefault(STATE_KEY, {})
        key = str(session)
        if not shell.running or str(args.get("runtime", "")).lower() != "output":
            counters.pop(key, None)
            return

        # A framework timeout is not evidence of progress or failure. Count
        # only polls with no command bytes, never an active job's elapsed time.
        message = str(response.message or "").lstrip()
        if not message.startswith(SILENT_MARKER) or "no output" not in message[:180]:
            counters.pop(key, None)
            return
        silent = int(counters.get(key, 0)) + 1
        counters[key] = silent
        response.message += (
            f"\n[SYSTEM: TERMINAL_NO_PROGRESS session={session} "
            f"consecutive_silent_polls={silent}. "
            + (
                "Do not poll this output session again. Use a DIFFERENT terminal "
                "session for a bounded read-only check of the exact process, its log "
                "and health endpoint. Silence does not authorize killing the job.]"
                if silent >= 2 else
                "One silent poll is inconclusive; the process may still be working.]"
            )
        )
