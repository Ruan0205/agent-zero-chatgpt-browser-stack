"""Last-chance reference conversion for ChatGPT Browser model calls."""

from helpers.extension import Extension
from usr.plugins.browser_session_bridge.file_references import replace_images, replace_messages

_replace = replace_images


class BrowserFileReferences(Extension):
    async def execute(self, **kwargs):
        call_data = kwargs.get("call_data", {})
        model = call_data.get("model")
        if not model or "chatgpt-browser" not in str(getattr(model, "model_name", "")):
            return
        messages = call_data.get("messages")
        if not isinstance(messages, list):
            return
        call_data["messages"] = replace_messages(messages)
        call_data["responses_local_input_items"] = None
