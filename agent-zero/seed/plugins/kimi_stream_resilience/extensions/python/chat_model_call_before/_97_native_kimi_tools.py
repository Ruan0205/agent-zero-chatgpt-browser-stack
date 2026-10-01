"""Install native tool schemas before the atomic Kimi retry wrapper."""

from helpers.extension import Extension
from usr.plugins.kimi_stream_resilience.native_tools import configure_kimi_native_tools
from usr.plugins.kimi_stream_resilience.native_history import neutralize_initial_greeting


class NativeKimiTools(Extension):
    async def execute(self, **kwargs):
        call_data = kwargs.get("call_data")
        if isinstance(call_data, dict):
            if configure_kimi_native_tools(call_data):
                call_data["messages"] = neutralize_initial_greeting(call_data.get("messages"))
                loop_data = getattr(self.agent, "loop_data", None)
                params = getattr(loop_data, "params_temporary", None)
                if isinstance(params, dict):
                    params["kimi_native_turn"] = True
