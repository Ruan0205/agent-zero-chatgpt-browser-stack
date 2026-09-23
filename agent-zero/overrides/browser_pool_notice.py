import hmac
import os

from helpers.api import ApiHandler, Request, Response


class BrowserPoolNotice(ApiHandler):
    """Publish browser-pool scaling events in the originating Agent Zero chat."""

    @classmethod
    def requires_auth(cls) -> bool:
        return False

    @classmethod
    def requires_csrf(cls) -> bool:
        return False

    @classmethod
    def requires_api_key(cls) -> bool:
        return False

    async def process(self, input: dict, request: Request) -> dict | Response:
        expected = os.environ.get("BROWSER_POOL_NOTICE_TOKEN", "")
        supplied = request.headers.get("X-Browser-Pool-Token", "")
        if not expected or not supplied or not hmac.compare_digest(expected, supplied):
            return Response('{"error":"unauthorized"}', status=401, mimetype="application/json")

        context_id = str(input.get("context_id", "")).strip()
        message = str(input.get("message", "")).strip()
        if not context_id:
            return Response('{"error":"context_id is required"}', status=400, mimetype="application/json")
        allowed = {
            "subindo uma nova instancia de navegador",
            "image_upload_wait",
            "image_upload_done",
            "image_upload_failed",
        }
        if message not in allowed:
            return Response('{"error":"invalid message"}', status=400, mimetype="application/json")

        context = self.use_context(context_id, create_if_not_exists=False)
        if not context:
            return Response('{"error":"context not found"}', status=404, mimetype="application/json")

        if message == "image_upload_wait":
            context.log.set_progress("esperando a imagem carregar no navegador remoto")
        elif message == "image_upload_done":
            context.log.set_progress("A0: Calling LLM...")
        elif message == "image_upload_failed":
            context.log.set_progress("a imagem não carregou", active=False)
        else:
            context.log.log(type="info", heading="Browser pool", content=message)
        return {"ok": True, "context_id": context_id}
