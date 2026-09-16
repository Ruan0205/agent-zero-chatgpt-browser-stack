import os

import aiohttp

from helpers.api import ApiHandler, Request


BRIDGE_URL = os.environ.get("META_AI_WHATSAPP_URL", "http://meta-ai-whatsapp:8788").rstrip("/")


class Pairing(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict:
        action = str(input.get("action", "status"))
        timeout = aiohttp.ClientTimeout(total=20)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                if action == "status":
                    async with session.get(f"{BRIDGE_URL}/v1/pair/status") as response:
                        data = await response.json(content_type=None)
                elif action == "start":
                    phone = "".join(ch for ch in str(input.get("phone", "")) if ch.isdigit())
                    if not 8 <= len(phone) <= 15:
                        return {
                            "success": False,
                            "error": "Informe DDI + DDD + número, usando de 8 a 15 dígitos.",
                        }
                    async with session.post(
                        f"{BRIDGE_URL}/v1/pair/start", json={"phone": phone}
                    ) as response:
                        data = await response.json(content_type=None)
                else:
                    return {"success": False, "error": f"Ação desconhecida: {action}"}
                if response.status >= 400:
                    return {
                        "success": False,
                        "error": str(data.get("error") or f"Bridge HTTP {response.status}"),
                    }
                return data
        except Exception as exc:
            return {
                "success": False,
                "error": f"A ponte Meta AI não está acessível: {exc}",
            }
