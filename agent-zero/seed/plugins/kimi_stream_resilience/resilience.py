"""Per-turn Kimi response guard; never replays an already completed tool call."""

from __future__ import annotations

import asyncio
import json
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
EMPTY_RESPONSE_CORRECTION = (
    "A resposta anterior chegou sem conteúdo final e sem chamada de ferramenta; "
    "nenhuma ferramenta foi executada. Continue o pedido original. Emita a "
    "resposta final no campo content ou uma chamada de ferramenta nativa e "
    "completa. Não envie apenas reasoning/pensamento."
)
MALFORMED_RESPONSE_CORRECTION = (
    "A resposta anterior continha apenas pensamento/estrutura incompleta e "
    "nenhuma ferramenta foi executada. Continue do estado atual, sem repetir "
    "ações já realizadas. Envie um único objeto JSON completo na resposta, "
    "com thoughts, headline, tool_name e tool_args (objeto). Para responder ao "
    "usuário, chame a ferramenta response. Não pare em thoughts nem use "
    "cercas de código."
)
NATIVE_RESPONSE_CORRECTION = (
    "A resposta anterior não foi uma chamada nativa da API e nenhuma ferramenta "
    "foi executada. O inventário de funções está no parâmetro tools desta "
    "requisição. Escolha uma função nativa, passe argumentos JSON completos e "
    "use response como função nativa para concluir; não escreva tool_name, "
    "tool_args, DSML ou JSON de ferramenta no texto."
)


class KimiRetriesExhausted(Exception):
    """The provider remained unavailable after bounded, safe LLM-only retries."""


class EmptyModelResponse(RuntimeError):
    """Safe metadata for a completed provider turn without actionable output."""

    def __init__(self, result: Any) -> None:
        capability = getattr(result, "capability", None) or {}
        finish_reason = capability.get("finish_reason") if isinstance(capability, dict) else None
        reasoning_chars = len(getattr(result, "reasoning", "") or "")
        output_items = len(getattr(result, "output_items", None) or [])
        super().__init__(
            "empty model response"
            f" (finish_reason={finish_reason!r}, reasoning_chars={reasoning_chars},"
            f" output_items={output_items})"
        )


class MalformedModelResponse(RuntimeError):
    """A model reply stopped before providing an Agent Zero tool request."""

    def __init__(self, result: Any) -> None:
        capability = getattr(result, "capability", None) or {}
        finish_reason = capability.get("finish_reason") if isinstance(capability, dict) else None
        response_chars = len(getattr(result, "response", "") or "")
        reasoning_chars = len(getattr(result, "reasoning", "") or "")
        output_items = len(getattr(result, "output_items", None) or [])
        super().__init__(
            "JSON thoughts without a tool request"
            f" (finish_reason={finish_reason!r}, response_chars={response_chars},"
            f" reasoning_chars={reasoning_chars}, output_items={output_items})"
        )


class NonNativeModelResponse(RuntimeError):
    """Provider ignored tool_choice=required and wrote text instead."""

    def __init__(self, result: Any, tool_count: int) -> None:
        self.response_preview = str(getattr(result, "response", "") or "")[:240]
        capability = getattr(result, "capability", None) or {}
        finish_reason = capability.get("finish_reason") if isinstance(capability, dict) else None
        super().__init__(
            "provider did not return a native tool call"
            f" (finish_reason={finish_reason!r},"
            f" response_chars={len(getattr(result, 'response', '') or '')},"
            f" tool_count={tool_count})"
        )


class InvalidNativeArguments(RuntimeError):
    """A native call omitted fields required by the advertised schema."""


def validate_native_arguments(result: Any, tools: Any) -> None:
    """Reject invalid calls before Agent Zero can execute or persist them."""
    schemas = {
        item["function"]["name"]: item["function"].get("parameters", {})
        for item in tools if isinstance(item, dict)
        and isinstance(item.get("function"), dict)
        and isinstance(item["function"].get("name"), str)
    }
    for call in getattr(result, "function_calls", None) or []:
        name = getattr(call, "name", None)
        arguments = getattr(call, "arguments", None)
        if isinstance(call, dict):
            name = call.get("name") or call.get("function", {}).get("name")
            arguments = call.get("arguments", arguments)
        if name not in schemas:
            raise InvalidNativeArguments(f"unknown native tool: {name}")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except ValueError as error:
                raise InvalidNativeArguments(f"invalid JSON arguments for {name}") from error
        if not isinstance(arguments, dict):
            raise InvalidNativeArguments(f"arguments for {name} are not an object")
        schema = schemas[name]
        for key in schema.get("required", []):
            value = arguments.get(key)
            if value is None or value == "" or value == []:
                raise InvalidNativeArguments(f"missing required argument {name}.{key}")


