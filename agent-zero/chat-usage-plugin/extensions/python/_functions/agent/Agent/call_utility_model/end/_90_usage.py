"""Include utility/compaction calls in this chat's estimated total."""

from types import SimpleNamespace

from helpers.extension import Extension
from plugins._chat_usage.usage import record


class RecordUtilityUsage(Extension):
    def execute(self, data: dict | None = None, **kwargs):
        if not self.agent or not isinstance(data, dict):
            return
        answer = data.get("result")
        if not isinstance(answer, str) or not answer:
            return
        arguments = data.get("kwargs") if isinstance(data.get("kwargs"), dict) else {}
        positional = data.get("args") if isinstance(data.get("args"), tuple) else ()
        model = self.agent.get_utility_model()
        messages = [
            {"content": arguments.get("system", positional[1] if len(positional) > 1 else "")},
            {"content": arguments.get("message", positional[2] if len(positional) > 2 else "")},
        ]
        result = SimpleNamespace(usage={}, reasoning="", response=answer)
        record(self.agent.context, result, messages, str(getattr(model, "model_name", "")))
