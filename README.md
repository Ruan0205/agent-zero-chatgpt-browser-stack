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
4. Confirme que a página normal de conversa aparece e então feche a janela do Chrome. No primeiro acesso, esse fechamento encerra o modo de configuração e inicia automaticamente o pool de navegadores.
5. Aguarde o healthcheck ficar saudável; o Agent Zero, que depende dele, terminará de iniciar.

O perfil fica em `data/browser`. Ele não é compartilhado com o repositório nem com outras instalações. Não copie essa pasta para Git.

Se o login Google recusar um navegador automatizado, use um método de login aceito diretamente pelo ChatGPT ou execute a autenticação manual no Chrome visível. Não desative controles de segurança da conta.

### 2. Conectar Meta AI pelo WhatsApp

Defina `WA_PHONE` em `.env` e suba o serviço:

```bash
docker compose up -d meta-ai-whatsapp
```

No Agent Zero, abra **Settings > External > Meta AI WhatsApp Bridge**, informe DDI + DDD + número e clique em **Gerar código de conexão**. No celular: **WhatsApp > Aparelhos conectados > Conectar com número de telefone** e informe o código mostrado. A tela é opcional e não conecta nenhuma conta automaticamente. O banco e as chaves ficam somente em `data/meta-ai-whatsapp`.

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

## Prompt completo para instalação por outra IA

Copie o bloco inteiro abaixo para uma IA com terminal no servidor Linux. Ele foi escrito para que a IA gere as credenciais internas e solicite ao usuário somente o que depende de contas pessoais.

