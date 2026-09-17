import asyncio
import json
import urllib.request

from helpers.api import ApiHandler, Request, Response


class PreviewRoute(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict | Response:
        context_id = str(input.get('context_id') or '').strip()
        if not context_id or len(context_id) > 160 or not all(c.isalnum() or c in '_-' for c in context_id):
            return {'status': 'unmapped'}

        def lookup():
            payload = json.dumps({'context_id': context_id}).encode()
            req = urllib.request.Request(
                'http://chatgpt-browser-agent:8000/v1/preview-route',
                payload,
                {'Content-Type': 'application/json'},
            )
            with urllib.request.urlopen(req, timeout=40) as response:
                return json.load(response)

        try:
            return await asyncio.to_thread(lookup)
        except Exception:
            return {'status': 'unavailable'}
