# Arquitetura técnica

## Objetivo

Esta distribuição transforma o Agent Zero em um orquestrador local com três caminhos de inferência e um conjunto de ferramentas persistentes. O Compose usa uma única rede bridge `ai-shared`; somente as interfaces destinadas ao operador são publicadas no host.

## Fluxos de inferência

### Featherless

O Agent Zero chama `http://agent-zero-featherless-queue:8000/v1`. O proxy FastAPI preserva `Authorization`, serializa todo o tráfego com `asyncio.Semaphore(1)` e mantém o slot durante o streaming. Erros 408, 409, 425, 429, 5xx e estados temporários de deployment usam backoff limitado. Assim, duas partes do Agent Zero não concorrem simultaneamente pela mesma cota upstream.

### ChatGPT Browser

O serviço executa três desktops Xvfb separados (:99, :100 e :101), cada um com
fluxbox, x11vnc e websockify/noVNC próprios. As telas são publicadas nas portas
50081, 50083 e 50085 do host. O gateway OpenAI-compatible fica apenas na rede
Docker, na porta 8000. O auditor usa um quarto display oculto (:102), sem VNC,
somente quando o operador solicita manualmente **Chat com erro**.

O adaptador converte mensagens do Agent Zero em uma instrução compacta para o ChatGPT, exige uma resposta estruturada e a devolve como streaming OpenAI-compatible. O plugin `browser_session_bridge` acrescenta um identificador derivado do chat atual, permitindo uma conversa web independente para cada chat do Agent Zero.

O gateway inicia três instâncias permanentes e nunca escala acima disso. Cada
chat do Agent Zero permanece associado à sua URL web e a um dos três displays;
chamadas simultâneas adicionais aguardam na fila do display atribuído. O mapa
persistente de chats permanece no gateway, inclusive quando atribuições antigas
de instâncias elásticas são remapeadas para as três vagas fixas. Cada vaga
serializa seus envios para não misturar nem duplicar respostas.

O contexto longo é mantido pelo próprio ChatGPT. O Agent Zero envia somente o delta necessário, o contrato de ferramentas e a solicitação atual. A página não é atualizada a cada mensagem: há reload na criação/recuperação, duas novas tentativas após 429 com espera de 30 segundos e keep-alive SSE enquanto operações longas são processadas. Artefatos são capturados da resposta HTTP autenticada disparada pelo controle exato daquela resposta e gravados no outbox compartilhado, mesmo quando a UI omite parâmetros opcionais do nome do download.
Marcadores de cooldown em `data/browser/provider-cooldown` são lidos tanto pelo
gateway principal quanto pelo Utility; depois de uma rejeição por excesso de
requisições, qualquer novo envio desses serviços aguarda pelo menos 30 segundos.

O perfil Chrome, cookies, mapa chat↔URL, pool, outbox e incidentes ficam sob
`data/browser`. O auditor não é acionado automaticamente a cada prompt. Quando
o operador clica **Chat com erro**, ele recebe o histórico persistido do chat
selecionado e um retrato da interface, usa uma conversa temporária não listada
e remove essa conversa ao terminar. O auditor não dispara auditoria para si mesmo.

### ChatGPT Browser Utility

Um segundo serviço usa a mesma imagem, mas possui apenas uma instância Chrome,
um volume independente (`data/browser-utility`) e sua própria tela noVNC na porta
50084. No primeiro start, copia o perfil autenticado do browser principal; os
dois serviços nunca escrevem simultaneamente no mesmo perfil. O modelo Utility
dos três presets aponta para `http://chatgpt-browser-utility:8000/v1`.

As chamadas auxiliares compartilham uma única conversa web ativa, serializada
pelo pool. O bridge envia a tarefa completa a cada chamada e instrui o GPT a
ignorar pedidos anteriores, que podem pertencer a outro chat Agent Zero. Quando
um pedido de compactação excede o orçamento do navegador, o transporte divide
o texto em trechos sem perder bytes, pede ao GPT uma síntese factual de cada
trecho e envia as sínteses para a resposta final. Isso não elimina os limites
do serviço ChatGPT nem transforma um resumo em cópia integral do histórico.

### Presets

`agent-zero/seed/plugins/_model_config/presets.yaml` define Default, Efficiency e Power.
O seed só é copiado quando o arquivo persistente não existe. Depois disso, a interface
do Agent Zero é a fonte de verdade, exceto por migrações versionadas e estreitas de
compatibilidade (como retirar o antigo Utility Gemma).

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
2. `meta-ai-whatsapp` usa `data/meta-ai-whatsapp`, pareia com um número próprio e expõe endpoints OpenAI-compatible somente na rede Docker. O plugin `_meta_ai_image` chama esse serviço para geração e edição de imagens. O pareamento é opcional e aparece em **Settings > External > Meta AI WhatsApp Bridge**, ao lado da configuração do WhatsApp; abrir a tela não conecta conta alguma.

O modelo `chatgpt-browser` usa a criação/edição nativa do ChatGPT e não roteia imagens pela Meta AI. Modelos Featherless só usam a bridge Meta AI quando ela está pareada e a ferramenta é selecionada.

Nenhuma sessão é incluída no Git.

## Bootstrap

O serviço one-shot `bootstrap` roda antes do Agent Zero. Ele:

1. cria toda a árvore persistente;
2. copia settings, presets e contexto apenas se ausentes;
3. executa `migrate_persistent_state.py`, que sincroniza o bridge de sessão mantido pela
stack e migra presets/snapshots antigos com backup atômico e marcador de versão;
4. gera `vnc-runtime.json` com senha e porta;
5. deixa o arquivo acessível apenas ao root do host/container.

As migrações podem rodar novamente sem alterar um estado já atualizado. Os backups
ficam em `data/.stack-backups/RELEASE` e o resultado da última passagem em
`data/.stack-migrations/RELEASE.json`. Isso evita que atualizar somente imagens mantenha
uma cópia antiga do bridge ou do modelo Utility no volume persistente.

Cada release também pode declarar caminhos aposentados em
`agent-zero/seed/obsolete-paths.json`. Somente esses caminhos exatos e caches sob raízes
gerenciadas são removidos. A validação impede saída de `STACK_DATA_DIR`, e o conteúdo é
copiado para o backup da release antes da exclusão. Essa lista explícita evita acumular
componentes antigos sem transformar a limpeza em um coletor destrutivo de dados do usuário.

O painel noVNC busca esse JSON por uma rota do Agent Zero protegida pelo login e monta a URL de conexão automática. A porta VNC continua exigindo senha para acessos diretos.

## Inicialização e recuperação

Todos os serviços duradouros usam `restart: unless-stopped`. O Agent Zero espera bootstrap, queue, VS Code e ChatGPT Browser estarem prontos. Após reinício do host, o Docker restaura a stack se o daemon estiver habilitado (`systemctl enable --now docker`).

A imagem customizada do Agent Zero v2.12 mescla os arquivos oficiais ausentes de `/git/agent-zero` em `/a0` durante o build. Isso evita o boot-loop observado em recriações limpas quando o runtime já contém `run_ui.py`, mas ainda não contém plugins oficiais que o core importa.

## Fronteiras de dados

Código e templates ficam no repositório. Estado mutável fica sob `STACK_DATA_DIR`. Essa separação permite publicar o código sem copiar identidades, e fazer backup/restore do estado sem modificar o Git.
