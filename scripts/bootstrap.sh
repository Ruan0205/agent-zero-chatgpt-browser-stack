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
  "$data_root/browser/provider-cooldown" \
  "$data_root/browser-utility" \
  "$data_root/browser-workspace" \
  "$data_root/vscode-config" \
  "$data_root/workspace/chats" \
  "$data_root/whatsapp" \
  "$data_root/meta-ai-whatsapp" \
  "$data_root/vault"

# Both browser containers run as uid 1000. Keep existing profile contents
# intact; only make the volume roots writable for a first installation.
chown 1000:1000 "$data_root/browser" "$data_root/browser/provider-cooldown" "$data_root/browser-utility" "$data_root/browser-workspace"

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
for profile in default developer hacker researcher tiny-local; do
  copy_once "$seed_root/agents/$profile/agent.yaml" "$data_root/agent-zero/agents/$profile/agent.yaml"
done
copy_once "$seed_root/agents/agent0/prompts/agent.system.main.specifics.md" "$data_root/agent-zero/agents/agent0/prompts/agent.system.main.specifics.md"
copy_once "$seed_root/plugins/_model_config/config.json" "$data_root/agent-zero/plugins/_model_config/config.json"
copy_once "$seed_root/plugins/_model_config/presets.yaml" "$data_root/agent-zero/plugins/_model_config/presets.yaml"
copy_once "$seed_root/plugins/_code_execution/config.json" "$data_root/agent-zero/plugins/_code_execution/config.json"

if [ ! -e "$data_root/agent-zero/plugins/browser_session_bridge/plugin.yaml" ]; then
  cp -R "$seed_root/plugins/browser_session_bridge/." "$data_root/agent-zero/plugins/browser_session_bridge/"
fi

# State survives image updates. Apply narrow, versioned migrations so an old
# bridge, a legacy Gemma Utility preset, or a frozen Power-chat snapshot cannot
# silently resurrect bugs that were already fixed in the repository.
python /migrate_persistent_state.py

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

printf '{"password":"%s","port":"%s","ports":["%s","%s","%s"]}\n' \
  "$VNC_PASSWORD" "${CHATGPT_VNC_PORT:-50081}" \
  "${CHATGPT_VNC_PORT:-50081}" "${CHATGPT_VNC_2_PORT:-50083}" "${CHATGPT_VNC_3_PORT:-50085}" \
  > "$data_root/agent-monitor/vnc-runtime.json"
chmod 0600 "$data_root/agent-monitor/vnc-runtime.json"

echo "Bootstrap concluído: dados preparados e migrações persistentes aplicadas."
