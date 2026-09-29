# Queue guard status

Browser-authenticated, CSRF-protected POST accepting `context`; reports only
running state and installs the idempotent durable UI admission adapter in this process.
No credentials, chat text or files are returned. Normal message endpoints retain
their existing authentication. Verify busy, idle and unknown contexts.