```text
Você é responsável por instalar, configurar, validar e documentar a stack pública
Ruan0205/agent-zero-chatgpt-browser-stack em um servidor Linux. Trabalhe até que a
instalação esteja funcional; não considere "containers subiram" como validação suficiente.

REGRAS DE SEGURANÇA E ESCOPO
1. Antes de alterar o host, registre distribuição, kernel, CPU, RAM, swap, discos,
   portas em uso, Docker/Compose, firewall e serviços existentes. Não pare nem remova
   aplicações alheias à stack.
2. Clone o repositório oficial público. Não reutilize cookies, sessões, chats, bancos,
   arquivos .env ou credenciais de outra instalação.
3. A stack concede ao Agent Zero root, privileged, PID do host, Docker socket e `/host`.
   Explique isso claramente e confirme que o destino é um servidor dedicado/confiável.
4. Gere localmente, com CSPRNG, todas as credenciais internas: AUTH_PASSWORD,
   ROOT_PASSWORD, RFC_PASSWORD, VNC_PASSWORD (máximo 8 caracteres),
   VSCODE_EXEC_TOKEN, BROWSER_POOL_NOTICE_TOKEN e WHATSAPP_JOURNAL_TOKEN. Grave-as
   somente no `.env` com permissão 0600. Ao final, entregue-as ao proprietário uma única
   vez sem publicar em logs, Git, histórico ou README.
5. Peça ao proprietário somente: (a) API key e conta Featherless; (b) qual modelo
   Default/Utility disponível deseja usar, se diferente do padrão; (c) login manual da
   própria conta ChatGPT/Gmail dentro do noVNC; (d) telefone/pareamento manual do próprio
   WhatsApp, se quiser usar WhatsApp ou Meta AI; (e) IP/DNS e portas desejadas. Nunca peça
   senha do Gmail/ChatGPT ou código do WhatsApp por texto: abra a interface para o usuário.
6. Não conclua com segredos de exemplo, credenciais vazias ou serviços desprotegidos.

INSTALAÇÃO
1. Instale/verifique Docker Engine 24+, Compose v2, Git, curl e OpenSSL conforme a
   distribuição. Não use Docker-in-Docker.
2. Clone o repositório, execute `chmod +x scripts/*.sh` e `./scripts/setup.sh`.
3. Preencha `.env`, mantendo `STACK_DATA_DIR` em um disco com espaço suficiente e
   `HOST_ROOT_MOUNT=/` somente após a ciência do proprietário.
4. Execute `docker compose config --quiet`, depois `docker compose up -d --build`.
5. Aguarde healthchecks. Investigue/repare qualquer restart, unhealthy, traceback,
   conflito de porta ou permissão. Valide que um clean recreation do Agent Zero v2.12 não
   perde os plugins oficiais obrigatórios.
6. Abra `http://HOST:50081/vnc.html`, entregue o controle ao usuário para autenticar o
   ChatGPT e nunca exporte o perfil. Confirme que o Chrome permanece logado após recriar o
   container.
7. Se Meta AI for desejada, use Agent Zero > Settings > External > Meta AI WhatsApp
   Bridge para gerar o código. A conexão deve ser opcional. Configure separadamente o
   WhatsApp self-chat do Agent Zero e jamais habilite respostas para contatos não
   autorizados.

MATRIZ OBRIGATÓRIA DE TESTES — EXECUTE E GUARDE EVIDÊNCIAS
A. Infra: compose válido; todos os healthchecks; restart individual; recriação limpa;
   reboot do host; persistência de configurações; ausência de segredos no Git; portas;
   uso de CPU/RAM/disco; logs sem boot-loop.
B. Modelos: Default Qwen/Featherless, Efficiency, Utility e Power chatgpt-browser.
   Para cada um: pergunta curta, resposta longa/coesa, português, chamada de ferramenta,
   erro de ferramenta, continuação no mesmo chat e novo chat isolado. Confirme que Qwen
   nunca abre ChatGPT e que Power cria um chat web próprio por chat Agent Zero.
C. Browser pool: duas conversas simultâneas em instâncias distintas; terceira demanda
   cria instância temporária; afinidade Agent-Zero-chat ↔ ChatGPT-chat; ociosa por 30 min;
   popup; timeout; página travada; um 429 e duas retentativas com 30 s; keep-alive de
   operação lenta; sem refresh a cada mensagem; sem chat cruzado ou loop.
D. Ferramentas: terminal dentro do container; terminal root no host apenas quando pedido;
   Docker; navegador do Agent Zero; desktop; VS Code por chat; criar/editar/salvar arquivo;
   executar comando; criar Docker Hello World; abrir no navegador; Git init/commit; remover
   somente o projeto de teste; VNC integrado; painel de incidentes; ligar/desligar auditor.
E. Imagens: no Power, enviar PNG/JPG/WebP junto do prompt, analisar, gerar uma e várias
   imagens, editar imagem anterior e devolver inline. No Qwen, testar a ferramenta Meta AI
   somente se o usuário a pareou; sem pareamento deve falhar de forma clara e limitada.
F. Saída ChatGPT→Agent Zero, no MESMO chat, um item por vez, validando assinatura real,
   conteúdo marcador, MIME, tamanho > 0, preview quando aplicável, download e cópia no VS
   Code antes de avançar. Extensões obrigatórias:
   png,jpg,jpeg,webp,gif,pdf,docx,xlsx,xls,pptx,csv,tsv,txt,md,json,xml,yaml,yml,
   html,htm,svg,py,js,ts,jsx,tsx,java,c,cpp,h,hpp,cs,go,rs,php,rb,sh,ps1,bat,sql,
   css,toml,ini,cfg,conf,log,ipynb,zip,7z,rar,tar,tar.gz,tgz,gz,bz2,xz,sqlite,
   db,parquet,feather,npy,npz,h5,hdf5,mat,stl,obj,ply,gltf,glb,dae,dxf,wav,mp3,
   flac,ogg,opus,aac,mp4,mov,mkv,avi,webm,iso,bin,exe,dll,so,apk,jar.
G. Entrada Agent Zero→ChatGPT, novamente no MESMO chat e uma extensão por vez: envie um
   arquivo tecnicamente válido de cada extensão da lista F com marcador exclusivo. Exija
   que o ChatGPT leia e devolva o marcador/propriedade estrutural; confirme upload real,
   leitura completa e nenhuma devolução indevida do arquivo de entrada. Recomece o caso do
   zero após qualquer correção.
H. WhatsApp, se habilitado: somente self-chat autorizado; texto, imagem, documento e áudio;
   ausência do prefixo do bot; nenhum contato/grupo externo; Meta AI isolada. Não envie
   mensagens reais fora dos destinos explicitamente autorizados.
I. Memória/contexto: compactação a 85%, erro da extensão de memória não interrompe tarefa,
   tarefa não termina pela metade, resposta repetida é limitada, chat novo recebe somente
   instruções fixas necessárias, sem vazar histórico de outro chat.

CRITÉRIO DE APROVAÇÃO
- Não burle os testes criando arquivos diretamente no Agent Zero: nos testes F eles devem
  ser solicitados ao ChatGPT web; nos testes G devem ser enviados pela interface/API real.
- Corrija cada defeito na fonte persistente, adicione regressão e repita o caso desde o
  início. Falhas externas (cota/429) devem cumprir retentativas e ser registradas, nunca
  disfarçadas como aprovação.
- Só declare concluído com relatório PASS/FAIL, hashes/nomes das evidências, versões e
  instruções de acesso. Se algum teste não puder passar, diga exatamente qual, preserve a
  stack estável e não alegue 100%.
```

## Prompt completo para atualização por outra IA

Este segundo prompt preserva dados de uma instalação existente e exige rollback se a atualização não puder ser validada.

```text
Atualize uma instalação existente de Ruan0205/agent-zero-chatgpt-browser-stack para a
release pública mais recente sem perder chats, memórias, uploads, workspaces, configurações,
sessões do ChatGPT/WhatsApp ou credenciais. Você tem autorização para reiniciar apenas os
serviços desta stack. Não altere aplicações alheias.

CHECKPOINT E INVENTÁRIO — OBRIGATÓRIOS ANTES DA PRIMEIRA MUDANÇA
1. Identifique diretório do repositório, commit/tag atual, arquivos modificados, imagens e
   digests, Compose resolvido, volumes/mounts, permissões, containers, healthchecks e portas.
2. Pare a stack de forma consistente e crie checkpoint datado de: repositório, `.env`,
   Compose resolvido, `STACK_DATA_DIR`, perfis/sessões, chats, memória e workspaces. Não
   inclua o backup no Git. Gere SHA-256, teste a leitura do archive e registre procedimento
   de restauração. Reinicie a versão antiga se a preparação demorar.
3. Nunca substitua `.env`, `data/`, cookies, bancos ou chats pelos exemplos públicos.
   Preserve também arquivos locais desconhecidos; compare antes de mesclar.

ATUALIZAÇÃO
1. Busque tags/releases e notas oficiais. Faça fetch sem apagar alterações. Crie branch de
   atualização e compare migrations, Dockerfiles, plugins, prompts e schema de settings.
2. Mescle a release pública; mantenha segredos somente no `.env`; execute
   `docker compose config --quiet`; construa imagens antes da parada final.
3. Recrie serviços em ordem de dependência. Aplique migrations idempotentes. Confirme que
   a correção v2.12 que copia arquivos oficiais ausentes para `/a0` permanece funcional.
4. Não reconecte, apague ou regenere sessões. A bridge Meta AI continua opcional e sua tela
   fica em Settings > External, ao lado do WhatsApp.

MATRIZ OBRIGATÓRIA PÓS-ATUALIZAÇÃO
A. Infra/persistência: healthchecks, restarts, clean recreation, reboot, versões/digests,
   logs, CPU/RAM/disco, portas e prova de que chats/memórias/uploads/workspaces/settings e
   sessões anteriores continuam presentes.
B. Modelos: Default Qwen/Featherless, Efficiency, Utility e Power chatgpt-browser; pergunta
   curta, longa, português, ferramenta, erro, continuação e chat novo. Sem mistura de
   contextos ou chamada do navegador pelo Qwen.
C. Pool web: duas instâncias permanentes simultâneas, terceira elástica, afinidade correta,
   expiração em 30 min, popup, timeout, erro visual, keep-alive, 429 com espera de 30 s e
   duas tentativas, nenhuma atualização desnecessária e nenhum loop.
D. Ferramentas: terminal Agent Zero, host root somente sob pedido, Docker, browser, desktop,
   VS Code individual, editar/executar, Hello World Docker, abrir no browser, Git commit,
   VNC, downloads, painel/auditoria de incidentes e limpeza do projeto de teste.
E. Imagem: Power recebe/análise PNG/JPG/WebP, gera uma/múltiplas imagens e edita/devolve
   inline; Qwen usa Meta AI somente se pareada e falha claramente se não estiver.
F. Saída no MESMO chat: peça ao ChatGPT web para gerar uma imagem e confira o preview
   inline e o download; depois peça separadamente um ZIP, um TXT e um YAML. Valide em
   cada caso assinatura/formato real, conteúdo marcador, MIME, tamanho > 0, download e
   cópia para o VS Code. Não é necessário repetir aqui a matriz de 90 extensões da
   instalação inicial.
G. Entrada no MESMO chat: envie pela interface/API real uma imagem PNG, um ZIP, um TXT e
   um YAML válidos, cada qual com marcador exclusivo. Peça ao ChatGPT que identifique o
   conteúdo ou uma propriedade estrutural; confirme upload, leitura e ausência de perda.
   Recomece do zero apenas a unidade que precisar de correção.
H. WhatsApp opcional: self-chat exclusivo, texto/imagem/documento/áudio, nenhum prefixo,
   nenhuma resposta a outros chats; bridge Meta AI separada. Não contate terceiros.
I. Contexto/memória: compactação a 85%, falha de memorização não derruba execução, sem
   conclusão precoce, repetição limitada, chat novo limpo e nenhuma memória cruzada.

ROLLBACK E ENTREGA
- Ao encontrar defeito, corrija a fonte persistente, acrescente teste de regressão e repita
  a unidade. Não valide por atalhos nem gere os artefatos no lado errado da integração.
- Se um requisito continuar falhando após diagnóstico razoável, pare a nova versão,
  restaure exatamente o checkpoint, recrie os serviços anteriores e execute smoke tests
  para provar o rollback. Explique o erro, evidências, tentativas e condição para retomar.
- Só mantenha a atualização quando todos os testes aplicáveis passarem. Entregue relatório
  com versão anterior/nova, hashes, backup/rollback, PASS/FAIL de cada grupo, mudanças
  locais preservadas e pendências externas reais (por exemplo cota temporária do provedor).
```

## Atualizações e compatibilidade

A imagem do Agent Zero está fixada por digest porque as customizações montam extensões em caminhos internos. Atualizar o digest sem testar pode quebrar plugins. Faça a mudança em um clone, rode os testes e valide todas as ferramentas antes de produção.

A automação de `chatgpt.com` depende da interface web e pode deixar de funcionar quando o site muda. Este projeto não é afiliado à OpenAI, Meta, WhatsApp, Featherless ou Agent Zero.

## Licenças

Veja [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). O subdiretório `chatgpt-browser-agent` preserva a licença do projeto de origem.
