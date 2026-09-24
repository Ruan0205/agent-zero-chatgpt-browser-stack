FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium xvfb x11vnc fluxbox novnc websockify dbus-x11 ca-certificates fonts-liberation git curl ripgrep python3 build-essential \
 && curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/google-chrome.deb \
 && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
 && rm -f /tmp/google-chrome.deb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY chatgpt.js gateway.js browser-pool.js bridge-core.js utility-compactor.js incident-auditor.js provider-cooldown.js provider-rejection.js completion-state.js image-upload.js composer-chunks.js media-intent.js retry-policy.js mcp-server.js agent.js ./
COPY entrypoint.sh /usr/local/bin/browser-agent-entrypoint
COPY utility-entrypoint.sh /usr/local/bin/browser-utility-entrypoint
COPY manual-login.sh /usr/local/bin/chatgpt-manual-login
RUN chmod 0755 /usr/local/bin/browser-agent-entrypoint /usr/local/bin/browser-utility-entrypoint /usr/local/bin/chatgpt-manual-login \
    && mkdir -p /data /workspace /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && chown -R node:node /app /data /workspace

USER node
ENV DISPLAY=:99 \
    HOME=/data \
    XDG_RUNTIME_DIR=/tmp/browser-runtime \
    CHROME_PATH=/usr/bin/google-chrome-stable \
    CHROME_NO_SANDBOX=1 \
    CHATGPT_BROWSER_STATE_DIR=/data \
    MODEL_ID=chatgpt-browser

EXPOSE 8000 6080
ENTRYPOINT ["/usr/local/bin/browser-agent-entrypoint"]
