"""Recover from repeated model turns and stop deterministic tool-call loops."""

from __future__ import annotations

import json
import re
from typing import Any

from helpers.extension import Extension
from helpers.print_style import PrintStyle


STATE_KEY = "_repeated_tool_call_guard"
MAX_IDENTICAL_TOOL_REPEATS = 2
MAX_BOUNDED_POLL_REPEATS = 60
SENSITIVE_KEYS = {"authorization", "cookie", "key", "password", "secret", "token"}


def _response_signature(response: str) -> tuple[str, str] | None:
    """Return a stable signature and a safe description for a tool response."""
    try:
        payload = json.loads(response.strip())
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    tool_name = payload.get("tool_name")
    tool_args = payload.get("tool_args", {})
    if not isinstance(tool_name, str) or not tool_name:
        return None
    if not isinstance(tool_args, dict):
        tool_args = {"value": tool_args}
    canonical = json.dumps(
        {"tool_name": tool_name, "tool_args": tool_args},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    safe_args = {
        key: "[redacted]" if any(word in key.lower() for word in SENSITIVE_KEYS) else value
        for key, value in tool_args.items()
    }
    description = json.dumps(
        {"tool_name": tool_name, "tool_args": safe_args},
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    return canonical, description[:800]


def _is_bounded_status_poll(response: str) -> bool:
    """Allow a finite series of short, read-only checks of a running job."""
    try:
        payload = json.loads(response.strip())
    except (TypeError, ValueError):
        return False
    if not isinstance(payload, dict) or payload.get("tool_name") != "code_execution_tool":
        return False
    args = payload.get("tool_args")
    if not isinstance(args, dict):
        return False
    command = args.get("code")
    if not isinstance(command, str):
        return False
    wait = re.search(r"(?:^|[;\n])\s*sleep\s+(\d{1,2})\s*(?:;|\n|$)", command)
    if not wait or not 1 <= int(wait.group(1)) <= 60:
        return False
    if re.search(
        r"\b(?:rm|mv|cp|kill|pkill|restart|stop|start|write_text|unlink)\b"
        r"|\bsed\s+-i\b|\bcurl\b[^\n]*\s-X\s+(?:POST|PUT|DELETE)\b",
        command,
        re.IGNORECASE,
    ):
        return False
    # A short sleep alone is not progress; require a process/status read as well.
    return bool(re.search(r"\b(?:ps|cat|stat|test|pgrep)\b", command))


def _controlled_fallback(response: str) -> str:
    """Build a normal final response when the model ignores the recovery protocol."""
    try:
        payload = json.loads(response.strip())
    except (TypeError, ValueError):
        payload = {}
    tool_name = payload.get("tool_name") if isinstance(payload, dict) else None
    tool_args = payload.get("tool_args", {}) if isinstance(payload, dict) else {}
    action = tool_args.get("action") if isinstance(tool_args, dict) else None
    if tool_name == "browser" and action == "navigate":
        text = (
            "Não consegui avançar porque a navegação foi repetida sem alterar a página. "
            "Isso normalmente significa que o site redirecionou a sessão, exige autenticação "
            "ou bloqueou o endereço solicitado. Verifique se a sessão do navegador está "
            "autenticada e depois peça para eu continuar; não repetirei a mesma navegação."
        )
    else:
        text = (
            "Não consegui avançar porque a mesma ferramenta, com os mesmos argumentos, "
            "não produziu progresso após duas tentativas. A repetição foi encerrada sem "
            "continuar consumindo chamadas. Envie uma nova orientação ou autorize uma "
            "estratégia diferente para eu continuar."
        )
    return json.dumps(
        {
            "thoughts": ["A ação repetida não mudou o estado; devo encerrar normalmente."],
            "headline": "Ação sem progresso interrompida",
            "tool_name": "response",
            "tool_args": {"text": text},
        },
        ensure_ascii=False,
    )


class RepeatResponse(Extension):
    def execute(self, result_data: dict[str, Any] | None = None, **kwargs: Any) -> None:
        if not self.agent or not isinstance(result_data, dict):
            return
        if result_data.get("skip_default_processing"):
            return

        llm_result = result_data.get("llm_result")
        response = getattr(llm_result, "response", "")
        # v2.12 can represent a completed native tool call outside the textual
        # response. Normalize it before applying the deterministic loop guard.
        if getattr(llm_result, "function_calls", None):
            response = llm_result.function_calls_text()
        if not isinstance(response, str):
            return

        current = _response_signature(response)
        previous = _response_signature(self.agent.loop_data.last_response)
        exact_repeat = response == self.agent.loop_data.last_response
        repeated_tool = current is not None and previous is not None and current[0] == previous[0]
        if not exact_repeat and not repeated_tool:
            self.agent.loop_data.params_persistent.pop(STATE_KEY, None)
            return

        state = self.agent.loop_data.params_persistent
        iteration = self.agent.loop_data.iteration
        signature = current[0] if current is not None else f"raw:{response}"
        prior = state.get(STATE_KEY, {})
        consecutive = (
            prior.get("count", 0) + 1
            if isinstance(prior, dict)
            and prior.get("signature") == signature
            and prior.get("iteration") == iteration - 1
            else 1
        )
        state[STATE_KEY] = {
            "signature": signature,
            "iteration": iteration,
            "count": consecutive,
        }

        warning = self.agent.read_prompt("fw.msg_repeat.md")
        log_item = self.agent.loop_data.params_temporary.get("log_item_generating")
        stuck = current[1] if current is not None else "identical textual response"
        max_repeats = (
            MAX_BOUNDED_POLL_REPEATS
            if current is not None and _is_bounded_status_poll(response)
            else MAX_IDENTICAL_TOOL_REPEATS
        )
        if consecutive < max_repeats:
            if max_repeats == MAX_BOUNDED_POLL_REPEATS:
                # Let the poll run. Its tool result may change as the job finishes;
                # the finite cap still prevents a permanently stuck wait loop.
                return
            protocol = getattr(self.agent.loop_data, "protocol_temporary", None)
            if isinstance(protocol, dict):
                protocol["repeat_guard"] = (
                    f"{warning}\nBlocked call: {stuck}\n"
                    "The latest tool result is already present in history. Base the next "
                    "decision on that result and do not repeat the blocked call."
                )
            PrintStyle(font_color="orange", padding=True).print(warning)
            self.agent.context.log.log(
                type="warning",
                content=(
                    f"{self.agent.agent_name}: repeated action detected; "
                    "forcing a different strategy."
                ),
                id=log_item.id if log_item else "",
            )
            result_data["skip_default_processing"] = True
            return

        llm_result.response = _controlled_fallback(response)
        llm_result.reasoning = ""
        if hasattr(llm_result, "output_items"):
            llm_result.output_items = []
        state.pop(STATE_KEY, None)
        self.agent.context.log.log(
            type="warning",
            content=(
                f"{self.agent.agent_name}: repeated action converted to a controlled "
                f"response after {max_repeats} attempts: {stuck}"
            )
        )
