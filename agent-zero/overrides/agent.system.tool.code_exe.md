### code_execution_tool
run terminal, python, or nodejs commands
args:
- `runtime`: `terminal`, `python`, `nodejs`, or `output`
- `code`: command or script code
- `session`: terminal session id; default `0`
- `reset`: kill a session before running; `true` or `false`
rules:
- place the command or script in `code`
- use `runtime=output` to poll running work
- after two consecutive output polls with no new command bytes, STOP polling
  that session. Its `running` flag proves only that the local terminal has not
  returned a prompt. Open a different terminal session ID for one bounded,
  read-only process/log/health check; do not start the original command again.
- if that independent check proves the job is alive and advancing, wait without
  cycling through repeated model/tool calls. If it proves failure, preserve
  partial output and stop only the exact disposable job you started. If the
  state remains uncertain, report uncertainty and pause instead of looping.
- poll only if the previous tool result explicitly says the process is still running; a returned shell prompt means the command has ended, even if the final output contains no separate completion banner
- use `input` for interactive terminal prompts
- if a session seems stuck, first inspect its exact process tree and progress;
  reset only the confirmed disposable session, never a service or unrelated job
- check dependencies before running code
- replace placeholder or demo data with real values before execution
- use `print()` or `console.log()` when you need explicit output
- a separate read-only diagnostic session is allowed while a long-running
  command owns its original terminal session; do not issue conflicting writes
- treat trailing framework `[SYSTEM: ...]` info as execution status, not command output; use it to decide whether to wait, reset, rerun, or continue
- probe cwd files tools and dependencies before expensive commands
- when searching source code, use targeted paths and file globs (`rg` when available);
  exclude virtual environments, installed dependencies, caches, and compiled files
  such as `venv`, `.venv`, `node_modules`, `__pycache__`, `.pyc`, and build outputs
- avoid recursive PowerShell `Get-ChildItem` scans over a project root that contains
  dependencies; inspect the likely source file or directory first, then broaden only
  if needed and keep the search bounded
- in PowerShell scripts, never assign to automatic variables such as `$HOME`, `$PID`,
  `$PWD`, or `$PSHOME`; use task-specific variable names instead
- when Python starts a long-lived service, do not use `subprocess.run` with
  `capture_output=True` on a launcher whose children may inherit the pipes;
  redirect output to files, start without waiting for descendants, then poll a
  separate health endpoint or process state with a bounded deadline
- split long work into small commands: inspect, prepare, run, verify
- for builds installs servers training and long tests, redirect logs and poll with `runtime=output`
- for commands that can emit large output, write full stdout/stderr to files and return only compact status, PID, exit code, and a short tail; poll the same session with `runtime=output`
- in PowerShell downloads/installers, set `$ProgressPreference = 'SilentlyContinue'` unless progress output is explicitly needed; progress/CLIXML streams can flood model context
- after timeout or pause, inspect logs and processes before deciding wait reset or stop
- before costly GPU, model, compiler, or network diagnostics, set a bounded test
  deadline and write progress to a file. A silent but active process may be healthy;
  a repeated poll with no new evidence is not progress. On deadline, stop only
  PIDs verified to belong to that isolated test and change the test hypothesis
- never claim success from timeout partial output or a still-running command
- stop stale background processes you started before final response
- when exact output matters, verify file path line count bytes and content with commands
examples:
1 terminal command
~~~json
{
    "thoughts": [
        "Need to do...",
        "Need to install..."
    ],
    "headline": "Installing zip package via terminal",
    "tool_name": "code_execution_tool",
    "tool_args": {
        "runtime": "terminal",
        "session": 0,
        "reset": false,
        "code": "apt-get install zip"
    }
}
~~~

2 execute python code

~~~json
{
    "thoughts": [
        "Need to do...",
        "I can use...",
        "Then I can..."
    ],
    "headline": "Executing Python code to check current directory",
    "tool_name": "code_execution_tool",
    "tool_args": {
        "runtime": "python",
        "session": 0,
        "reset": false,
        "code": "import os\nprint(os.getcwd())"
    }
}
~~~

3 execute nodejs code

~~~json
{
    "thoughts": [
        "Need to do...",
        "I can use...",
        "Then I can..."
    ],
    "headline": "Executing Javascript code to check current directory",
    "tool_name": "code_execution_tool",
    "tool_args": {
        "runtime": "nodejs",
        "session": 0,
        "reset": false,
        "code": "console.log(process.cwd());"
    }
}
~~~

4 wait for output with long-running scripts
~~~json
{
    "thoughts": [
        "Waiting for program to finish..."
    ],
    "headline": "Waiting for long-running program to complete",
    "tool_name": "code_execution_tool",
    "tool_args": {
        "runtime": "output",
        "session": 0
    }
}
~~~

2 python snippet
~~~json
{
  "thoughts": ["A short Python check is faster than using the shell."],
  "headline": "Running Python snippet",
  "tool_name": "code_execution_tool",
  "tool_args": {
    "runtime": "python",
    "session": 0,
    "reset": false,
    "code": "import os\nprint(os.getcwd())"
  }
}
~~~

3 wait for running output
~~~json
{
  "thoughts": ["The previous command is still running, so I should poll for output."],
  "headline": "Waiting for command output",
  "tool_name": "code_execution_tool",
  "tool_args": {
    "runtime": "output",
    "session": 0
  }
}
~~~
