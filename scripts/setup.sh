#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || { echo "Docker não encontrado." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 não encontrado." >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "OpenSSL não encontrado." >&2; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  login_password=$(openssl rand -hex 16)
  root_password=$(openssl rand -hex 16)
  rfc_password=$(openssl rand -hex 16)
  vscode_token=$(openssl rand -hex 32)
  journal_token=$(openssl rand -hex 32)
  vnc_password=$(openssl rand -hex 4)

  sed -i \
    -e "s/troque-esta-senha$/$login_password/" \
    -e "s/troque-esta-senha-root$/$root_password/" \
    -e "s/troque-esta-senha-rfc$/$rfc_password/" \
    -e "s/gere-um-token-aleatorio-longo$/$vscode_token/" \
    -e "s/gere-outro-token-aleatorio-longo$/$journal_token/" \
    -e "s/Vnc12345$/$vnc_password/" \
    .env
  chmod 0600 .env
  echo ".env criado com senhas aleatórias. Edite API_KEY_OTHER, WA_PHONE e PUBLIC_HOST antes de subir."
else
  echo ".env já existe; nenhuma credencial foi substituída."
fi

mkdir -p data
chmod 0700 data
docker compose config --quiet
echo "Configuração válida. Depois de revisar .env, execute: docker compose up -d --build"
