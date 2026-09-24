# Agent Zero + ChatGPT Browser Stack

Distribuição reproduzível da **stack Agent Zero + ChatGPT Browser** desta instalação: modelo acessado pela interface web do ChatGPT, Featherless, VS Code no navegador, WhatsApp/Meta AI e ferramentas administrativas do host Linux.

**Versão suportada para novas instalações: `v2.12-stack.9`.** A branch `main` aponta para essa release; tags anteriores são histórico/rollback, não alternativas de instalação recomendadas. Instale pelo tag fixo para obter exatamente os arquivos documentados aqui. Não copie o Compose antigo do servidor de origem nem misture arquivos de outras tags.

O repositório contém as customizações funcionais da stack, mas **não contém** contas Google/ChatGPT, sessões do WhatsApp, chats, memórias, cookies, uploads, chaves de API, senhas ou dados pessoais. Cada instalação começa vazia e exige seus próprios logins. Serviços externos à stack (como Nextcloud e projetos pessoais), integrações específicas do Windows do proprietário e dados da máquina original não fazem parte do clone.

> Aviso: esta stack oferece ao Agent Zero acesso `root`, modo privilegiado, PID namespace do host, socket Docker e montagem da raiz Linux em `/host`. Isso equivale a controle administrativo total da máquina quando uma ferramenta é executada. Use somente em servidor dedicado e confiável; leia [SECURITY.md](SECURITY.md) antes de iniciar.

## O que está incluído

- Agent Zero fixado na imagem validada, com dados persistentes e presets sanitizados.
- Modelo **Default** e **Efficiency** via fila serial Featherless.
- Modelo **Power** `chatgpt-browser`, ligado a uma sessão persistente do ChatGPT no Chrome.
- Modelo **Utility** `chatgpt-browser-utility` em uma VNC separada; o próprio ChatGPT
  condensa semanticamente históricos grandes antes da resposta auxiliar.
- Uma conversa do navegador por chat do Agent Zero, evitando misturar contextos.
- Anexos vinculados apenas à mensagem humana atual: uma imagem antiga não é
  reenviada com uma ordem posterior de texto. O mesmo arquivo pode ser anexado
  novamente em outra mensagem quando solicitado explicitamente.
- Prévia de imagem travada é aguardada por até três minutos por imagem; durante
  a espera há progresso visível, e uma falha limpa imagem e rascunho e retorna
  `a imagem não carregou`, sem reenviar a ordem em loop.
- Envio enxuto ao navegador, reutilizando o contexto mantido pelo próprio ChatGPT.
- Três Chromes simultâneos, cada um em seu próprio display/noVNC; a quarta chamada aguarda numa fila, sem criar outro navegador.
- Após "too many requests", todas as novas submissões desse gateway aguardam pelo menos 30 segundos; há até duas retentativas no mesmo chat.
- Avisos de cota são lidos apenas de notificações ativas da interface, nunca do texto do usuário ou do histórico. Um turno já aceito não é reenviado por simples demora; o bridge acompanha o estado do turno e retorna erro explícito se atingir o prazo de segurança de nove minutos.
- Chromium visível por noVNC e painel integrado no Agent Zero.
- VS Code/code-server por chat, executor autenticado e acesso ao Docker do host.
- Proteções contra repetição de respostas e contra memorização que trava o fluxo.
- Nomes automáticos baseados no primeiro pedido real, ignorando a saudação interna
  usada para inicializar o histórico do Agent Zero.
- Integração WhatsApp em self-chat, anexos e geração/edição de imagens via Meta AI.
- Fila Featherless global com concorrência 1, retries e healthcheck.
- Bootstrap idempotente com migrações versionadas: preserva os dados do operador,
  atualiza o bridge mantido pela stack, corrige presets/snapshots legados e remove
  componentes aposentados declarados pela release, sempre com backup.

## Arquitetura