def is_thoughts_only_response(result: Any) -> bool:
    """Narrow guard for Kimi's observed JSON-thoughts-only cutoff.

    Other nonempty replies keep the existing dispatch path; this does not guess
    tool arguments or turn arbitrary prose into a tool call.
    """
    if getattr(result, "function_calls", None):
        return False
    content = getattr(result, "response", None)
    if not isinstance(content, str):
        return False
    stripped = content.strip()
    if not stripped.startswith("{"):
        return False
    try:
        data = json.loads(stripped)
    except (ValueError, TypeError):
        return stripped.startswith('{"thoughts"') and '"tool_name"' not in stripped
    return (
        isinstance(data, dict)
        and "thoughts" in data
        and not any(key in data for key in ("tool_name", "tool", "actions"))
    )


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
        "malformedmodelresponse",
        "nonnativemodelresponse",
        "invalidnativearguments",
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
        native_turn: Callable[[Any, dict[str, Any]], Awaitable[Any]] | None = None,
    ) -> None:
        self._model = model
        self._on_retry = on_retry
        self._sleep = sleep
        self._native_turn = native_turn

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
        model_kwargs = getattr(self._model, "kwargs", {})
        native_required = (
            isinstance(model_kwargs, dict)
            and bool(model_kwargs.get("tools"))
            and model_kwargs.get("tool_choice") == "required"
        )
        # Agent Zero's Model.unified_turn inserts system/user messages into the
        # supplied list in place. Give every provider attempt a fresh copy;
        # otherwise retries duplicate those messages (and can grow the prompt).
        original_messages = list(request.get("messages") or [])
        for attempt in range(len(RETRY_DELAYS) + 1):
            try:
                attempt_request = {**request, "messages": list(original_messages)}
                if native_required:
                    if args:
                        raise TypeError("Kimi native transport requires keyword turn arguments")
                    if self._native_turn is None:
                        if __package__:
                            from .native_transport import direct_kimi_turn
                        else:
                            from native_transport import direct_kimi_turn
                        native_turn = direct_kimi_turn
                    else:
                        native_turn = self._native_turn
                    result = await native_turn(self._model, attempt_request)
                else:
                    result = await self._model.unified_turn(*args, **attempt_request)
                # Lazy import keeps standalone resilience tests dependency-free.
                if __package__:
                    from .dsml import normalize_result
                else:  # Dependency-free standalone regression runner.
                    from dsml import normalize_result
                result = normalize_result(result)
                if native_required and not getattr(result, "function_calls", None):
                    if __package__:
                        from .native_transport import promote_complete_text_call
                    else:
                        from native_transport import promote_complete_text_call
                    result = promote_complete_text_call(result, model_kwargs["tools"])
                if native_required and (
                    not getattr(result, "function_calls", None)
                    or (getattr(result, "capability", None) or {}).get("kimi_dsml_normalized")
                ):
                    raise NonNativeModelResponse(result, len(model_kwargs["tools"]))
                if native_required:
                    validate_native_arguments(result, model_kwargs["tools"])
                if not has_answer(result):
                    raise EmptyModelResponse(result)
                if is_thoughts_only_response(result):
                    raise MalformedModelResponse(result)
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
                feedback = (NATIVE_RESPONSE_CORRECTION
                            if native_required and (is_invalid_dsml(error) or isinstance(error, (NonNativeModelResponse, InvalidNativeArguments)))
                            else DSML_CORRECTION if is_invalid_dsml(error)
                            else EMPTY_RESPONSE_CORRECTION
                            if isinstance(error, EmptyModelResponse)
                            else MALFORMED_RESPONSE_CORRECTION
                            if isinstance(error, MalformedModelResponse) else None)
                if feedback:
                    # A rejected/empty model result has not reached tool
                    # dispatch. Feedback is ephemeral, never persistent history.
                    request["user_message"] = (
                        (original_user_message + "\n\n") if original_user_message else ""
                    ) + feedback
                delay = (RATE_LIMIT_DELAYS if is_rate_limit(error) else RETRY_DELAYS)[attempt]
                if self._on_retry:
                    self._on_retry(attempt + 1, delay, error)
                await self._sleep(delay)
