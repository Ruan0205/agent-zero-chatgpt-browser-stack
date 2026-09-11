### vscode
Full VS Code (code-server) workspace and integrated terminal for software work. Every Agent Zero chat has exactly one isolated workspace at `/workspace/chats/<current-chat-id>` on the server SSD. Never choose or reuse another chat's workspace.

For every request to create, modify, run, test, Dockerize, commit, or inspect a software project:
1. Call `vscode` with `action="open"` first. Its response gives the authoritative workspace path and opens that folder in the VS Code surface.
2. Use `text_editor` to create/read/patch files under that exact workspace. Never write project files in `/a0`, `/root`, `/tmp`, or another chat directory.
3. Use `vscode` with `action="terminal"` for all project shell commands, dependency installs, tests, Git, Docker builds, Docker Compose, and cleanup. The command always starts in this chat's workspace and runs in the same environment shown by the VS Code integrated terminal.
4. After editing, validate the actual file content and execute the requested tests. For Docker services, verify container state and HTTP response rather than assuming `docker compose up` succeeded.
5. Use the Agent Zero `browser` tool—not ChatGPT's browser—to open and visually validate the running application when requested. Load the `browser-automation` skill first if its instructions require it.
6. For Git commits, configure a local repository identity if necessary, inspect `git status`, commit only this chat's project files, and verify the resulting commit with `git log -1`.
7. If the user requests teardown, run Docker Compose down/remove commands through `vscode` terminal, verify the container and endpoint are gone, then remove only the contents of this chat's workspace. Never delete `/workspace/chats` or another chat directory.

Actions:
- `open`: create/select this chat workspace and open it in VS Code.
- `status`: report the workspace and file count without opening the UI.
- `terminal`: execute `command` in this chat workspace. Optional `timeout` is 1–600 seconds.

Examples:
```json
{"action":"open"}
```
```json
{"action":"terminal","command":"pwd && git status --short","timeout":120}
```
