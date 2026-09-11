FROM docker:27-cli AS docker-cli

FROM ghcr.io/coder/code-server:4.121.0

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

COPY exec_server.py /opt/a0-vscode/exec_server.py
COPY entrypoint.sh /usr/local/bin/a0-vscode-entrypoint
RUN chmod 0755 /usr/local/bin/a0-vscode-entrypoint \
    && mkdir -p /workspace/chats /config \
    && git config --system init.defaultBranch main \
    && git config --system user.name "Agent Zero" \
    && git config --system user.email "agent-zero@server.local"

ENTRYPOINT ["/usr/local/bin/a0-vscode-entrypoint"]
