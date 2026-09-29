"""Per-turn Kimi response guard; never replays an already completed tool call."""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable


RETRY_DELAYS = (3, 8, 20)
RATE_LIMIT_DELAYS = (30, 60, 120)
DSML_CORRECTION = (
    "A resposta anterior foi rejeitada por formato de chamada de ferramenta "
    "(InvalidDSML). Nenhuma ferramenta dessa resposta foi executada. "
    "Continue o pedido original sem afirmar que a ação rejeitada ocorreu. "
    "Na próxima resposta, use uma chamada nativa da API, se disponível; "
    "caso contrário, envie um único JSON completo com tool_name e tool_args "
    "(objeto de argumentos planos), sem DSML/XML, cercas de código ou texto "
    "adicional. Não inclua tool_name/tool_args dentro de tool_args. "
    "Se não precisar de ferramenta, responda normalmente."
)


class KimiRetriesExhausted(Exception):
    """The provider remained unavailable after bounded, safe LLM-only retries."""


def is_kimi(model: Any) -> bool:
    return "kimi-k3" in str(getattr(model, "model_name", "")).casefold()


def is_retryable(error: Exception) -> bool:
    code = getattr(error, "status_code", None)
    if isinstance(code, int):
        if code in (408, 429) or code >= 500:
            return True
        if 400 <= code < 500:
            return False
    message = f"{type(error).__name__}: {error}".casefold()
    if any(part in message for part in ("unauthorized", "invalid api key", "authentication", "insufficient balance")):
        return False
    return any(part in message for part in (
        "midstreamfallbackerror", "apiconnectionerror", "apitimeouterror",
        "incomplete response", "unparseable", "无法解析", "不完整的响应",
        "connection reset", "timeout", "timed out", "too many requests",
        "rate limit", "ratelimiterror", "toomanyrequests",
        "service unavailable", "empty model response",
        "invaliddsml",
    ))


def is_rate_limit(error: Exception) -> bool:
    return getattr(error, "status_code", None) == 429 or any(
        part in f"{type(error).__name__}: {error}".casefold()
        for part in ("too many requests", "rate limit", "ratelimiterror", "toomanyrequests")
    )


def is_invalid_dsml(error: Exception) -> bool:
    return type(error).__name__.casefold() == "invaliddsml" or "invaliddsml" in str(error).casefold()


def has_answer(result: Any) -> bool:
    return bool(
        getattr(result, "response", None)
        or getattr(result, "function_calls", None)
    )


class KimiRetryModel:
    """Keep the original model configuration but make this turn atomic.

    Disabling callbacks makes Agent Zero use a complete non-streaming response.
    No partial tool-call JSON can reach its executor before the provider has
    finished. Retries therefore resend only the LLM request, not tools.
    """

    def __init__(
        self,
        model: Any,
        on_retry: Callable[[int, float, Exception], None] | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._model = model
        self._on_retry = on_retry
        self._sleep = sleep

    def __getattr__(self, name: str) -> Any:
        return getattr(self._model, name)

    async def unified_turn(self, *args: Any, **kwargs: Any) -> Any:
        request = dict(kwargs)
        request["reasoning_callback"] = None
        request["response_callback"] = None
        request["tokens_callback"] = None
        # Own retries here so a provider failure cannot cause nested retries.
        request["a0_retry_attempts"] = 0
        original_user_message = request.get("user_message") or ""
        for attempt in range(len(RETRY_DELAYS) + 1):
            try:
                result = await self._model.unified_turn(*args, **request)
                # Lazy import keeps standalone resilience tests dependency-free.
                if __package__:
                    from .dsml import normalize_result
                else:  # Dependency-free standalone regression runner.
                    from dsml import normalize_result
                result = normalize_result(result)
                if not has_answer(result):
                    raise RuntimeError("empty model response")
                return result
            except Exception as error:
                if not is_retryable(error):
                    raise
                if attempt >= len(RETRY_DELAYS):
                    raise KimiRetriesExhausted(
                        "O Kimi não entregou uma resposta íntegra após 4 tentativas. "
                        f"Última falha: {type(error).__name__}. Nenhuma ferramenta "
                        "deste turno foi executada."
                    ) from error
                if is_invalid_dsml(error):
                    # A rejected model result has not reached tool dispatch.
                    # The correction exists only for this LLM retry and never
                    # mutates the agent's persistent conversation history.
                    request["messages"] = list(request.get("messages") or [])
                    request["user_message"] = (
                        (original_user_message + "\n\n") if original_user_message else ""
                    ) + DSML_CORRECTION
                delay = (RATE_LIMIT_DELAYS if is_rate_limit(error) else RETRY_DELAYS)[attempt]
                if self._on_retry:
                    self._on_retry(attempt + 1, delay, error)
                await self._sleep(delay)
