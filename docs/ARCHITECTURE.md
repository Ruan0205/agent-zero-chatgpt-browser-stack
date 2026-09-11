# Arquitetura técnica

## Objetivo

Esta distribuição transforma o Agent Zero em um orquestrador local com três caminhos de inferência e um conjunto de ferramentas persistentes. O Compose usa uma única rede bridge `ai-shared`; somente as interfaces destinadas ao operador são publicadas no host.

## Fluxos de inferência

### Featherless

O Agent Zero chama `http://agent-zero-featherless-queue:8000/v1`. O proxy FastAPI preserva `Authorization`, serializa todo o tráfego com `asyncio.Semaphore(1)` e mantém o slot durante o streaming. Erros 408, 409, 425, 429, 5xx e estados temporários de deployment usam backoff limitado. Assim, duas partes do Agent Zero não concorrem simultaneamente pela mesma cota upstream.

### ChatGPT Browser

O serviço executa Google Chrome em Xvfb, com fluxbox e x11vnc. websockify/noVNC publica a tela em 6080 no container e 50081 no host. Um gateway OpenAI-compatible fica apenas na rede Docker, na porta 8000.

O adaptador converte mensagens do Agent Zero em uma instrução compacta para o ChatGPT, exige uma resposta estruturada e a devolve como streaming OpenAI-compatible. O plugin `browser_session_bridge` acrescenta um identificador derivado do chat atual, permitindo uma conversa web independente para cada chat do Agent Zero.

O gateway mantém fila interna, acompanha a URL da conversa, trata navegação, recarrega somente em recuperação e aplica duas tentativas espaçadas para 429. O perfil Chrome, os cookies e a última URL ficam no volume `data/browser`.

### Presets

`agent-zero/seed/plugins/_model_config/presets.yaml` define Default, Efficiency e Power. O seed só é copiado quando o arquivo persistente não existe. Depois disso, a interface do Agent Zero é a fonte de verdade da instalação.

## Ferramentas

### VS Code

O serviço `vscode` combina code-server e um executor HTTP local autenticado por `VSCODE_EXEC_TOKEN`. O plugin `_vscode` apresenta o editor na lateral, cria um diretório por chat e encaminha operações de terminal/arquivos. O workspace é persistido em `data/workspace/chats`.

### Acesso ao host

O Agent Zero recebe:

- `privileged: true`;
- `pid: host`;
- `/var/run/docker.sock`;
- `${HOST_ROOT_MOUNT}` montado em `/host`;
- contexto operacional com uma regra explícita: somente acessar o host quando o usuário pedir.

O método previsto para comandos no host é `nsenter` usando namespaces em `/host/proc/1/ns`. O acesso técnico é integral; a regra de autorização é comportamental, não uma barreira de kernel.

### WhatsApp e Meta AI

Há dois estados separados:

1. O plugin de WhatsApp do Agent Zero usa `data/whatsapp` e permite self-chat, anexos e respostas do agente.
2. `meta-ai-whatsapp` usa `data/meta-ai-whatsapp`, pareia com um número próprio e expõe endpoints OpenAI-compatible somente na rede Docker. O plugin `_meta_ai_image` chama esse serviço para geração e edição de imagens.

Nenhuma sessão é incluída no Git.

## Bootstrap

O serviço one-shot `bootstrap` roda antes do Agent Zero. Ele:

1. cria toda a árvore persistente;
2. copia settings, presets, contexto e o bridge de sessão apenas se ausentes;
3. gera `vnc-runtime.json` com senha e porta;
4. deixa o arquivo acessível apenas ao root do host/container.

O painel noVNC busca esse JSON por uma rota do Agent Zero protegida pelo login e monta a URL de conexão automática. A porta VNC continua exigindo senha para acessos diretos.

## Inicialização e recuperação

Todos os serviços duradouros usam `restart: unless-stopped`. O Agent Zero espera bootstrap, queue, VS Code e ChatGPT Browser estarem prontos. Após reinício do host, o Docker restaura a stack se o daemon estiver habilitado (`systemctl enable --now docker`).

## Fronteiras de dados

Código e templates ficam no repositório. Estado mutável fica sob `STACK_DATA_DIR`. Essa separação permite publicar o código sem copiar identidades, e fazer backup/restore do estado sem modificar o Git.
