# Agent Zero + ChatGPT Browser Stack

Distribuição reproduzível da infraestrutura que integra o **Agent Zero**, um modelo acessado pela interface web do ChatGPT, modelos do Featherless, VS Code no navegador, WhatsApp/Meta AI e ferramentas administrativas do host Linux.

O repositório contém as customizações funcionais da instalação de origem, mas **não contém** contas Google/ChatGPT, sessões do WhatsApp, chats, memórias, cookies, uploads, chaves de API, senhas ou dados pessoais. Cada instalação começa vazia e exige seus próprios logins.

> Aviso: esta stack oferece ao Agent Zero acesso `root`, modo privilegiado, PID namespace do host, socket Docker e montagem da raiz Linux em `/host`. Isso equivale a controle administrativo total da máquina quando uma ferramenta é executada. Use somente em servidor dedicado e confiável; leia [SECURITY.md](SECURITY.md) antes de iniciar.

## O que está incluído

- Agent Zero fixado na imagem validada, com dados persistentes e presets sanitizados.
- Modelo **Default** e **Efficiency** via fila serial Featherless.
- Modelo **Power** `chatgpt-browser`, ligado a uma sessão persistente do ChatGPT no Chrome.
- Uma conversa do navegador por chat do Agent Zero, evitando misturar contextos.
- Envio enxuto ao navegador, reutilizando o contexto mantido pelo próprio ChatGPT.
- Espera de até 130 segundos e duas tentativas adicionais para HTTP 429, com intervalo de 30 segundos.
- Chromium visível por noVNC e painel integrado no Agent Zero.
- VS Code/code-server por chat, executor autenticado e acesso ao Docker do host.
- Proteções contra repetição de respostas e contra memorização que trava o fluxo.
- Integração WhatsApp em self-chat, anexos e geração/edição de imagens via Meta AI.
- Fila Featherless global com concorrência 1, retries e healthcheck.
- Bootstrap idempotente: configurações iniciais são copiadas apenas se ainda não existirem.

## Arquitetura

```text
Navegador do usuário
  ├─ :50080  Agent Zero
  │    ├─ Default/Efficiency ──> featherless-queue ──> Featherless API
  │    ├─ Power ───────────────> chatgpt-browser-agent ──> chatgpt.com
  │    ├─ ferramenta VS Code ──> code-server + executor
  │    ├─ WhatsApp self-chat ──> bridge interno persistente
  │    └─ ferramenta de imagem > meta-ai-whatsapp ──> Meta AI no WhatsApp
  ├─ :50081  noVNC / Chrome do ChatGPT Browser
  └─ :50082  VS Code web

Host Linux
  ├─ /var/run/docker.sock -> Agent Zero e VS Code
  ├─ / -> /host no Agent Zero
  └─ ./data -> sessões e estado local, nunca versionados
```

Mais detalhes estão em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requisitos

- Linux x86_64 recente (Ubuntu/Debian são os caminhos mais simples).
- Docker Engine 24+ e plugin Docker Compose v2.
- Git, OpenSSL e `curl` no host.
- Pelo menos 8 GB de RAM; 16 GB são recomendados para uso simultâneo.
- Cerca de 15 GB livres para imagens, builds e perfis do navegador.
- Conta Featherless e chave de API para os presets locais.
- Conta ChatGPT própria para o modelo Power.
- WhatsApp próprio apenas se as integrações de WhatsApp/Meta AI forem usadas.

O Chrome é executado no container; não é necessária GPU.

## Instalação rápida

```bash
git clone https://github.com/Ruan0205/agent-zero-chatgpt-browser-stack.git
cd agent-zero-chatgpt-browser-stack
chmod +x scripts/*.sh
./scripts/setup.sh
```

Edite `.env`:

```bash
nano .env
```

No mínimo, configure:

- `API_KEY_OTHER`: chave do Featherless.
- `AUTH_LOGIN` e confirme as senhas aleatórias geradas.
- `WA_PHONE`: telefone com DDI e somente dígitos, se for usar Meta AI/WhatsApp.
- `PUBLIC_HOST` e `PUBLIC_BASE_URL`: IP ou hostname acessível na rede.

Suba toda a stack:

```bash
docker compose up -d --build
docker compose ps
```

No primeiro build, Docker baixa o Agent Zero, Node, Chrome, Chromium, noVNC, code-server e dependências Go/Python. Pode levar vários minutos.

## Primeiros acessos

Substitua `HOST` pelo IP ou DNS do servidor:

| Componente | Endereço | Autenticação |
|---|---|---|
| Agent Zero | `http://HOST:50080/` | `AUTH_LOGIN` / `AUTH_PASSWORD` |
| ChatGPT Browser | `http://HOST:50081/vnc.html?autoconnect=1&resize=scale` | `VNC_PASSWORD` |
| VS Code | `http://HOST:50082/` | integrado à stack |

O ícone **ChatGPT Browser (VNC)** dentro do Agent Zero abre a mesma tela `:50081/vnc.html` e injeta a senha automaticamente apenas depois do login no Agent Zero.

### 1. Entrar no ChatGPT Browser

1. Abra o noVNC na porta 50081.
2. Entre com `VNC_PASSWORD` se estiver usando o endereço direto.
3. No Chrome exibido, abra `https://chatgpt.com` e faça login manualmente.
4. Confirme que a página normal de conversa aparece.

O perfil fica em `data/browser`. Ele não é compartilhado com o repositório nem com outras instalações. Não copie essa pasta para Git.

