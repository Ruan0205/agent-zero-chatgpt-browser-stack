"""Recover from repeated model turns and stop deterministic tool-call loops."""

from __future__ import annotations

import json
import re
from typing import Any

from helpers.extension import Extension
from helpers.print_style import PrintStyle


STATE_KEY = "_repeated_tool_call_guard"
MAX_IDENTICAL_TOOL_REPEATS = 2
MAX_BOUNDED_POLL_REPEATS = 180
MAX_IDLE_STATUS_POLLS = 3
MAX_STALLED_STATUS_POLLS = 3
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
    # code_execution_tool returns control periodically while a long command
    # remains alive. Re-reading that exact session is progress monitoring,
    # not a repeated write or a model loop. Keep a generous finite safety cap.
    if args.get("runtime") == "output":
        session = args.get("session")
        return isinstance(session, int) and session >= 0
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


def _is_output_poll(response: str) -> bool:
    try:
        payload = json.loads(response.strip())
        args = payload.get("tool_args", {})
        return payload.get("tool_name") == "code_execution_tool" and args.get("runtime") == "output"
    except (AttributeError, TypeError, ValueError):
        return False


def _last_execution_is_running(agent: Any) -> bool:
    """Only exempt output polls while the executor explicitly reports a live job."""
    try:
        for message in reversed(agent.history.all_messages()[-6:]):
            content = message.content
            if isinstance(content, dict) and content.get("tool_name") == "code_execution_tool":
                result = str(content.get("tool_result", ""))
                return "[SYSTEM: Returning control to agent" in result and "still running" in result
    except (AttributeError, TypeError):
        pass
    return False


def _terminal_session_running(agent: Any, response: str) -> bool | None:
    """Read the executor state instead of inferring liveness from old text."""
    try:
        payload = json.loads(response.strip())
        args = payload.get("tool_args", {})
        session = int(args.get("session", 0))
        state = agent.get_data("_cet_state")
        shell = state.shells.get(session) if state else None
        return bool(shell.running) if shell is not None else None
    except (AttributeError, TypeError, ValueError, KeyError):
        return None


def _terminal_silent_polls(agent: Any, response: str) -> int:
    """Count output polls that returned no command bytes, not elapsed time."""
    if not _is_output_poll(response):
        return 0
    try:
        payload = json.loads(response.strip())
        session = str(int(payload.get("tool_args", {}).get("session", 0)))
        state = agent.loop_data.params_persistent.get("_terminal_no_progress", {})
        return int(state.get(session, 0)) if isinstance(state, dict) else 0
    except (AttributeError, TypeError, ValueError, KeyError):
        return 0


def _stalled_terminal_fallback(response: str) -> str:
    """Stop the model loop without pretending the external process finished."""
    try:
        session = int(json.loads(response.strip()).get("tool_args", {}).get("session", 0))
    except (AttributeError, TypeError, ValueError, KeyError):
        session = 0
    return json.dumps(
        {
            "thoughts": ["Repeated silent polls cannot establish process health."],
            "headline": "Monitoramento pausado sem progresso",
            "tool_name": "response",
            "tool_args": {"text": (
                f"Interrompi o ciclo de consultas sem progresso da sessão {session}. "
                "Isso não prova que o processo remoto terminou, e não o matei. "
                "É preciso verificar processo, log e serviço por uma sessão independente "
                "antes de decidir aguardar, retomar ou encerrar somente o job identificado."
            )},
        },
        ensure_ascii=False,
    )


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
        stalled_output_poll = _terminal_silent_polls(self.agent, response) >= 2
        if not exact_repeat and not repeated_tool and not stalled_output_poll:
            self.agent.loop_data.params_persistent.pop(STATE_KEY, None)
            return

        state = self.agent.loop_data.params_persistent
        iteration = self.agent.loop_data.iteration
        # Treat attempts to poll the same silent session as one loop even if
        # the model changes inconsequential arguments between calls.
        signature = (
            f"stalled-output:{json.loads(response).get('tool_args', {}).get('session', 0)}"
            if stalled_output_poll else
            current[0] if current is not None else f"raw:{response}"
        )
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
        bounded_poll = current is not None and _is_bounded_status_poll(response)
        if bounded_poll and _is_output_poll(response):
            live = _terminal_session_running(self.agent, response)
            bounded_poll = live if live is not None else _last_execution_is_running(self.agent)
        if stalled_output_poll:
            bounded_poll = False
        idle_status_poll = _is_output_poll(response) and _terminal_session_running(self.agent, response) is False
        max_repeats = (
            MAX_STALLED_STATUS_POLLS if stalled_output_poll else
            MAX_BOUNDED_POLL_REPEATS if bounded_poll else
            MAX_IDLE_STATUS_POLLS if idle_status_poll else
            MAX_IDENTICAL_TOOL_REPEATS
        )
        if consecutive < max_repeats:
            if bounded_poll or (idle_status_poll and not stalled_output_poll):
                # Let the poll run. Its tool result may change as the job finishes;
                # idle sessions are converted to an immediate status result by
                # the terminal tool extension, while finite caps prevent loops.
                return
            protocol = getattr(self.agent.loop_data, "protocol_temporary", None)
            if isinstance(protocol, dict):
                if stalled_output_poll:
                    warning = (
                        "The same terminal session has returned no command output in at least "
                        "two consecutive polls. Its running flag is not proof of progress. "
                        "Do not poll runtime=output again. In a DIFFERENT terminal session, "
                        "perform one bounded, read-only check of the exact process tree, log "
                        "and health endpoint. If the process is healthy, report that it is "
                        "still active and wait outside this tool loop. If it has failed, "
                        "preserve partial results and stop only the identified disposable job."
                    )
                elif _is_output_poll(response) and not bounded_poll:
                    warning = (
                        "The last terminal result did not explicitly report a live job. "
                        "Do not poll the same output session again. If the artifact or "
                        "exit status was already verified, continue with the next step; "
                        "otherwise inspect the process or result once using a different "
                        "read-only check."
                    )
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

        llm_result.response = (
            _stalled_terminal_fallback(response) if stalled_output_poll
            else _controlled_fallback(response)
        )
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
