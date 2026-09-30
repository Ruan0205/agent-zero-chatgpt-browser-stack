#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

usage() {
  cat <<'EOF'
Uso:
  ./scripts/configure-integrations.sh browser [--whatsapp]
  ./scripts/configure-integrations.sh kimi [--whatsapp]

O modo browser usa ChatGPT Browser para chat, Utility/compactação e reparador.
O modo kimi usa kimi-k3/We64 para esses três papéis e mantém o browser principal
disponível para o perfil Power e tarefas explicitamente delegadas ao navegador.
O script nunca cria, imprime ou substitui API_KEY_OTHER.
EOF
}

[ -f .env ] || { echo "Execute ./scripts/setup.sh primeiro." >&2; exit 1; }
mode=${1:-}
whatsapp=${2:-}
case "$mode" in browser|kimi) ;; *) usage >&2; exit 2 ;; esac
case "$whatsapp" in ""|--whatsapp) ;; *) usage >&2; exit 2 ;; esac

set_env() {
  key=$1
  value=$2
  if grep -q "^${key}=" .env; then
    escaped=$(printf '%s' "$value" | sed 's/[&|]/\\&/g')
    sed -i "s|^${key}=.*|${key}=${escaped}|" .env
  else
    printf '\n%s=%s\n' "$key" "$value" >> .env
  fi
}

profiles=""
if [ "$mode" = browser ]; then
  profiles="browser-utility,browser-repair"
  set_env DEFAULT_MODEL chatgpt-browser
  set_env DEFAULT_API_BASE http://chatgpt-browser-agent:8000/v1
  set_env DEFAULT_CONTEXT_LENGTH 131072
  set_env UTILITY_MODEL chatgpt-browser-utility
  set_env UTILITY_API_BASE http://chatgpt-browser-utility:8000/v1
  set_env UTILITY_CONTEXT_LENGTH 131072
  set_env REPAIR_MODEL chatgpt-browser
  set_env REPAIR_API_BASE http://chatgpt-browser-repair:8000/v1
  set_env REPAIR_CONTEXT_LENGTH 131072
  set_env REPAIR_REQUIRES_BROWSER true
else
  key=$(sed -n 's/^API_KEY_OTHER=//p' .env | tail -n 1)
  case "$key" in ""|not-used-with-browser-backend|cole-*)
    echo "Defina API_KEY_OTHER em .env com a chave We64 antes de ativar Kimi." >&2
    exit 1
  esac
  profiles="kimi"
  set_env DEFAULT_MODEL kimi-k3
  set_env DEFAULT_API_BASE http://agent-zero-featherless-queue:8000/v1
  set_env DEFAULT_CONTEXT_LENGTH 1000000
  set_env UTILITY_MODEL kimi-k3
  set_env UTILITY_API_BASE http://agent-zero-featherless-queue:8000/v1
  set_env UTILITY_CONTEXT_LENGTH 1000000
  set_env REPAIR_MODEL kimi-k3
  set_env REPAIR_API_BASE http://agent-zero-featherless-queue:8000/v1
  set_env REPAIR_CONTEXT_LENGTH 1000000
  set_env REPAIR_REQUIRES_BROWSER false
fi

if [ "$whatsapp" = --whatsapp ]; then
  profiles="${profiles},whatsapp"
fi
set_env COMPOSE_PROFILES "$profiles"
set_env STACK_SCHEMA_VERSION v2.12-stack.14
chmod 0600 .env
docker compose config --quiet
echo "Modo '$mode' configurado; profiles: $profiles"
echo "Nenhuma credencial foi exibida ou substituída. Recrie os serviços para aplicar."
