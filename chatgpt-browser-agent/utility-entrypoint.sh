#!/usr/bin/env bash
set -euo pipefail

template=/template/.chatgpt-poc-profile
profile=/data/.chatgpt-poc-profile
if [[ ! -d "$profile/Default" ]]; then
  if [[ ! -d "$template/Default" ]]; then
    echo 'The main ChatGPT browser must be signed in before starting the dedicated utility browser.' >&2
    exit 1
  fi
  mkdir -p /data
  cp -a --reflink=auto "$template" "$profile"
  echo '[utility] copied the authenticated browser profile into isolated persistent storage'
fi

exec /usr/local/bin/browser-agent-entrypoint
