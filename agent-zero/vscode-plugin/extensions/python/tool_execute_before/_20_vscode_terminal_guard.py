import base64
import json
import shlex
from pathlib import Path

from helpers.extension import Extension


class VscodeTerminalGuard(Extension):
    """Keep legacy terminal calls inside the VS Code chat workspace.

    Some models are strongly trained to select code_execution_tool even after
    opening VS Code. Once this chat has explicitly opened its VS Code workspace,
    transparently execute terminal commands in the code-server sidecar instead.
    """

    async def execute(self, tool_name: str = "", tool_args: dict | None = None, **_kwargs):
        if not self.agent or not isinstance(tool_args, dict):
            return
        if tool_name == "text_editor":
            self._normalize_text_editor_patch(tool_args)
            return
        if tool_name != "code_execution_tool":
            return
        workspace_exists = (Path("/workspace/chats") / str(self.agent.context.id)).is_dir()
        if not self.agent.get_data("_vscode_workspace_active") and not workspace_exists:
            return
        if str(tool_args.get("runtime") or "").strip().lower() != "terminal":
            return

        context_id = str(self.agent.context.id)
        command = str(tool_args.get("code") or "")
        timeout = max(1, min(int(tool_args.get("timeout") or 120), 600))
        payload = base64.b64encode(json.dumps({
            "context_id": context_id,
            "command": command,
            "timeout": timeout,
        }).encode("utf-8")).decode("ascii")
        runner = (
            "import base64,json,os,sys,urllib.request;"
            "p=base64.b64decode(sys.argv[1]);"
            "q=urllib.request.Request('http://agent-zero-vscode:8765/exec',data=p,"
            "headers={'Authorization':'Bearer '+os.environ['VSCODE_EXEC_TOKEN'],"
            "'Content-Type':'application/json'},method='POST');"
            "d=json.loads(urllib.request.urlopen(q,timeout=630).read());"
            "sys.stdout.write(d.get('stdout',''));sys.stderr.write(d.get('stderr',''));"
            "sys.exit(int(d.get('exit_code',1)))"
        )
        tool_args["code"] = (
            f"/opt/venv-a0/bin/python -c {shlex.quote(runner)} {shlex.quote(payload)}"
        )
        tool_args["reset"] = True

    @staticmethod
    def _normalize_text_editor_patch(tool_args: dict) -> None:
        if str(tool_args.get("action") or "").lower() != "patch":
            return
        if "find" in tool_args and "replace" in tool_args:
            tool_args["old_text"] = tool_args.pop("find")
            tool_args["new_text"] = tool_args.pop("replace")
            return
        edits = tool_args.get("edits")
        if not isinstance(edits, list) or len(edits) != 1 or not isinstance(edits[0], dict):
            return
        edit = edits[0]
        if "find" in edit and "replace" in edit:
            tool_args.pop("edits", None)
            tool_args["old_text"] = edit["find"]
            tool_args["new_text"] = edit["replace"]
        elif isinstance(edit.get("from"), str) and isinstance(edit.get("to"), str):
            tool_args.pop("edits", None)
            tool_args["old_text"] = edit["from"]
            tool_args["new_text"] = edit["to"]
        elif isinstance(edit.get("from"), int) and "text" in edit and "content" not in edit:
            edit["content"] = edit.pop("text")
