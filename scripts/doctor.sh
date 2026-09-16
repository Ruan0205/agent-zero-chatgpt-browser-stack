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
check_url "ChatGPT Utility noVNC" "http://127.0.0.1:${CHATGPT_UTILITY_VNC_PORT:-50084}/vnc.html"
check_url "VS Code" "http://127.0.0.1:${VSCODE_PORT:-50082}/healthz"

echo "== APIs internas =="
$compose exec -T featherless-queue python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5)"
$compose exec -T chatgpt-browser-agent node -e "fetch('http://127.0.0.1:8000/health').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(console.log)"
$compose exec -T chatgpt-browser-utility node -e "fetch('http://127.0.0.1:8000/health').then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(console.log)"

echo "Diagnóstico básico concluído."
