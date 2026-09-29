# Server-authoritative UI message queue

Ordinary UI messages are committed to a per-container SQLite journal before
HTTP acknowledgement. Attachments are fsynced before the queue entry can
refer to them. The chat's `message_queue` is a UI projection, not the source
of truth. The journal never expires receipts by age or count. The first pending
message is reserved before starting, and its payload remains stored until an
Agent 0 final response is saved. A crash or model failure leaves uncertain
in-flight work blocked; the user can choose **Retomar execução** after
checking what already ran. The worker never blindly replays effects.

Waiting messages resume in order after the stack restarts when the chat is
idle, unless a previous execution is blocked or the chat is paused. Up/down
controls reorder only pending messages. Edit atomically moves one pending
message into a durable draft, restoring its full text and original attachment
references to the composer. New submissions consume the draft and create the
new queue item in one database transaction. Other chats remain isolated.

The legacy “send now” API cannot interrupt an active turn. API automation
(`api_message`), Nudge, and subordinate messages are not rewritten.

The adapter is installed at startup and by the authenticated status route. No
`agent.py` changes or model calls are needed. The WebUI extension preserves the
model-setup gate, draft on errors and the original chat ID across upload waits.
Receipt IDs persist for all accepted submissions. Different message IDs are
distinct even if their text matches. An uncertain HTTP acknowledgement can be
retried with the same ID without duplicate execution.
Browser submissions are serialized per chat, so a slow attachment upload cannot
be overtaken by the next text message from that same page.

Run `python -m unittest discover -s usr/plugins/message_queue_guard/tests -v`.
Run `node --test .../message_queue_guard/tests/*.test.mjs` for composer and
editing tests. Journal tests include abrupt child-process exit and concurrency.
Refresh the WebUI after installing. Reboots load the same always-on adapter.
