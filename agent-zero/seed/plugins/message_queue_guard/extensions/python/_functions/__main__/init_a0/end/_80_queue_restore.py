from helpers.extension import Extension
from usr.plugins.message_queue_guard.durable import ensure, sync, finish, start_recovery_worker

class RestoreDurableQueue(Extension):
    def execute(self, **kwargs):
        from agent import AgentContext
        for context in AgentContext.all():
            ensure(context); finish(context); sync(context)
        start_recovery_worker()