```text
Navegador do usuário
  ├─ :50080  Agent Zero
  │    ├─ Default/Efficiency ──> featherless-queue ──> Featherless API
  │    ├─ Power ───────────────> chatgpt-browser-agent ──> chatgpt.com
  │    ├─ Utility ─────────────> chatgpt-browser-utility ──> chatgpt.com
  │    ├─ ferramenta VS Code ──> code-server + executor
  │    ├─ WhatsApp self-chat ──> bridge interno persistente
  │    └─ ferramenta de imagem > meta-ai-whatsapp ──> Meta AI no WhatsApp
  ├─ :50081  noVNC / Chrome principal 1
  ├─ :50083  noVNC / Chrome principal 2
  ├─ :50085  noVNC / Chrome principal 3
  ├─ :50084  noVNC / Chrome auxiliar dedicado
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
- Pelo menos 10 GB de RAM; 16 GB são recomendados para uso simultâneo.
- Cerca de 15 GB livres para imagens, builds e perfis do navegador.
- Conta Featherless e chave de API para os presets locais.
- Conta ChatGPT própria para o modelo Power.
- WhatsApp próprio apenas se as integrações de WhatsApp/Meta AI forem usadas.

O Chrome é executado no container; não é necessária GPU.

## Instalação rápida

```bash
git clone --branch v2.12-stack.9 --depth 1 https://github.com/Ruan0205/agent-zero-chatgpt-browser-stack.git
cd agent-zero-chatgpt-browser-stack
git describe --tags --exact-match
chmod +x scripts/*.sh
./scripts/setup.sh
```

Edite `.env` (gerado com credenciais internas aleatórias, nunca copie o `.env` da instalação original):

```bash
nano .env
```

No mínimo, configure:

- `API_KEY_OTHER`: chave do Featherless.
- `AUTH_LOGIN` e confirme as senhas aleatórias geradas.
- `WA_PHONE`: telefone com DDI e somente dígitos, se for usar Meta AI/WhatsApp.
- `PUBLIC_HOST` e `PUBLIC_BASE_URL`: IP ou hostname acessível na rede.

Confirme que `API_KEY_OTHER` não continua como placeholder, que `STACK_SCHEMA_VERSION=v2.12-stack.9` e que as portas estão livres. No **primeiro boot**, suba a base e o Chrome antes dos serviços que dependem do login:

```bash
docker compose up -d --build bootstrap featherless-queue meta-ai-whatsapp vscode chatgpt-browser-agent
docker compose ps
```

O Chrome ficará no modo de primeiro login; é esperado que o healthcheck do gateway ainda não passe. Siga o passo **Entrar no ChatGPT Browser** abaixo. Depois de autenticar e fechar apenas a janela do Chrome dentro do noVNC, suba os serviços restantes:

```bash
docker compose up -d --build
docker compose ps
set -a; . ./.env; set +a
./scripts/doctor.sh
```

Em instalações já autenticadas, basta `docker compose up -d --build`. No primeiro build, Docker baixa o Agent Zero, Node, Chrome, Chromium, noVNC, code-server e dependências Go/Python. Pode levar vários minutos.

## Primeiros acessos

Substitua `HOST` pelo IP ou DNS do servidor:

| Componente | Endereço | Autenticação |
|---|---|---|
| Agent Zero | `http://HOST:50080/` | `AUTH_LOGIN` / `AUTH_PASSWORD` |
| ChatGPT Browser 1 | `http://HOST:50081/vnc.html?autoconnect=1&resize=scale` | `VNC_PASSWORD` |
| ChatGPT Browser 2 | `http://HOST:50083/vnc.html?autoconnect=1&resize=scale` | `VNC_PASSWORD` |
| ChatGPT Browser 3 | `http://HOST:50085/vnc.html?autoconnect=1&resize=scale` | `VNC_PASSWORD` |
| ChatGPT Utility | `http://HOST:50084/vnc.html?autoconnect=1&resize=scale` | `VNC_PASSWORD` |
| VS Code | `http://HOST:50082/` | integrado à stack |

O ícone **ChatGPT Browser (VNC)** dentro do Agent Zero consulta o vínculo do chat selecionado e abre a VNC correspondente (`50081`, `50083` ou `50085`), sem mostrar uma conversa de outro chat. Quando a conversa ainda não foi vinculada ou sua instância está ocupada, o painel aguarda em vez de exibir a tela errada. A senha é injetada automaticamente somente após o login no Agent Zero.
As outras duas telas são acessíveis diretamente nas portas 50083 e 50085. O gateway mantém
o mapa entre chat Agent Zero, conversa web e display; pedidos adicionais aguardam o display atribuído.

### 1. Entrar no ChatGPT Browser

1. Abra o noVNC na porta 50081.
2. Entre com `VNC_PASSWORD` se estiver usando o endereço direto.
3. No Chrome exibido, abra `https://chatgpt.com` e faça login manualmente.
4. Confirme que a página normal de conversa aparece e então feche a janela do Chrome. No primeiro acesso, esse fechamento encerra o modo de configuração e inicia automaticamente o pool de navegadores.
5. Aguarde o navegador principal ficar saudável e execute o segundo `docker compose up -d --build` acima. A instância Utility copiará esse perfil para seu próprio volume,
   abrirá uma VNC separada e então o Agent Zero terminará de iniciar.

Os perfis ficam em `data/browser` e `data/browser-utility`. A instância auxiliar usa
uma cópia isolada do login do navegador principal, não exige outro login e mantém
uma conversa auxiliar ativa para operações de resumo. Como essa conversa recebe
conteúdo de vários chats do mesmo Agent Zero, não a use para separar dados de
usuários diferentes. Nenhum perfil deve ser publicado no Git.

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
  O chat do navegador guarda a conversa longa; o Agent Zero retém apenas o
  histórico necessário à execução e compacta localmente ao atingir 80% do
  orçamento. Depois da primeira mensagem, o preset de um chat Power fica
  fixo para não trocar silenciosamente sua conversa vinculada.
- **Utility:** `chatgpt-browser-utility`, endpoint interno
  `http://chatgpt-browser-utility:8000/v1`, um Chrome/VNC dedicado. Históricos que
  excedam o orçamento são lidos em trechos completos e resumidos pelo próprio GPT;
  não são apenas cortados por cabeça/cauda no bridge.
- **Embedding:** `sentence-transformers/all-MiniLM-L6-v2`.

Depois do primeiro boot, alterações feitas na interface ficam em
`data/agent-zero/plugins/_model_config` e não são sobrescritas de forma geral. Uma
migração versionada substitui apenas configurações reconhecidamente legadas da stack
(por exemplo, Utility `google/gemma-4-E2B-it`) e snapshots Utility congelados de chats
Power. Antes de alterar algo, ela salva a versão anterior em
`data/.stack-backups/RELEASE/`. O código de `browser_session_bridge` é propriedade da
stack e é sincronizado com a release; chats, memórias, cookies e credenciais não são
copiados nem apagados.

### Política de limpeza

Arquivos e configurações que deixarem de fazer parte da stack devem ser incluídos em
`agent-zero/seed/obsolete-paths.json`. O bootstrap remove esses caminhos durante a
atualização e guarda a versão anterior no backup da release. A limpeza é deliberadamente
baseada em uma lista explícita: ela nunca deduz que um arquivo desconhecido é descartável,
nem remove chats, sessões, credenciais, uploads, workspaces ou configurações personalizadas.
Caches Python dentro de componentes mantidos pela stack também são descartados.

## Persistência e privacidade

| Pasta | Conteúdo | Publicar? |
|---|---|---|
| `data/agent-zero` | chats, configurações, memória e uploads | Nunca |
| `data/browser` | cookies e perfil autenticado do ChatGPT | Nunca |
| `data/browser-utility` | cópia isolada do perfil e conversa auxiliar | Nunca |
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

# Conferir a migração aplicada nesta instalação
cat "${STACK_DATA_DIR:-./data}/.stack-migrations/${STACK_SCHEMA_VERSION:-v2.12-stack.9}.json"

# Diagnóstico automatizado
set -a; . ./.env; set +a
./scripts/doctor.sh
```

Os containers do pool principal, Utility e Agent Zero têm limites de RAM/swap
no Compose. Eles evitam que essas instâncias consumam toda a memória do host;
em carga extrema um processo do navegador ainda pode ser reiniciado, mas o
servidor não deve depender do OOM global para recuperar memória. O painel
**Chats com erro** permite solicitar manualmente a análise do histórico completo e da interface, remover um relatório individual ou usar
**Limpar lista** para remover todos os relatórios exibidos.

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
  node --test *.test.js

# Smoke test isolado das quatro imagens construídas
./scripts/validate-images.sh

# Saúde com a stack em execução
set -a; . ./.env; set +a
./scripts/doctor.sh
```

`doctor.sh` verifica montagem do plugin de mídia, código do bridge e outbox, mas
**não comprova que um PDF ou imagem gerado no ChatGPT apareceu na interface do
Agent Zero**. Para aprovar uma instalação, faça também o teste ponta a ponta no
mesmo chat: solicite um PDF com marcador único, confirme `%PDF-`, bytes não vazios,
anexo visível e download funcional; repita com imagem. Se um desses passos falhar,
inspecione o chat, o gateway, o outbox, o plugin e o handler da interface antes de
declarar sucesso. O retorno apenas textual “arquivo pronto” não é aprovação.
No mesmo chat, teste também a sequência **imagem que não carrega → resposta de
falha → nova ordem só de texto**: a chamada final deve ter `attachments=0`,
usar a mesma conversa no navegador e executar a ordem sem tentar a imagem antiga.

## Solução de problemas

### HTTP 429 / rate limit

O gateway bloqueia novas submissões por pelo menos 30 segundos após "too many requests"
e tenta novamente até duas vezes no mesmo chat. As três VNCs e a instância Utility
compartilham esse bloqueio da conta.
A fila Featherless aceita somente uma chamada upstream por vez. Se o provedor continuar
rejeitando, aguarde a janela de limite; criar mais containers não aumenta a cota.

### `The message you submitted was too long`

Cada chat do Agent Zero recebe uma conversa própria no ChatGPT Browser e o histórico anterior não é reenviado integralmente. Se ainda ocorrer, abra um novo chat no Agent Zero ou reduza anexos/instruções excepcionalmente grandes.

### noVNC abre, mas o ChatGPT não responde

Verifique visualmente a sessão, pop-ups e o estado do login. Depois veja:

```bash
docker compose logs --tail=300 chatgpt-browser-agent
curl http://127.0.0.1:50081/vnc.html
```

### Modelo Featherless indisponível

Modelos podem estar cold, fora de deployment ou temporariamente indisponíveis. Altere o preset Default/Efficiency na interface ou em `data/agent-zero/plugins/_model_config/presets.yaml` com backup. `DEFAULT_MODEL` no `.env` controla o fallback inicial, não reescreve automaticamente os presets persistidos. O Utility desta release é `chatgpt-browser-utility`, não um modelo Featherless.

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
Ruan0205/agent-zero-chatgpt-browser-stack em um servidor Linux. Instale SOMENTE a
release suportada v2.12-stack.9. Trabalhe até que os testes aplicáveis terminem;
não considere "containers subiram" como validação suficiente. Não misture versões,
nem replique Compose, volumes ou scripts de uma instalação anterior.

REGRAS DE SEGURANÇA E ESCOPO
1. Antes de alterar o host, registre distribuição, kernel, CPU, RAM, swap, discos,
   portas em uso, Docker/Compose, firewall e serviços existentes. Não pare nem remova
   aplicações alheias à stack.
2. Clone `https://github.com/Ruan0205/agent-zero-chatgpt-browser-stack.git` com
   `--branch v2.12-stack.9 --depth 1`. Confirme `git describe --tags --exact-match`
   e anote o SHA do commit. Não reutilize cookies, sessões, chats, bancos, arquivos
   `.env` ou credenciais de outra instalação. Não exporte integrações pessoais do
   servidor original; Nextcloud e projetos alheios não fazem parte desta stack.
3. A stack concede ao Agent Zero root, privileged, PID do host, Docker socket e `/host`.
   Explique isso claramente e confirme que o destino é um servidor dedicado/confiável.
4. Gere localmente, com CSPRNG, todas as credenciais internas: AUTH_PASSWORD,
   ROOT_PASSWORD, RFC_PASSWORD, VNC_PASSWORD (máximo 8 caracteres),
   VSCODE_EXEC_TOKEN, BROWSER_POOL_NOTICE_TOKEN e WHATSAPP_JOURNAL_TOKEN. Grave-as
   somente no `.env` com permissão 0600. Ao final, entregue-as ao proprietário uma única
   vez sem publicar em logs, Git, histórico ou README.
5. Peça ao proprietário somente: (a) API key e conta Featherless; (b) qual modelo
   Default deseja usar, se diferente do padrão; o Utility usa a VNC dedicada;
   (c) login manual da
   própria conta ChatGPT/Gmail dentro do noVNC; (d) telefone/pareamento manual do próprio
   WhatsApp, se quiser usar WhatsApp ou Meta AI; (e) IP/DNS e portas desejadas. Nunca peça
   senha do Gmail/ChatGPT ou código do WhatsApp por texto: abra a interface para o usuário.
6. Não conclua com segredos de exemplo, credenciais vazias ou serviços desprotegidos.

INSTALAÇÃO
1. Instale/verifique Docker Engine 24+, Compose v2, Git, curl e OpenSSL conforme a
   distribuição. Não use Docker-in-Docker.
2. No clone fixado acima, execute `chmod +x scripts/*.sh` e `./scripts/setup.sh`.
3. Preencha `.env`, mantendo `STACK_SCHEMA_VERSION=v2.12-stack.9` e `STACK_DATA_DIR`
   em disco com espaço suficiente. Confirme que `API_KEY_OTHER`, IP/DNS e telefone
   opcional não estão com exemplos. Use `HOST_ROOT_MOUNT=/` somente após ciência do
   proprietário. Não imprima `.env` em logs/relatório.
4. Execute `docker compose config --quiet` e os testes locais do bridge indicados no
   README. No primeiro boot execute `docker compose up -d --build bootstrap
   featherless-queue meta-ai-whatsapp vscode chatgpt-browser-agent`;
   o navegador ficará temporariamente unhealthy até o login manual. Não use um
   Dockerfile ou Compose guardado fora deste tag; confira os bind mounts resolvidos.
5. Abra `http://HOST:50081/vnc.html` depois da primeira fase, entregue o controle
   ao usuário para autenticar o ChatGPT e nunca exporte o perfil. Feche apenas
   a janela inicial do Chrome no noVNC para o gateway iniciar.
6. Após o login, execute
   `docker compose up -d --build` para subir Utility e Agent Zero. Aguarde os
   healthchecks. Investigue/repare qualquer restart, unhealthy persistente, traceback,
   conflito de porta ou permissão. Rode `./scripts/doctor.sh` após login e valide
   que uma recriação limpa do Agent Zero v2.12 não perde os plugins oficiais nem
   `_chatgpt_browser_media`.
   Confirme que o Chrome permanece logado após recriar o container e que a VNC Utility em
   `http://HOST:50084/vnc.html` clonou o perfil sem pedir outra senha.
7. Se Meta AI for desejada, use Agent Zero > Settings > External > Meta AI WhatsApp
   Bridge para gerar o código. A conexão deve ser opcional. Configure separadamente o
   WhatsApp self-chat do Agent Zero e jamais habilite respostas para contatos não
   autorizados.

MATRIZ OBRIGATÓRIA DE TESTES — EXECUTE E GUARDE EVIDÊNCIAS
A. Infra: tag/SHA correto; Compose resolvido e mounts iguais à release; todos os
   healthchecks; restart individual; recriação limpa; reboot do host; persistência
   de configurações; ausência de segredos no Git; portas; uso de CPU/RAM/disco;
   logs sem boot-loop; `doctor.sh` e testes Node/Python do repositório.
B. Modelos: Default Qwen/Featherless, Efficiency, Utility e Power chatgpt-browser.
   Para cada um: pergunta curta, resposta longa/coesa, português, chamada de ferramenta,
   erro de ferramenta, continuação no mesmo chat e novo chat isolado. Confirme que Qwen
   nunca abre ChatGPT como modelo principal, que Power cria um chat web próprio por chat
   Agent Zero e que Utility usa somente a VNC auxiliar. Envie ao Utility um histórico
   sintético maior que 32 mil tokens e confirme compactação sem corte de trechos.
C. Browser pool: três conversas simultâneas em três VNCs distintas; quarta demanda
   aguarda na fila, sem escala; afinidade Agent-Zero-chat ↔ ChatGPT-chat ↔ VNC;
   popup; timeout; página travada; um 429 e duas retentativas com 30 s; keep-alive de
   operação lenta; sem refresh a cada mensagem; sem chat cruzado ou loop.
D. Ferramentas: terminal dentro do container; terminal root no host apenas quando pedido;
   Docker; navegador do Agent Zero; desktop; VS Code por chat; criar/editar/salvar arquivo;
   executar comando; criar Docker Hello World; abrir no navegador; Git init/commit; remover
   somente o projeto de teste; VNC integrado; painel de incidentes; botão **Chat com erro**.
   Confirme que nenhuma resposta inicia auditoria automaticamente e que o botão analisa
   o histórico completo do chat selecionado junto com o estado visível da interface.
E. Imagens: no Power, enviar PNG/JPG/WebP junto do prompt, analisar, gerar uma e várias
   imagens, editar imagem anterior e devolver inline. No Qwen, testar a ferramenta Meta AI
   somente se o usuário a pareou; sem pareamento deve falhar de forma clara e limitada.
   O ChatGPT Browser não deve desviar uma tarefa de código para geração de imagem.
   Simule uma prévia de imagem travada: confirme progresso visível, espera de até três
   minutos por imagem, limpeza do rascunho e resposta de falha sem reenvio. Depois,
   no mesmo chat, envie uma ordem só de texto e confirme `attachments=0` e o mesmo
   vínculo de conversa. Reanexar explicitamente a imagem deve permitir nova tentativa.
F. Saída ChatGPT→Agent Zero, no MESMO chat, um item por vez, validando assinatura real,
   conteúdo marcador, MIME, tamanho > 0, anexo na interface, preview quando aplicável,
   download e cópia no VS Code antes de avançar. No caso PDF, exija cabeçalho `%PDF-`
   e leitura efetiva do arquivo baixado; não aceite só o texto "arquivo pronto".
   Verifique a cadeia navegador→gateway→`/data/outbox`→`/a0/usr/browser-media`→
   ferramenta→handler UI. Extensões obrigatórias:
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
I. Memória/contexto: compactação a 80% nos chats Power, saída de ferramenta longa salva
   integralmente em arquivo e limitada apenas na cópia enviada ao modelo, timeout do
   cliente Power maior que o orçamento do bridge, erro da extensão de memória não interrompe tarefa,
   tarefa não termina pela metade, resposta repetida é limitada, chat novo recebe somente
   instruções fixas necessárias, sem vazar histórico de outro chat.

CRITÉRIO DE APROVAÇÃO
- Não burle os testes criando arquivos diretamente no Agent Zero: nos testes F eles devem
  ser solicitados ao ChatGPT web; nos testes G devem ser enviados pela interface/API real.
- Corrija cada defeito na fonte persistente, adicione regressão e repita o caso desde o
  início. Falhas externas (cota/429) devem cumprir retentativas e ser registradas, nunca
  disfarçadas como aprovação.
- Não confunda teste de montagem/healthcheck com teste ponta a ponta. Registre
  separadamente resultado backend (arquivo e anexo persistido) e resultado visual
  (preview/download realmente utilizável pelo usuário).
- Só declare concluído com relatório PASS/FAIL, hashes/nomes das evidências, versões e
  instruções de acesso. Se algum teste não puder passar, diga exatamente qual, preserve a
  stack estável e não alegue 100%. Não afirme que fez os 90 formatos sem registro
  individual de cada um.
```

## Prompt completo para atualização por outra IA

Este segundo prompt preserva dados de uma instalação existente e exige rollback se a atualização não puder ser validada.

```text
Atualize uma instalação existente de Ruan0205/agent-zero-chatgpt-browser-stack para
a release pública suportada v2.12-stack.9 sem perder chats, memórias, uploads,
workspaces, configurações, sessões do ChatGPT/WhatsApp ou credenciais. Esta release
substitui as antigas para uso normal; tags antigas servem apenas para rollback.
Você tem autorização para reiniciar apenas os serviços desta stack. Não altere
aplicações alheias nem copie cegamente arquivos de outra máquina.

CHECKPOINT E INVENTÁRIO — OBRIGATÓRIOS ANTES DA PRIMEIRA MUDANÇA
1. Identifique diretório do repositório, commit/tag atual, arquivos modificados, imagens e
   digests, Compose resolvido, volumes/mounts, permissões, containers, healthchecks e portas.
   Classifique cada divergência como código da stack, personalização do usuário ou
   segredo/dado persistente. Não suponha que `git pull` atualiza o runtime montado.
2. Pare a stack de forma consistente e crie checkpoint datado de: repositório, `.env`,
   Compose resolvido, `STACK_DATA_DIR`, perfis/sessões, chats, memória e workspaces. Não
   inclua o backup no Git. Gere SHA-256, teste a leitura do archive e registre procedimento
   de restauração. Reinicie a versão antiga se a preparação demorar.
3. Nunca substitua `.env`, `data/`, cookies, bancos ou chats pelos exemplos públicos.
   Preserve também arquivos locais desconhecidos; compare antes de mesclar.

ATUALIZAÇÃO
1. Busque tags/releases e notas oficiais. Faça fetch sem apagar alterações. Crie branch de
   atualização e compare migrations, Dockerfiles, plugins, prompts e schema de settings.
   Fixe `v2.12-stack.9`, registre o SHA e rejeite arquivos misturados de tags antigas.
2. Mescle a release pública; mantenha segredos somente no `.env`; ajuste
   `STACK_SCHEMA_VERSION=v2.12-stack.9` sem apagar outros valores; execute
   `docker compose config --quiet`; construa imagens antes da parada final.
3. Recrie serviços em ordem de dependência. Aplique migrations idempotentes. Confirme que
   a correção v2.12 que copia arquivos oficiais ausentes para `/a0` permanece funcional.
   Confirme também a existência de `data/.stack-migrations/*.json`: a migração deve
   sincronizar `browser_session_bridge`, trocar somente Utility legado Gemma pelo
   `chatgpt-browser-utility` e atualizar a cópia Utility congelada em chats Power, mantendo
   backups em `data/.stack-backups/`. Compare os hashes dos arquivos da release
   com as fontes efetivas dos containers/mounts. Não aceite apenas o novo container
   com estado antigo nem substitua presets personalizados fora da migração declarada.
   Remova também todo componente aposentado listado em `obsolete-paths.json`; antes de
   acrescentar um caminho, prove que ele pertence à stack e não contém dados do operador.
4. Não reconecte, apague ou regenere sessões. A bridge Meta AI continua opcional e sua tela
   fica em Settings > External, ao lado do WhatsApp.

MATRIZ OBRIGATÓRIA PÓS-ATUALIZAÇÃO
A. Infra/persistência: tag/SHA, hashes de fonte e runtime, Compose/mounts,
   `doctor.sh`, testes do repositório, healthchecks, restarts, clean recreation,
   reboot, versões/digests, logs, CPU/RAM/disco, portas e prova de que chats,
   memórias, uploads, workspaces, settings e sessões anteriores continuam presentes.
B. Modelos: Default Qwen/Featherless, Efficiency, Utility e Power chatgpt-browser; pergunta
   curta, longa, português, ferramenta, erro, continuação e chat novo. Sem mistura de
   contextos ou chamada do navegador pelo Qwen como modelo principal. Teste uma chamada
   Utility grande para confirmar compactação sem corte e a VNC auxiliar na porta 50084.
C. Pool web: três instâncias permanentes simultâneas, cada uma em VNC separada; quarta
   chamada na fila, sem escala; afinidade correta, popup, timeout, erro visual, keep-alive,
   429 com espera global mínima de 30 s e duas tentativas, nenhuma atualização
   desnecessária e nenhum loop. Confirme que a auditoria só é iniciada manualmente.
D. Ferramentas: terminal Agent Zero, host root somente sob pedido, Docker, browser, desktop,
   VS Code individual, editar/executar, Hello World Docker, abrir no browser, Git commit,
   VNC, downloads, painel/auditoria de incidentes e limpeza do projeto de teste.
E. Imagem: Power recebe/análise PNG/JPG/WebP, gera uma/múltiplas imagens e edita/devolve
   inline; Qwen usa Meta AI somente se pareada e falha claramente se não estiver.
   Confirme também que uma imagem travada não é reenviada com a próxima ordem de texto:
   progresso, timeout, rascunho limpo, `attachments=0` na ordem seguinte e vínculo
   Agent Zero ↔ chat do navegador inalterado. Um reenvio explícito deve continuar possível.
F. Saída no MESMO chat: peça ao ChatGPT web para gerar uma imagem e confira o preview
   inline e o download; depois peça separadamente PDF, ZIP, TXT e YAML. Valide em
   cada caso assinatura/formato real, conteúdo marcador, MIME, tamanho > 0, anexo
   visível, download e cópia para o VS Code. Para PDF, leia o arquivo baixado e
   comprove `%PDF-`. Confira logs do gateway, outbox, plugin e handler se o ChatGPT
   disser que criou o arquivo mas ele não aparecer. Não é necessário repetir aqui
   a matriz inteira de extensões da instalação inicial.
G. Entrada no MESMO chat: envie pela interface/API real uma imagem PNG, um PDF, um ZIP,
   um TXT e um YAML válidos, cada qual com marcador exclusivo. Peça ao ChatGPT que identifique o
   conteúdo ou uma propriedade estrutural; confirme upload, leitura e ausência de perda.
   Recomece do zero apenas a unidade que precisar de correção.
H. WhatsApp opcional: self-chat exclusivo, texto/imagem/documento/áudio, nenhum prefixo,
   nenhuma resposta a outros chats; bridge Meta AI separada. Não contate terceiros.
I. Contexto/memória: compactação a 80% nos chats Power, preservando a pergunta atual
   após longas sequências de ferramentas; saída extensa integral em arquivo, prévia
   limitada para o modelo; timeout do cliente maior que o orçamento do bridge;
   falha de memorização não derruba execução, sem
   conclusão precoce, repetição limitada, chat novo limpo e nenhuma memória cruzada.

ROLLBACK E ENTREGA
- Ao encontrar defeito, corrija a fonte persistente, acrescente teste de regressão e repita
  a unidade. Não valide por atalhos nem gere os artefatos no lado errado da integração.
- Se um requisito continuar falhando após diagnóstico razoável, pare a nova versão,
  restaure exatamente o checkpoint, recrie os serviços anteriores e execute smoke tests
  para provar o rollback. Explique o erro, evidências, tentativas e condição para retomar.
- Não confunda logs de geração, healthcheck ou a frase "arquivo pronto" com
  visualização/download realmente funcionais na interface do Agent Zero.
- Só mantenha a atualização quando todos os testes aplicáveis passarem. Entregue relatório
  com versão anterior/nova, hashes, backup/rollback, PASS/FAIL de cada grupo, mudanças
  locais preservadas e pendências externas reais (por exemplo cota temporária do provedor).
```

## Atualizações e compatibilidade

A imagem do Agent Zero está fixada por digest porque as customizações montam extensões em caminhos internos. Atualizar o digest sem testar pode quebrar plugins. Faça a mudança em um clone, rode os testes e valide todas as ferramentas antes de produção.

A automação de `chatgpt.com` depende da interface web e pode deixar de funcionar quando o site muda. Este projeto não é afiliado à OpenAI, Meta, WhatsApp, Featherless ou Agent Zero.

## Licenças

Veja [LICENSE](LICENSE) e [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). O subdiretório `chatgpt-browser-agent` preserva a licença do projeto de origem.
