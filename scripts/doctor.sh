#!/bin/sh
set -eu

compose="docker compose"

echo "== Containers =="
$compose ps

check_url() {
  name=$1
  url=$2
  if curl -fsS --max-time 10 -o /dev/null "$url"; then
    echo "OK  $name  $url"
  else
    echo "ERRO $name  $url" >&2
    return 1
  fi
}

echo "== Endpoints =="
check_url "Agent Zero" "http://127.0.0.1:${AGENT_ZERO_PORT:-50080}/login"
check_url "ChatGPT Browser noVNC" "http://127.0.0.1:${CHATGPT_VNC_PORT:-50081}/vnc.html"
check_url "ChatGPT Browser noVNC 2" "http://127.0.0.1:${CHATGPT_VNC_2_PORT:-50083}/vnc.html"
check_url "ChatGPT Browser noVNC 3" "http://127.0.0.1:${CHATGPT_VNC_3_PORT:-50085}/vnc.html"
check_url "ChatGPT Utility noVNC" "http://127.0.0.1:${CHATGPT_UTILITY_VNC_PORT:-50084}/vnc.html"
check_url "VS Code" "http://127.0.0.1:${VSCODE_PORT:-50082}/healthz"

echo "== APIs internas =="
$compose exec -T featherless-queue python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5)"
$compose exec -T chatgpt-browser-agent node -e "fetch('http://127.0.0.1:8000/health').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(console.log)"
$compose exec -T chatgpt-browser-utility node -e "fetch('http://127.0.0.1:8000/health').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(console.log)"

echo "== Migração persistente =="
marker="${STACK_DATA_DIR:-./data}/.stack-migrations/${STACK_SCHEMA_VERSION:-v2.12-stack.11}.json"
test -r "$marker" || { echo "ERRO migration marker ausente: $marker" >&2; exit 1; }
cat "$marker"

echo "== Modelo Utility efetivo =="
$compose exec -T agent-zero /opt/venv-a0/bin/python -c "import yaml; p='/a0/usr/plugins/_model_config/presets.yaml'; d=yaml.safe_load(open(p)); bad=[x.get('name') for x in d if (x.get('utility') or {}).get('name')!='chatgpt-browser-utility']; assert not bad, f'presets sem Utility browser: {bad}'; print('OK: todos os presets usam chatgpt-browser-utility')"

echo "== Caminho de anexos ChatGPT Browser =="
$compose exec -T chatgpt-browser-agent sh -c 'test -r /app/gateway.js && test -r /app/chatgpt.js && test -d /data/outbox && test -w /data/outbox'
$compose exec -T agent-zero sh -c 'test -r /a0/plugins/_chatgpt_browser_media/plugin.yaml && test -r /a0/plugins/_chatgpt_browser_media/tools/chatgpt_browser_media.py && test -r /a0/plugins/_chatgpt_browser_media/extensions/webui/get_tool_message_handler/chatgpt-browser-media-handler.js && test -d /a0/usr/browser-media'
marker_path=$($compose exec -T chatgpt-browser-agent sh -c 'mktemp /data/outbox/.stack-doctor.XXXXXXXX')
cleanup_marker() {
  $compose exec -T chatgpt-browser-agent rm -f "$marker_path" >/dev/null 2>&1 || true
}
trap cleanup_marker EXIT HUP INT TERM
marker_name=${marker_path##*/}
$compose exec -T agent-zero test -r "/a0/usr/browser-media/$marker_name"
cleanup_marker
trap - EXIT HUP INT TERM
echo "OK: bridge, plugin, frontend e outbox realmente compartilhado (não substitui o teste PDF ponta a ponta)"

echo "Diagnóstico básico concluído."
