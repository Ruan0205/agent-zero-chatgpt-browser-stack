"""Expose authoritative terminal liveness in the model-visible tool result."""

from helpers.extension import Extension


class TerminalState(Extension):
    async def execute(self, tool_name: str = "", response=None, **kwargs):
        if tool_name != "code_execution_tool" or not self.agent or response is None:
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
        marker = (
            f"[SYSTEM: TERMINAL_SESSION_{'RUNNING' if shell.running else 'IDLE'} "
            f"session={session}. "
            + (
                "The command is still active; check its progress before deciding to wait or stop.]"
                if shell.running else
                "The command completed; do not poll this session again. Continue the next task step.]"
            )
        )
        if marker not in response.message:
            response.message = f"{response.message.rstrip()}\n\n{marker}"
