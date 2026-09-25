### tasks
Compatibility alias for `call_subordinate`. Use `tool_name: "tasks"` with
`tool_args.action: "list_tasks"` and a non-empty `message` to create or
continue a subordinate agent. `message`, `profile`, `reset`, `context_id`,
`name`, and `attachments` have the same meaning as in `call_subordinate`.
The result and child-context behavior are identical. For new calls, prefer
`call_subordinate`; this alias exists so an already-generated
`tasks.list_tasks` call does not fail.

This does NOT list scheduled tasks. To list saved or scheduled tasks, use
`scheduler` with `action: "list_tasks"`.
