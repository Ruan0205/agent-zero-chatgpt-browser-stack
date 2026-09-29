"""Start timing only the model call, not the whole Agent Zero task."""

from time import perf_counter

from helpers.extension import Extension


class SpeedClock(Extension):
    def execute(self, **kwargs):
        if self.agent:
            self.agent._chat_usage_call_started_at = perf_counter()
