"""Mark a chat unread only after an actual finished response."""

from helpers.extension import Extension
from plugins._browser_incidents import completion_state


class FinalReplyReceipt(Extension):
    async def execute(self, **kwargs):
        if not self.agent or self.agent.number != 0:
            return
        context = self.agent.context
        with context.log._lock:
            recent = list(context.log.logs)
        for item in reversed(recent):
            if item.type == "response" and (item.kvps or {}).get("finished") is True \
                    and str(item.content or "").strip():
                completion_state.completed(context.id, item.no, str(item.content))
                break
