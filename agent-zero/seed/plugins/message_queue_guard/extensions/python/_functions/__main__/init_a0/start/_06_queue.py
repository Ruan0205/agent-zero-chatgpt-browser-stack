from helpers.extension import Extension
from usr.plugins.message_queue_guard.runtime import install

class QueueAdmissionStartup(Extension):
    def execute(self, **kwargs):
        # init_a0 is synchronous; an awaitable here prevents the UI starting.
        install(recover=True)
