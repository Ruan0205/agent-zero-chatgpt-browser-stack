### vscode
Full VS Code (code-server) workspace and integrated terminal for software work. Each Agent Zero chat has one isolated workspace at `/workspace/chats/<current-chat-id>` on the server SSD. Never choose or reuse another chat's workspace.

For every request to create, modify, run, test, Dockerize, commit, or inspect a software project:
1. Call `vscode` with `action="open"` first. The result gives the authoritative workspace and opens the folder in the VS Code panel.
2. Use `text_editor` for file creation, reads, and patches under that exact workspace.
3. Use `vscode` with `action="terminal"` for project commands, dependency installation, tests, Git, Docker, Docker Compose, and cleanup. Commands start in the current chat workspace and execute in the same environment shown in VS Code.
   This is mandatory: after opening VS Code, never use `code_execution_tool` for a project shell command. The legacy terminal is a different container, does not share this chat workspace, and may not contain Docker. If a command must affect files shown in VS Code, its tool name must be `vscode` and its action must be `terminal`.
4. Verify file contents and actual command results. For Docker applications, verify both container state and the HTTP response.
   Text files in this workspace are normalized to mode 0644 so non-root build/runtime containers can read them. For copied web assets, prefer `COPY --chmod=644` when the Dockerfile syntax supports it.
5. When browser validation is requested, use the Agent Zero `browser` tool to open the real application and inspect the rendered result.
6. For teardown, stop/remove only resources created by this chat, verify they are gone, then remove only the contents of the current chat workspace.

Execution order is a hard dependency, not a suggestion. For a software task with numbered or sequential steps, never jump to a later validation step while an earlier build step is incomplete. In particular, do not load a browser skill or call `browser` for a local application until all of these facts have been observed in tool results from the current run: the VS Code workspace was opened, the requested files were created, the application start command exited successfully, the expected container/process is running, and an HTTP readiness check succeeded. A URL named in the user's request is not evidence that the service already exists. If browser validation returns connection refused, resume from the earliest incomplete build/start step instead of retrying the same unopened URL. Do not claim completion after a provider, tool, rate-limit, or timeout error.

Actions and arguments:
- `open`: no other arguments.
- `status`: no other arguments.
- `terminal`: requires `command`; optional `timeout` from 1 to 600 seconds.

Examples:
~~~json
{
  "thoughts": ["I need the isolated VS Code workspace before editing."],
  "headline": "Opening the chat workspace in VS Code",
  "tool_name": "vscode",
  "tool_args": {"action": "open"}
}
~~~
~~~json
{
  "thoughts": ["I need to test and commit inside the VS Code environment."],
  "headline": "Testing in the VS Code terminal",
  "tool_name": "vscode",
  "tool_args": {
    "action": "terminal",
    "command": "pwd && docker compose version && git status --short",
    "timeout": 120
  }
}
~~~
