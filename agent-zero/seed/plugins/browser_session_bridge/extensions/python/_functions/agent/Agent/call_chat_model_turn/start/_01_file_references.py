"""Replace image bytes before Agent Zero builds native Responses input."""

from helpers.extension import Extension
from usr.plugins.browser_session_bridge.file_references import replace_messages


class EarlyBrowserFileReferences(Extension):
    def execute(self, data: dict | None = None, **kwargs):
        if not self.agent or not isinstance(data, dict):
            return
        model = self.agent.get_chat_model()
        if not model or "chatgpt-browser" not in str(getattr(model, "model_name", "")):
            return
        arguments = data.get("kwargs")
        if isinstance(arguments, dict) and isinstance(arguments.get("messages"), list):
            arguments["messages"] = replace_messages(arguments["messages"])
