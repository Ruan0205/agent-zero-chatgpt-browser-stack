"""Surface Kimi exhaustion once, without the generic critical-error replay."""

from helpers.errors import HandledException
from helpers.extension import Extension
from usr.plugins.kimi_stream_resilience.resilience import KimiRetriesExhausted


class HandleKimiExhaustion(Extension):
    async def execute(self, data: dict | None = None, **_kwargs):
        if not self.agent or not isinstance(data, dict):
            return
        error = data.get("exception")
        if not isinstance(error, KimiRetriesExhausted):
            return
        self.agent.context.log.log(
            type="error", heading="Kimi: resposta incompleta", content=str(error)
        )
        data["exception"] = HandledException(error)