Se o login Google recusar um navegador automatizado, use um método de login aceito diretamente pelo ChatGPT ou execute a autenticação manual no Chrome visível. Não desative controles de segurança da conta.

### 2. Conectar Meta AI pelo WhatsApp

Defina `WA_PHONE` em `.env`, suba o serviço e acompanhe o código de pareamento:

```bash
docker compose up -d meta-ai-whatsapp
docker compose logs -f meta-ai-whatsapp
```

No celular: **WhatsApp > Aparelhos conectados > Conectar com número de telefone** e informe o código mostrado. O banco e as chaves ficam somente em `data/meta-ai-whatsapp`.

### 3. Conectar o WhatsApp do Agent Zero

Abra o Agent Zero, ative/configure o plugin de WhatsApp e leia o QR code na interface. A sessão fica em `data/whatsapp`. A configuração fornecida usa self-chat como barreira principal; revise os números e permissões antes de permitir respostas automáticas.

## Modelos

Os presets ficam em `agent-zero/seed/plugins/_model_config/presets.yaml` e são instalados no primeiro boot:

- **Default:** Qwen 3.8 uncensored via Featherless.
- **Efficiency:** o mesmo caminho serial Featherless, priorizando estabilidade.
- **Power:** `chatgpt-browser`, endpoint interno `http://chatgpt-browser-agent:8000/v1`.
- **Utility:** Gemma via Featherless, separado do modelo principal.
- **Embedding:** `sentence-transformers/all-MiniLM-L6-v2`.

Depois do primeiro boot, alterações feitas na interface ficam em `data/agent-zero/plugins/_model_config` e não são sobrescritas pelo repositório.

## Persistência e privacidade

| Pasta | Conteúdo | Publicar? |
|---|---|---|
| `data/agent-zero` | chats, configurações, memória e uploads | Nunca |
| `data/browser` | cookies e perfil autenticado do ChatGPT | Nunca |
| `data/whatsapp` | sessão WhatsApp do Agent Zero | Nunca |
| `data/meta-ai-whatsapp` | sessão WhatsApp do bridge Meta AI | Nunca |
| `data/workspace` | projetos por chat | Somente após revisão |
| `data/vscode-config` | preferências do code-server | Normalmente não |
| `data/agent-monitor` | credencial VNC gerada | Nunca |

Todas essas pastas estão ignoradas no Git.

## Operação

```bash
# Estado
docker compose ps

# Logs gerais
docker compose logs -f --tail=200

# Reiniciar só o navegador
docker compose restart chatgpt-browser-agent

# Recriar após atualizar código
docker compose up -d --build

# Diagnóstico automatizado
set -a; . ./.env; set +a
./scripts/doctor.sh
```

### Backup

Pare a stack para obter consistência e arquive `data/` localmente:

```bash
docker compose down
tar -czf agent-zero-stack-backup-$(date +%F).tar.gz data
docker compose up -d
```

Esse backup contém credenciais e deve ser criptografado e mantido fora do Git.

## Testes

```bash
# Validação do Compose
docker compose config --quiet

# Testes do protocolo/bridge ChatGPT Browser
docker run --rm -v "$PWD/chatgpt-browser-agent:/app" -w /app node:22-bookworm-slim \
  node --test bridge-core.test.js

# Smoke test isolado das quatro imagens construídas
./scripts/validate-images.sh

# Saúde com a stack em execução
set -a; . ./.env; set +a
./scripts/doctor.sh
```

## Solução de problemas

### HTTP 429 / rate limit

O gateway espera 30 segundos e tenta novamente até duas vezes. A fila Featherless aceita somente uma chamada upstream por vez. Se o provedor continuar rejeitando, aguarde a janela de limite; criar mais containers não aumenta a cota.

### `The message you submitted was too long`

Cada chat do Agent Zero recebe uma conversa própria no ChatGPT Browser e o histórico anterior não é reenviado integralmente. Se ainda ocorrer, abra um novo chat no Agent Zero ou reduza anexos/instruções excepcionalmente grandes.

### noVNC abre, mas o ChatGPT não responde

Verifique visualmente a sessão, pop-ups e o estado do login. Depois veja:

```bash
docker compose logs --tail=300 chatgpt-browser-agent
curl http://127.0.0.1:50081/vnc.html
```

### Modelo Featherless indisponível

Modelos podem estar cold, fora de deployment ou temporariamente indisponíveis. Troque `DEFAULT_MODEL`/`UTILITY_MODEL` em `.env` e recrie o Agent Zero, ou altere o preset pela interface.

### WhatsApp desconectado

Apague a sessão somente se quiser parear novamente. Isso é destrutivo para o vínculo atual:

```bash
docker compose stop meta-ai-whatsapp
# faça backup de data/meta-ai-whatsapp antes de remover qualquer arquivo
docker compose logs meta-ai-whatsapp
```

## Atualizações e compatibilidade

A imagem do Agent Zero está fixada por digest porque as customizações montam extensões em caminhos internos. Atualizar o digest sem testar pode quebrar plugins. Faça a mudança em um clone, rode os testes e valide todas as ferramentas antes de produção.

A automação de `chatgpt.com` depende da interface web e pode deixar de funcionar quando o site muda. Este projeto não é afiliado à OpenAI, Meta, WhatsApp, Featherless ou Agent Zero.

## Licenças

Veja [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). O subdiretório `chatgpt-browser-agent` preserva a licença do projeto de origem.
