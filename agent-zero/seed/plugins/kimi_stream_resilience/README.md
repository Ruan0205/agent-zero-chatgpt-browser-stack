# Kimi response resilience

This user plugin applies only to `kimi-k3`. It requests each model turn as a complete, non-streaming response so an interrupted provider stream cannot leave Agent Zero with a partial tool call. Transient connection, incomplete-response, empty-response, timeout, 5xx, and rate-limit failures retry the **model request only**, at most four calls total. Rate-limit backoff starts at 30 seconds. Permanent authentication and other 4xx errors are not retried.

After exhaustion the plugin reports one controlled error and prevents Agent Zero's generic whole-turn retry from replaying earlier actions. It does not alter the `chatgpt-browser` model or automatically resume a user chat. The trade-off is that Kimi's response appears only when its full model request completes; Agent Zero's calling indicator remains visible meanwhile.

A completed provider reply containing reasoning alone is not an actionable
answer. It is handled inside the same bounded LLM-only retry policy, not passed
to the agent loop as a successful turn. A real response or native function call
is required. An in-flight generation is never retried just because it is slow.

Complete DSML tool envelopes occasionally leaked as content by Kimi providers
are adapted to framework-native function items before history and dispatch.
Arguments, whitespace, all calls in order, usage and terminal metadata are
preserved. Ambiguous, duplicate, invalid typed, nested or incomplete envelopes
are rejected as a whole; code is never executed by the parser. Existing native
calls, plain JSON calls, reasoning and terminal cutoffs are not treated as DSML.
A redundant argument envelope is unwrapped exactly once only when it contains
precisely tool_name/tool_args, names the invoked tool and holds an object. Mixed,
conflicting, nested and duplicate-keyed arguments are rejected before dispatch.
This applies to DSML, native calls and complete textual JSON. A quoted DSML
example inside valid JSON remains data, not an executable call.
Standard tool policy and the repair approval guard still apply at dispatch.
The narrow documented `tasks.list_tasks` alias is normalized in DSML, native
function items and complete text JSON. A Kimi system-prompt hook restates the
canonical protocol and alias semantics on every main, subordinate and repair
turn. It never grants permissions or invents tools.

When a completed Kimi reply is rejected as `InvalidDSML`, the next bounded
LLM-only attempt receives a short, ephemeral protocol correction. It says the
rejected call was **not** executed and asks for a native call or one complete
flat `tool_name`/`tool_args` JSON object. The original chat history is not
modified and no completed tool action is replayed. Connection and rate-limit
retries do not receive this protocol correction. Unknown tool aliases, partial
DSML, conflicting arguments and nested envelopes remain rejected rather than
being guessed or silently executed.

Checks: run `python -m unittest discover -s tests -p test_*.py` from this directory. In a running Agent Zero container, `PYTHONPATH=/a0 python /a0/usr/plugins/kimi_stream_resilience/tests/check_activation.py` verifies both extension hooks. `live_probe.py` makes one opt-in, non-streaming call to the configured provider without printing credentials.
