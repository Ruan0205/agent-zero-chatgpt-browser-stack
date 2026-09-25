import os
import re
from pathlib import Path

from helpers.extension import Extension


class RequireRepairApproval(Extension):
    """Fail closed for tools capable of modifying the host before approval.

    The file is written only by the authenticated main Agent Zero audit API.
    The repair container sees this directory read-only. Approval is scoped to
    one repair context and removed after that repair turn completes.
    """

    async def execute(self, tool_name: str = "", **kwargs) -> None:
        if tool_name in {"response", "document_query"}:
            return
        context_id = str(getattr(getattr(self.agent, "context", None), "id", ""))
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", context_id):
            raise PermissionError("Contexto de reparo inválido: ferramentas bloqueadas.")
        control = Path(os.environ.get("REPAIR_CONTROL_DIR", "/repair-control"))
        if not (control / f"{context_id}.approved").is_file():
            raise PermissionError(
                "Reparo ainda não aprovado pelo usuário. Faça apenas o diagnóstico "
                "e peça autorização explícita no painel Chats com erro."
            )
