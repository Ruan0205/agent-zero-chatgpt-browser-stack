from helpers.extension import Extension


class VscodeTerminalGuard(Extension):
    """Normalize editor aliases without changing terminal transport.

    code_execution_tool/input share a persistent PTY in Agent Zero. Routing the
    former through VS Code's one-shot HTTP executor discards stdin and shell
    state and breaks input/output polling. VS Code execution remains explicit
    through vscode(action=terminal); both environments mount /workspace.
    """

    async def execute(self, tool_name: str = "", tool_args: dict | None = None, **_kwargs):
        if tool_name == "text_editor" and isinstance(tool_args, dict):
            self._normalize_text_editor_patch(tool_args)

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
