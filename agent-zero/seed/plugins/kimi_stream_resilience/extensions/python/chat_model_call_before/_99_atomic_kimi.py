"""Use an atomic, retryable turn for the Kimi provider only."""

from helpers.extension import Extension
from usr.plugins.kimi_stream_resilience.resilience import KimiRetryModel, is_kimi


class AtomicKimiTurn(Extension):
    async def execute(self, **kwargs):
        call_data = kwargs.get("call_data")
        if not isinstance(call_data, dict):
            return
        model = call_data.get("model")
        if not model or not is_kimi(model) or isinstance(model, KimiRetryModel):
            return

        def on_retry(attempt, delay, error):
            self.agent.context.log.log(
                type="warning",
                heading="Kimi: resposta incompleta, tentando novamente",
                content=(
                    f"Tentativa {attempt} de 3; aguardando {delay}s. "
                    f"Tipo: {type(error).__name__}. Nenhuma ferramenta foi executada."
                ),
            )

        call_data["model"] = KimiRetryModel(model, on_retry=on_retry)
