"""Persist cumulative token use after each completed model call."""

from helpers.extension import Extension
from plugins._chat_usage.usage import record


class RecordChatUsage(Extension):
    def execute(self, data: dict | None = None, **kwargs):
        if not self.agent or not isinstance(data, dict):
            return
        result = data.get("result")
        if not hasattr(result, "usage"):
            return
        arguments = data.get("kwargs") if isinstance(data.get("kwargs"), dict) else {}
        positional = data.get("args") if isinstance(data.get("args"), tuple) else ()
        messages = arguments.get("messages", positional[1] if len(positional) > 1 else [])
        model = self.agent.get_chat_model()
        model_name = str(getattr(model, "model_name", ""))
        record(self.agent.context, result, messages, model_name)
