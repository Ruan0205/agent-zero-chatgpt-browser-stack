#!/bin/sh
set -eu

data_root=/data
seed_root=/seed

mkdir -p \
  "$data_root/agent-zero/plugins/_model_config" \
  "$data_root/agent-zero/plugins/browser_session_bridge" \
  "$data_root/agent-zero/uploads" \
  "$data_root/agent-zero/workdir" \
  "$data_root/agent-zero/chats" \
  "$data_root/agent-zero/knowledge" \
  "$data_root/agent-zero/memory" \
  "$data_root/agent-monitor" \
  "$data_root/browser" \
  "$data_root/browser-utility" \
  "$data_root/browser-workspace" \
  "$data_root/vscode-config" \
  "$data_root/workspace/chats" \
  "$data_root/whatsapp" \
  "$data_root/meta-ai-whatsapp" \
  "$data_root/vault"

# Both browser containers run as uid 1000. Keep existing profile contents
# intact; only make the volume roots writable for a first installation.
chown 1000:1000 "$data_root/browser" "$data_root/browser-utility" "$data_root/browser-workspace"

copy_once() {
  source=$1
  target=$2
  if [ ! -e "$target" ]; then
    mkdir -p "$(dirname "$target")"
    cp -R "$source" "$target"
  fi
}

copy_once "$seed_root/settings.json" "$data_root/agent-zero/settings.json"
copy_once "$seed_root/server_context.md" "$data_root/agent-zero/server_context.md"
copy_once "$seed_root/plugins/_model_config/config.json" "$data_root/agent-zero/plugins/_model_config/config.json"
copy_once "$seed_root/plugins/_model_config/presets.yaml" "$data_root/agent-zero/plugins/_model_config/presets.yaml"

if [ ! -e "$data_root/agent-zero/plugins/browser_session_bridge/plugin.yaml" ]; then
  cp -R "$seed_root/plugins/browser_session_bridge/." "$data_root/agent-zero/plugins/browser_session_bridge/"
fi

case "${VNC_PASSWORD:-}" in
  ""|*[!A-Za-z0-9_-]*)
    echo "VNC_PASSWORD deve conter de 1 a 8 caracteres: letras, números, _ ou -." >&2
    exit 1
    ;;
esac

if [ "${#VNC_PASSWORD}" -gt 8 ]; then
  echo "VNC_PASSWORD deve ter no máximo 8 caracteres (limite do protocolo VNC)." >&2
  exit 1
fi

printf '{"password":"%s","port":"%s"}\n' "$VNC_PASSWORD" "${CHATGPT_VNC_PORT:-50081}" \
  > "$data_root/agent-monitor/vnc-runtime.json"
chmod 0600 "$data_root/agent-monitor/vnc-runtime.json"

echo "Bootstrap concluído: dados vazios preparados e configurações padrão instaladas."
