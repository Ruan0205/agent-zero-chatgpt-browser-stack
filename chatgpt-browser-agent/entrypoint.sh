#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data /tmp/browser-runtime
chmod 700 /tmp/browser-runtime

# Every fixed browser slot has its own X display, VNC server and noVNC port.
# This prevents simultaneous browser actions from sharing a desktop focus.
display_count=${BROWSER_DISPLAY_COUNT:-1}
if ! [[ "$display_count" =~ ^[1-3]$ ]]; then
  echo 'BROWSER_DISPLAY_COUNT must be 1, 2 or 3' >&2
  exit 1
fi
# Chromium records its owning process/container in these symlinks. They become
# stale whenever Docker recreates the service and otherwise prevent Puppeteer
# from opening the persistent profile again.
rm -f /data/.chatgpt-poc-profile/SingletonLock \
      /data/.chatgpt-poc-profile/SingletonCookie \
      /data/.chatgpt-poc-profile/SingletonSocket \
      /data/.chatgpt-poc-daemon.json

if [[ -n "${VNC_PASSWORD:-}" ]]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /data/vnc.pass >/dev/null
  VNC_AUTH=(-rfbauth /data/vnc.pass)
else
  VNC_AUTH=(-nopw)
fi
for ((index=0; index<display_count; index++)); do
  display=$((99 + index))
  vnc_port=$((5900 + index))
  web_port=$((6080 + index))
  rm -f "/tmp/.X${display}-lock" "/tmp/.X11-unix/X${display}"
  Xvfb ":${display}" -screen 0 "${SCREEN_GEOMETRY:-1440x900x24}" -ac +extension GLX +render -noreset &
done
sleep 1
for ((index=0; index<display_count; index++)); do
  display=$((99 + index))
  vnc_port=$((5900 + index))
  web_port=$((6080 + index))
  DISPLAY=":${display}" fluxbox >"/tmp/fluxbox-${display}.log" 2>&1 &
  x11vnc -display ":${display}" -rfbport "$vnc_port" -forever -shared -listen 0.0.0.0 "${VNC_AUTH[@]}" >"/tmp/x11vnc-${display}.log" 2>&1 &
  websockify --web=/usr/share/novnc "$web_port" "127.0.0.1:${vnc_port}" >"/tmp/novnc-${display}.log" 2>&1 &
done

# The occasional final-answer audit uses a hidden desktop, never one of the
# three user-request displays. It has no VNC port and cannot steal their focus.
if [[ -n "${AUDITOR_DISPLAY:-}" ]]; then
  if ! [[ "$AUDITOR_DISPLAY" =~ ^:([0-9]+)$ ]] || (( BASH_REMATCH[1] < 99 + display_count )); then
    echo 'AUDITOR_DISPLAY must be a separate X display' >&2
    exit 1
  fi
  audit_number=${AUDITOR_DISPLAY#:}
  rm -f "/tmp/.X${audit_number}-lock" "/tmp/.X11-unix/X${audit_number}"
  Xvfb "$AUDITOR_DISPLAY" -screen 0 "${SCREEN_GEOMETRY:-1440x900x24}" -ac +extension GLX +render -noreset &
  DISPLAY="$AUDITOR_DISPLAY" fluxbox >"/tmp/fluxbox-auditor.log" 2>&1 &
fi

# A brand-new installation has no authenticated Chrome profile yet. Keep the
# container and noVNC alive in an explicit setup mode instead of crashing the
# gateway. The operator logs in through VNC and closes the Chrome window; only
# then is the authenticated template cloned into the browser pool.
if [[ ! -d /data/.chatgpt-poc-profile/Default && "${BROWSER_ALLOW_EMPTY_PROFILE:-0}" != "1" ]]; then
  mkdir -p /data/.chatgpt-poc-profile
  touch /data/.manual-login-active
  cleanup_first_login() {
    rm -f /data/.manual-login-active \
      /data/.chatgpt-poc-profile/SingletonLock \
      /data/.chatgpt-poc-profile/SingletonCookie \
      /data/.chatgpt-poc-profile/SingletonSocket
  }
  trap cleanup_first_login EXIT INT TERM
  /usr/bin/google-chrome-stable \
    --no-sandbox \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --password-store=basic \
    --user-data-dir=/data/.chatgpt-poc-profile \
    'https://chatgpt.com/auth/login'
  cleanup_first_login
  trap - EXIT INT TERM
fi

exec node /app/gateway.js
