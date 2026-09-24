"""Resume a stopped browser-model chat without interrupting live work."""

from helpers.api import ApiHandler, Request, Response


def _uses_browser_model(context) -> bool:
    override = context.get_data("chat_model_override") or {}
    chat = override.get("chat", {}) if isinstance(override, dict) else {}
    if isinstance(chat, dict) and chat.get("name"):
        return str(chat["name"]).startswith("chatgpt-browser")
    try:
        from plugins._model_config.helpers.model_config import get_config

        configured = get_config(agent=context.agent0) or {}
        main = configured.get("chat_model", {})
        return isinstance(main, dict) and str(main.get("name", "")).startswith("chatgpt-browser")
    except Exception:
        return False


class Nudge(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict | Response:
        ctxid = input.get("ctxid", "")
        if not ctxid:
            raise ValueError("No context id provided")

        context = self.use_context(ctxid)
        if not _uses_browser_model(context):
            message = "Nudge não se aplica: este chat não usa o chatgpt-browser."
            status = "not_browser"
        elif context.is_running():
            # The old endpoint killed the live Agent Zero task, including an
            # active browser request. That could duplicate a user submission.
            message = "Nudge ignorado: o chatgpt-browser ainda está processando."
            status = "still_running"
        else:
            context.nudge()
            message = "Chatgpt-browser retomado após a execução ter parado."
            status = "resumed"
            context.log.log(type="info", content=message)
        return {"message": message, "status": status, "ctxid": context.id}
