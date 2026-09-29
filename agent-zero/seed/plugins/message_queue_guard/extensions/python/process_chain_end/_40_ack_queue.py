from helpers.extension import Extension
from usr.plugins.message_queue_guard.durable import finish

class AcknowledgeDurableQueue(Extension):
    async def execute(self, **kwargs):
        if self.agent and self.agent.number==0:
            finish(self.agent.context)
