#!/bin/sh
set -eu

python3 /opt/a0-vscode/exec_server.py &
exec /usr/bin/entrypoint.sh \
  --bind-addr 0.0.0.0:8080 \
  --auth none \
  --disable-workspace-trust \
  --disable-telemetry \
  --disable-update-check \
  /workspace/chats
