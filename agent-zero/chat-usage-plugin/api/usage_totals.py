"""Authenticated, read-only rollup for the welcome-page usage dashboard."""

import asyncio
from pathlib import Path

from agent import AgentContext
from helpers.api import ApiHandler, Request, Response
from plugins._chat_usage.totals import current_usage


class UsageTotals(ApiHandler):
    async def process(self, input: dict, request: Request) -> dict | Response:
        return await asyncio.to_thread(
            current_usage,
            Path("/a0/usr/chats"),
            AgentContext.all(),
        )
