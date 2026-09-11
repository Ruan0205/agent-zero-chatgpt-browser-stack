#!/usr/bin/env bash
set -euo pipefail

state_dir="${CHATGPT_BROWSER_STATE_DIR:-/data}"
profile_dir="$state_dir/.chatgpt-poc-profile"
marker="$state_dir/.manual-login-active"

node /app/chatgpt.js --stop >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  if ! pgrep -f 'node /app/chatgpt.js --daemon-internal' >/dev/null; then break; fi
  sleep 1
done

rm -f "$profile_dir/SingletonLock" "$profile_dir/SingletonCookie" "$profile_dir/SingletonSocket"
touch "$marker"
cleanup() {
  rm -f "$marker" "$profile_dir/SingletonLock" "$profile_dir/SingletonCookie" "$profile_dir/SingletonSocket"
}
trap cleanup EXIT INT TERM

/usr/bin/google-chrome-stable \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --user-data-dir="$profile_dir" \
  'https://chatgpt.com/auth/login'
