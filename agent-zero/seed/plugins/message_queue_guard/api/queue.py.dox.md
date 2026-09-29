# Durable queue API

Authenticated, CSRF-protected POST, using the standard ApiHandler defaults.
Requires a real chat context. Snapshot returns pending previews, active state
and a draft ID. Edit atomically transfers only a pending message into one
server-side draft per chat; draft returns full text and original attachment
references. Save-draft accepts only a subset of that draft's attachments.
Move swaps adjacent waiting items under a SQLite transaction. Send reserves
without deleting and refuses active/paused/uncertain executions. Remove changes
only waiting messages. Conflicting consumed IDs return 409, never best-effort
overwriting. No credentials or arbitrary file contents are returned.

Test persistence, crash recovery, isolated contexts, edit-vs-consume races,
attachment ownership, idempotency, and frontend restore/resubmission.
