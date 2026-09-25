"""Compatibility alias for subordinate delegation.

Older browser-model turns sometimes use ``tasks.list_tasks`` when asked to
delegate. Keep that exact call working without changing the canonical
``call_subordinate`` implementation or its child-session semantics.
"""

from helpers.errors import RepairableException
from tools import call_subordinate


class Tasks(call_subordinate.Delegation):
    async def execute(self, action="list_tasks", message="", reset="", context_id="", **kwargs):
        if str(action or "").strip() != "list_tasks":
            raise RepairableException(
                "tasks supports action='list_tasks' for subordinate delegation; "
                "use scheduler for saved or scheduled task listings."
            )
        if not str(message or "").strip():
            raise RepairableException(
                "tasks.list_tasks delegates work and requires a non-empty message. "
                "For saved task listings use scheduler with action='list_tasks'."
            )
        return await super().execute(
            message=message,
            reset=reset,
            context_id=context_id,
            **kwargs,
        )
