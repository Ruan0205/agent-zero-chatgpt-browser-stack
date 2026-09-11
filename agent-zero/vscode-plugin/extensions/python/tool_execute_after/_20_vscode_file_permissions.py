import os
from pathlib import Path

from helpers.extension import Extension


class VscodeFilePermissions(Extension):
    """Make code files created by Agent Zero readable in build containers."""

    async def execute(self, tool_name: str = "", **_kwargs):
        if not self.agent or tool_name != "text_editor":
            return
        if not self.agent.get_data("_vscode_workspace_active"):
            return
        current_tool = getattr(getattr(self.agent, "loop_data", None), "current_tool", None)
        args = getattr(current_tool, "args", None)
        if not isinstance(args, dict) or str(args.get("action") or "").lower() not in {"write", "patch"}:
            return
        candidate = Path(str(args.get("path") or "")).resolve()
        root = (Path("/workspace/chats") / str(self.agent.context.id)).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            return
        if candidate.is_file():
            os.chmod(candidate, 0o644)
