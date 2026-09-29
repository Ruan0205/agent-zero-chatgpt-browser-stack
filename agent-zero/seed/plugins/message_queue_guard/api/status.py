from helpers.api import ApiHandler
from agent import AgentContext
from usr.plugins.message_queue_guard.runtime import install

class Status(ApiHandler):
    async def process(self, input, request):
        install()
        context = AgentContext.get(input.get('context', ''))
        return {'running':bool(context and context.is_running())}
