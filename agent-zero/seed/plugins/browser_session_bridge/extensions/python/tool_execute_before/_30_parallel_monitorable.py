"""Start subordinate parallel jobs asynchronously so their health can be inspected."""

from helpers.extension import Extension


class ParallelMonitorable(Extension):
    async def execute(self, tool_name: str = "", tool_args: dict | None = None, **kwargs):
        if tool_name != "parallel" or not isinstance(tool_args, dict):
            return

        # Some models use the intuitive alias `tasks`. Normalize it instead of
        # wasting a model turn on a schema error.
        if "tasks" in tool_args and not any(key in tool_args for key in ("tool_calls", "calls", "items")):
            tool_args["tool_calls"] = tool_args.pop("tasks")

        calls = next(
            (tool_args[key] for key in ("tool_calls", "calls", "items") if isinstance(tool_args.get(key), list)),
            [],
        )
        if any(isinstance(call, dict) and call.get("tool_name") == "call_subordinate" for call in calls):
            # A blocking await hides the child's status from its parent. The
            # parent receives a job_id immediately and may await, inspect, or
            # cancel that exact job. A quiet child is not presumed dead.
            tool_args["wait"] = False
