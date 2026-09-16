#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data /tmp/browser-runtime
chmod 700 /tmp/browser-runtime

# Xvfb leaves these files behind when the container is interrupted during
# startup.  They live in the container writable layer, so clear only this
# service's display before starting it again.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
# Chromium records its owning process/container in these symlinks. They become
# stale whenever Docker recreates the service and otherwise prevent Puppeteer
# from opening the persistent profile again.
rm -f /data/.chatgpt-poc-profile/SingletonLock \
      /data/.chatgpt-poc-profile/SingletonCookie \
      /data/.chatgpt-poc-profile/SingletonSocket \
      /data/.chatgpt-poc-daemon.json

Xvfb :99 -screen 0 "${SCREEN_GEOMETRY:-1440x900x24}" -ac +extension GLX +render -noreset &
sleep 1
fluxbox >/tmp/fluxbox.log 2>&1 &

if [[ -n "${VNC_PASSWORD:-}" ]]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /data/vnc.pass >/dev/null
  VNC_AUTH=(-rfbauth /data/vnc.pass)
else
  VNC_AUTH=(-nopw)
fi
x11vnc -display :99 -forever -shared -listen 0.0.0.0 "${VNC_AUTH[@]}" >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &

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
