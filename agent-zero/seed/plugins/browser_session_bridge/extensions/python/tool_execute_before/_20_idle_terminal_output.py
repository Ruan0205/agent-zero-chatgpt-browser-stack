"""Turn an output poll on an idle terminal into a cheap, explicit status read."""

from helpers.extension import Extension


class IdleTerminalOutput(Extension):
    async def execute(self, tool_name: str = "", tool_args: dict | None = None, **kwargs):
        if tool_name != "code_execution_tool" or not self.agent or not isinstance(tool_args, dict):
            return
        if str(tool_args.get("runtime", "")).lower() != "output":
            return
        try:
            session = int(tool_args.get("session", 0))
            state = self.agent.get_data("_cet_state")
            shell = state.shells.get(session) if state else None
        except (AttributeError, TypeError, ValueError):
            return
        if shell is not None and shell.running:
            return

        # A missing shell is idle too. The regular output reader would create
        # a new shell and wait for bytes that cannot arrive.
        tool_args["runtime"] = "terminal"
        tool_args["code"] = (
            "echo '[SYSTEM: TERMINAL_SESSION_IDLE: previous command finished; "
            "do not poll output again. Continue the next task step.]'"
        )
        tool_args["reset"] = False
