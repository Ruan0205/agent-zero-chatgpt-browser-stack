# Stack subordinate override

Creates or continues a subordinate context with inherited model/project settings.
Accepts `message`, `reset`, `context_id`, `profile`, `name` and exact `attachments`.
Returns a normal non-final tool response (`break_loop=False`) with the child ID;
recoverable child model failures do not strand the parent.

`run_subordinate` is also used by parallel delegation. For visual critique,
`visual_evidence_guard` validates explicit files (or the parent's last verified
capture), rejects missing/uniform evidence, includes a file/hash manifest, and
registers the child's required vision evidence. No global recent-upload lookup.
The plugin blocks unverified grading and permits reporting an evidence failure.

Side effects: child chat/history persistence and subordinate execution. Test
normal delegation, parallel visual review, missing/blank attachments and exact
vision-load receipts in the framework runtime.
