# Agent Zero + ChatGPT Browser Stack

Clone reproduzível da stack Agent Zero desta instalação. A release atual é
**`v2.12-stack.17`**. Instale pelo tag; `main` representa a mesma fonte depois da
publicação. Tags anteriores servem apenas para rollback.

O Git contém código, migrações e exemplos. Não contém contas, chaves, senhas,
cookies, chats, memórias, uploads, sessões do WhatsApp nem dados do operador.

## O que esta release entrega

- três sessões permanentes do ChatGPT Browser, com afinidade por chat, fila por
  display, contexto web preservado, VNC e tratamento de respostas/mídia demoradas;
- modo padrão sem API externa: ChatGPT Browser é chat, Utility/compactador e
  reparador; o navegador principal também continua disponível para geração/edição;
- Kimi-K3/We64 opcional com contexto configurado em 1M para chat, Utility e
  reparador, até dois subagentes Kimi e bridge de imagem nativa;
- transporte Kimi por `tools` e `tool_calls` nativos na API, com esquemas reais
  do catálogo Agent Zero, sem converter texto DSML em ação com efeito;
- compactação Kimi com prompts específicos que preservam pedido ativo, decisões,
  identificadores e restrições; limite operacional de 90% e timeout de até 540 s;
- delegação de imagens Kimi para subagente Browser: geração e edição da imagem
  recém-gerada, arquivo real com hash e publicação no chat de origem; edição
  aceita no navegador recebe marcador persistente para não ser reenviada;
- respostas Kimi atômicas, retentativas apenas do pedido de modelo e adaptação
  segura de DSML/JSON para chamadas nativas, inclusive alias `tasks.list_tasks`;
- fila de mensagens transacional em SQLite: sobrevive a falha/restart, mantém
  anexos, permite reordenar, editar, intervir no turno ativo e retomar uma
  execução incerta sem replay cego; dois envios simultâneos do mesmo rascunho
  produzem apenas uma submissão;
- reconciliação HTTP leve durante execuções ativas para recuperar eventos de
  histórico perdidos mesmo quando o WebSocket ainda aparenta estar saudável,
  usando uma cauda autoritativa limitada que não depende do cursor do navegador;
- limpeza integral da fila ao apagar chats, com tombstone que impede workers
  atrasados de recriarem estado excluído;
- diretório de trabalho separado por chat e instruções explícitas para não ler
  arquivos de outro chat sem pedido;
- reparador isolado, diagnóstico somente leitura, aprovação explícita para mudar,
  segunda aprovação para retomar o chat e botão de melhoria global;
- painel **Chats com erro**, VNCs/status, exclusão/limpeza de auditorias, indicação
  de resposta nova e VNC de reparo apenas quando o backend browser está escolhido;
- ferramentas de diagnóstico (`job_status`, `browser_bridge_status`,
  `artifact_verify`, `server_diagnostics`, `project_check`) e alias de tarefas;
- busca pública limitada quando o SearXNG não tem motor funcional; uma busca
  vazia não é apresentada como resultado concluído;
- verificação de artefatos, imagens nativas em alta resolução, capturas não uniformes
  e obrigação de o revisor visual realmente carregar a evidência recebida;
- proteção contra loops de terminal/subagente, polling sem progresso, chamadas
  repetidas, respostas vazias enquanto o modelo ainda pensa e sintaxe de ferramenta;
- exclusão segura de memórias com prévia, IDs confirmados e checkpoint integral;
- painel mensal e histórico de entrada/saída, estimativas de custo e medidor de
  tokens por segundo; botão manual para compactar contexto;
- nomes coerentes, ordenação por atividade, **Pin to Top**, fila visual e som de
  notificação ao concluir;
- VS Code isolado por chat, acesso administrativo ao host Linux e instruções para
  SSH da máquina Windows sem confundir host, container e máquina externa;
- WhatsApp/Meta AI opcional por profile, nunca obrigatório para subir a stack.

Detalhes técnicos estão em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), limites de
segurança em [SECURITY.md](SECURITY.md), mudanças em [CHANGELOG.md](CHANGELOG.md) e
os testes reais obrigatórios em
[docs/REGRESSION_CHECKLIST.md](docs/REGRESSION_CHECKLIST.md).

## Modos de inferência

| Modo | Chat | Utility/compactação | Reparador | Profiles |
| --- | --- | --- | --- | --- |
| Browser (padrão) | ChatGPT Browser | Browser Utility | Browser Repair | `browser-utility,browser-repair` |
| Kimi opcional | `kimi-k3` via We64 | `kimi-k3` | `kimi-k3` | `kimi` |

O browser principal continua ativo no modo Kimi para o perfil Power e para ações
explicitamente delegadas a ele. Se Kimi não for configurado, nenhuma chave de API
externa é necessária e a stack volta ao fluxo browser-only completo.

O serviço `featherless-queue` conserva o nome por compatibilidade com instalações
antigas, mas na configuração atual é apenas o adaptador serial OpenAI-compatible do
Kimi/We64. O endpoint oficial documentado pela We64 é `https://api.we64.com/v1`;
se a ativação da sua chave informar outro host, preserve exatamente esse host em
`KIMI_UPSTREAM_URL`.

## Requisitos

- Linux x86_64 com Docker Engine e Docker Compose v2;
- recomendação: 6 CPU, 10 GiB de RAM, swap e 40 GiB livres;
- acesso às portas configuradas em `.env` (50080–50087 por padrão);
- uma conta ChatGPT para autenticar as VNCs;
- opcional: chave We64 válida para o modelo exato `kimi-k3`;
- opcional: conta WhatsApp se o profile `whatsapp` for habilitado;
- `git`, `curl`, `openssl` e shell POSIX.

## Instalação

```bash
git clone --branch v2.12-stack.17 --depth 1 \
  https://github.com/Ruan0205/agent-zero-chatgpt-browser-stack.git
cd agent-zero-chatgpt-browser-stack
./scripts/setup.sh
```

O setup gera apenas credenciais internas aleatórias e preserva um `.env` existente.
Escolha um modo:

```bash
# Sem API externa (padrão)
./scripts/configure-integrations.sh browser

# Kimi/We64: primeiro edite API_KEY_OTHER e, se necessário, KIMI_UPSTREAM_URL em .env
./scripts/configure-integrations.sh kimi

# Acrescente WhatsApp/Meta AI a qualquer modo
./scripts/configure-integrations.sh browser --whatsapp
./scripts/configure-integrations.sh kimi --whatsapp
```

Nunca passe a chave como argumento de linha de comando e nunca a comite. Depois:

```bash
docker compose config --quiet
docker compose up -d --build
./scripts/doctor.sh
```

Abra `http://SERVIDOR:50081/vnc.html`, `:50083/vnc.html` e `:50085/vnc.html`,
entre no ChatGPT e mantenha os perfis. No modo browser, autentique também Utility
(`:50084`) e as duas sessões do Repair (`:50087` principal e `:50088` Utility).
No modo Kimi essas três VNCs auxiliares não são criadas.
O Agent Zero fica em `http://SERVIDOR:50080` e o VS Code em `:50082`.

WhatsApp permanece desligado até o profile ser habilitado e o usuário parear pela
interface. Não há tentativa automática de conexão. Para desligá-lo novamente:

```bash
./scripts/configure-integrations.sh browser   # ou kimi
docker compose up -d --remove-orphans
```

## Atualização segura

Nunca faça `git reset --hard`, apague `data/` ou substitua `.env` pelo exemplo.
Antes de atualizar, registre o tag/SHA, o Compose resolvido e faça backup testado de
`.env` e `${STACK_DATA_DIR:-./data}`. Compare mudanças locais e mescle as que forem
personalizações reais.

```bash
git fetch --tags origin
git checkout v2.12-stack.17
sed -i 's/^STACK_SCHEMA_VERSION=.*/STACK_SCHEMA_VERSION=v2.12-stack.17/' .env

# A chave nova que já está no servidor deve permanecer intacta.
./scripts/configure-integrations.sh kimi       # ou browser; acrescente --whatsapp se usado
docker compose config --quiet
docker compose build
docker compose up -d --remove-orphans
./scripts/doctor.sh
```

A migração é idempotente, guarda backups em
`data/.stack-backups/v2.12-stack.17/` e registra o resultado em
`data/.stack-migrations/v2.12-stack.17.json`. Plugins mantidos pela stack são
montados diretamente da release; uma cópia antiga no volume não prevalece mais.

## Verificação de desenvolvimento

Os testes que não exigem contas externas podem ser executados assim:

```bash
python scripts/test_persistent_migration.py
python scripts/test_chat_naming_override.py
python scripts/test_browser_memory_runtime.py
python scripts/test_incident_actions.py
python scripts/test_artifact_parallel_scope.py
python scripts/test_optional_integrations.py
python -m unittest repair-controller/test_controller.py

python -m unittest discover -s agent-zero/seed/plugins/kimi_stream_resilience/tests -p 'test_*.py'
python -m unittest discover -s agent-zero/seed/plugins/message_queue_guard/tests -p 'test_*.py'
python -m unittest discover -s agent-zero/seed/plugins/memory_delete_guard/tests -p 'test_*.py'
python -m unittest discover -s agent-zero/seed/plugins/visual_evidence_guard/tests -p 'test_*.py'
node --test agent-zero/seed/plugins/message_queue_guard/tests/*.test.mjs
node --test agent-zero/chat-usage-plugin/webui/*.test.mjs

docker compose config --quiet
COMPOSE_PROFILES=kimi docker compose config --quiet
COMPOSE_PROFILES=browser-utility,browser-repair docker compose config --quiet
```

Testes de integração precisam ser feitos nos dois modos e não podem imprimir chaves.
Uma frase “arquivo pronto”, um healthcheck ou um teste unitário não substituem a
prova visual de upload/download e continuação no mesmo chat.
O estado de cobertura de cada ferramenta e os casos ainda pendentes estão em
[`docs/KIMI_NATIVE_TOOL_AUDIT.md`](docs/KIMI_NATIVE_TOOL_AUDIT.md); a release não
significa que todos os cenários externos foram validados.

## Dados e credenciais

| Caminho | Conteúdo | Git |
| --- | --- | --- |
| `.env` | chaves, senhas, modo e portas | nunca |
| `data/agent-zero` | chats, memória e configuração | nunca |
| `data/browser*` | cookies, vínculos, outbox e perfis | nunca |
| `data/workspace/chats` | workspaces isolados | nunca |
| `data/whatsapp`, `data/meta-ai-whatsapp` | sessões opcionais | nunca |
| `data/.stack-backups` | checkpoints de migração | nunca |

O Agent Zero roda privilegiado, monta Docker e `${HOST_ROOT_MOUNT}`. Isso dá acesso
administrativo real ao host; exponha somente em rede confiável e leia `SECURITY.md`.

## Prompt completo para instalação por outra IA

Copie todo o bloco e preencha apenas as escolhas indicadas no final.

```text
Instale do zero a release v2.12-stack.17 do repositório
https://github.com/Ruan0205/agent-zero-chatgpt-browser-stack em um servidor Linux.
O resultado deve ser um clone funcional desta release, sem copiar chats, cookies,
contas, senhas, chaves ou dados de outra máquina. Trabalhe até validar o modo escolhido;
se um teste externo não puder ser concluído, declare-o como pendência e não invente PASS.

REGRAS DE SEGURANÇA
1. Não altere aplicações fora desta stack. Não apague volumes ou arquivos desconhecidos.
2. Clone exatamente o tag v2.12-stack.17 e registre tag, SHA e `git status`.
3. Execute `./scripts/setup.sh`; segredos ficam somente em `.env` com modo 0600.
4. Nunca peça senha do ChatGPT/WhatsApp por texto: abra a VNC/interface para o usuário.
5. Não grave chaves em comandos, logs, README, Git, artefatos ou respostas.

ESCOLHA DE BACKEND
- Se Kimi/We64 NÃO for desejado, execute
  `./scripts/configure-integrations.sh browser`. ChatGPT Browser deve ser chat,
  Utility/compactador e reparador. Não exija API externa.
- Se Kimi/We64 for desejado, preserve/preencha `API_KEY_OTHER`, use o Base URL informado
  pela ativação da chave em `KIMI_UPSTREAM_URL` (o padrão oficial é
  https://api.we64.com/v1) e execute `./scripts/configure-integrations.sh kimi`.
  Chat, Utility e reparador devem ser `kimi-k3`, contexto 1.000.000, e até dois
  subagentes Kimi; o ChatGPT Browser principal continua disponível para Power/imagens.
- WhatsApp/Meta AI é opcional. Só acrescente `--whatsapp` se o usuário pedir. Sem isso,
  não suba nem exija pareamento do serviço e não considere a instalação incompleta.

IMPLANTAÇÃO
1. Revise portas, PUBLIC_HOST, STACK_DATA_DIR e HOST_ROOT_MOUNT. Rode
   `docker compose config --quiet` sem exibir valores secretos.
2. Suba com `docker compose up -d --build`. Verifique bootstrap, Agent Zero, VS Code,
   três browsers principais, reparador/controller e apenas os serviços opcionais do
   profile escolhido. Não trate um profile desligado como falha.
3. Peça ao usuário para autenticar as três VNCs principais. No modo browser, autentique
   também Utility e as duas VNCs Repair (principal e Utility). No modo Kimi, confirme
   que essas VNCs auxiliares não são necessárias.
4. Execute `scripts/doctor.sh`, testes Python/Node documentados e verifique que nenhuma
   credencial entrou no Git ou nos logs.

MATRIZ DE ACEITAÇÃO
A. Persistência: reinicie e recrie containers; preserve chats, fila, anexos, configurações,
   vínculos browser, auditorias e workspaces. Reboot não pode perder mensagens pendentes.
B. Modelos: pergunta curta/longa, português, ferramenta, erro de ferramenta, continuação,
   novo chat isolado e compactação manual/automática. No Kimi, teste resposta longa,
   timeout transitório, resposta vazia, DSML válido, DSML inválido, JSON nativo,
   `tasks.list_tasks`, `tools`/`tool_calls` nativos, imagem nativa e dois subagentes
   sem replay de efeitos. Verifique que uma ferramenta com efeito nunca é executada
   a partir de texto DSML. No browser,
   teste chat, Utility e reparador no mesmo fluxo anterior da stack.
C. Fila: enquanto o modelo trabalha, envie três mensagens com anexos; reordene uma,
   edite outra e recarregue/reinicie antes do consumo. Elas devem permanecer exatamente
   uma vez, na nova ordem; execução incerta deve pedir Retomar, nunca repetir sozinha.
D. Browser: três chats simultâneos em VNCs distintas, quarto aguardando, afinidade por
   chat, 429/backoff, modelo ainda pensando, mídia lenta, upload real e resposta final sem
   envio duplicado ou “imagem não carregou” quando a prévia já existe. Gere uma imagem,
   edite-a no editor nativo e confirme que, após um erro/restart, a ponte recupera a
   edição aceita sem reenviá-la.
E. Evidência: envie duas imagens ao Kimi; confirme os bytes/caminhos corretos e que o
   subagente carrega ambas com vision_load. Uma captura uniforme/preta deve ser rejeitada,
   não avaliada com nota. Teste PNG, PDF e ZIP nos dois sentidos com assinatura real.
F. Ferramentas: teste terminal, input, browser, document_query, vision_load, text_editor,
   VS Code, memória, subordinate/parallel, scheduler, artifact_verify, job_status,
   browser_bridge_status, server_diagnostics e project_check. Sem ferramenta inventada.
G. Reparador: diagnostique somente leitura, converse no mesmo caso, reconheça
   “autorizo”/botão, aplique uma correção descartável somente após autorização, prove
   mudança nova, peça outra autorização para retomar e sobreviva ao restart do principal.
H. UI: Pin to Top, ordenação por atividade, ponto de resposta nova, contador mensal e
   histórico, entrada/saída separadas, tokens/s, compactar contexto e painel de auditoria.
I. Segurança: memória ampla exige dry-run/IDs; host root apenas sob pedido; diretórios por
   chat não podem vazar; WhatsApp, se habilitado, deve ficar em self-chat autorizado.

Se qualquer mudança quebrar o modo escolhido, restaure o checkpoint e prove o rollback.
Entregue relatório PASS/FAIL por grupo, versão/SHA, serviços habilitados, backups,
pendências externas e URLs; não declare 100% sem evidência ponta a ponta.

MODO DESEJADO (browser ou kimi): ____________________
ATIVAR WHATSAPP? (sim ou não): ____________________
CHAVE WE64, somente se modo kimi; grave direto no .env e não repita: ____________________
BASE URL informada na ativação, se diferente do padrão: ____________________
```

## Prompt completo para atualização por outra IA

Este é o prompt recomendado para a outra infraestrutura que já possui uma chave nova.
Ele exige preservar tanto a chave quanto alterações exclusivas daquele servidor.

```text
Atualize a instalação existente de
https://github.com/Ruan0205/agent-zero-chatgpt-browser-stack para v2.12-stack.17.
A instalação já possui uma chave de API nova: NÃO a substitua, imprima, mova para o Git
nem peça que eu a cole no chat. Preserve também todas as modificações exclusivas que já
funcionam neste servidor. A atualização deve incorporar por merge consciente todas as
correções públicas abaixo, não apagar personalizações e fazer rollback se a validação falhar.

CHECKPOINT ANTES DE MUDAR
1. Inventarie tag/SHA, branch, `git status`, diffs locais, `.env` (nomes das variáveis,
   nunca valores), Compose resolvido, containers, imagens/digests, profiles, volumes,
   portas, healthchecks, dados e uso de RAM/disco. Classifique cada diferença como
   código da stack, personalização, segredo ou dado persistente.
2. Faça backup datado e testado de repositório, `.env`, Compose resolvido e
   STACK_DATA_DIR. Gere hashes e documente restauração. Não inclua o backup no Git.
3. Se houver mudanças locais, crie uma branch/checkpoint. Nunca use reset --hard,
   `down -v`, limpeza ampla ou substituição cega do `.env`/`data`.

ATUALIZAÇÕES OBRIGATÓRIAS DA v2.12-stack.17
- backend selecionável: Kimi-K3/We64 opcional ou fallback integral ChatGPT Browser;
  WhatsApp/Meta AI opcional por profile, sem dependências rígidas;
- Kimi como chat, Utility e reparador com contexto 1M; até dois subagentes; imagens
  nativas vão ao Kimi e ChatGPT Browser só é chamado quando explicitamente necessário;
- Kimi recebe esquemas `tools` reais pela API e deve devolver `tool_calls` nativos;
  texto DSML/JSON não pode virar chamada com efeito. Chamadas auxiliares sem catálogo
  explícito continuam auxiliares e não podem falhar por inventário vazio;
- compactação específica do Kimi deve manter tarefa ativa, decisões, restrições, IDs e
  arquivos importantes, com checkpoint e verificação pós-resumo; timeout da ponte até
  540 s, sem repetir uma ação já aceita pelo navegador;
- `chatgpt_browser_image` deve gerar e editar via subagente Browser na conversa
  vinculada, recuperar o arquivo real, verificar hash e publicá-lo no chat Kimi.
  Na edição recém-gerada, use o editor nativo sem reupload; registre o envio e recupere
  resultado atrasado sem segunda submissão. Falhas de upload de arquivos externos
  devem ser explícitas, nunca tratadas como sucesso;
- resiliência Kimi atômica, retentativa LLM-only e parser seguro de DSML/JSON, correção
  efêmera de InvalidDSML, alias tasks.list_tasks e nenhuma repetição de ação concluída;
- fila transacional persistente com anexos, ordem editável, edição devolvida ao composer,
  retomada manual após estado incerto, deduplicação de duplo clique/Enter e
  sobrevivência a restart/queda;
- correções de resposta vazia/modelo ainda pensando, polling de terminal/subagente,
  tarefas longas, chamadas repetidas e resultados grandes;
- diretórios isolados por chat, instruções de host Linux x máquina Windows/SSH e catálogo
  fixo de ferramentas com documentação sob demanda;
- evidência visual: imagens Kimi em detail high, rejeição de captura preta/uniforme,
  recibos SHA-256 e vision_load obrigatório antes de avaliar;
- artefatos e mídia: escopo por chat/turno, verificação de existência/integridade/publicação,
  upload sem duplicação, reconhecimento de imagem já carregada e recuperação de timeout;
- reparador Kimi/browser conforme backend, sempre disponível, diagnóstico somente leitura,
  autorização pelo painel ou texto, melhoria global, prova de mudança nova, VNC apenas no
  modo browser, segunda autorização para retomar e controller resistente a tarefas longas;
- painel de uso mensal (reset lógico no dia 1) e histórico, Kimi/Browser/geral, tokens de
  entrada e saída, estimativas configuráveis e tokens/s;
- botão Compactar contexto, Pin to Top corrigido, ordenação por atividade, notificação,
  indicador azul de conclusão, nomes de chat, limpeza/exclusão de auditorias;
- ferramentas job_status, browser_bridge_status, artifact_verify, server_diagnostics,
  project_check e tasks.list_tasks; VS Code/terminal e memória protegidos;
- busca pública limitada quando o SearXNG estiver indisponível, sem inventar
  resultados, e catálogo nativo com parâmetros reais de `scheduler` e `search_engine`;
- fontes dos plugins recentes montadas diretamente da release para impedir cópia antiga
  no volume; migração idempotente com backup e schema v2.12-stack.17;
- recuperação automática de eventos visuais perdidos durante execução e intervenção
  explícita de qualquer mensagem pendente no turno ativo, sem segunda run.

PROCEDIMENTO
1. Busque o tag v2.12-stack.17, confira SHA/release e compare cada arquivo local com a
   release. Mescle personalizações; não copie arquivos antigos por cima das correções.
2. Preserve a API key atual. Determine o modo já desejado:
   - Kimi: preserve API_KEY_OTHER e KIMI_UPSTREAM_URL atuais; execute
     `./scripts/configure-integrations.sh kimi` (com `--whatsapp` apenas se hoje usado).
   - Sem Kimi: execute `./scripts/configure-integrations.sh browser`; ChatGPT Browser
     será chat, Utility e reparador, sem exigir We64.
   Não troque de modo sem instrução do usuário.
3. Defina STACK_SCHEMA_VERSION=v2.12-stack.17, valide os dois Compose profiles sem mostrar
   segredos, construa antes da parada final e recrie com `--remove-orphans`.
4. Verifique hashes das fontes montadas dentro de agent-zero e agent-zero-repair. Confirme
   marcador/backups da migração. Preserve chats, memórias, fila, uploads, workspaces,
   vínculos do browser, auditorias, cookies e sessões.

TESTES OBRIGATÓRIOS
A. Rode todos os testes Python/Node e Compose descritos no README; execute doctor.sh.
B. Repita a matriz de persistência, modelos, fila, browser, evidência, ferramentas,
   reparador, UI e segurança do prompt de instalação, focada primeiro no backend ativo.
C. Faça também smoke do backend alternativo sem alterar a produção: Compose resolvido e
   testes unitários. Não exija credencial Kimi para aprovar o modo browser-only.
D. Reinicie Agent Zero durante mensagem pendente e durante diagnóstico; nada pode sumir.
   Não reinicie o host nem contate terceiros sem autorização.
E. No Kimi, simule InvalidDSML válido/inválido, resposta lenta/vazia, duas imagens e duas
   chamadas de subagente. Faça uma geração PNG e uma edição do mesmo PNG, confirme
   hashes distintos, publicação no chat e que uma retomada não duplica o envio.
   Faça compactação de histórico longo não redundante e verifique o próximo turno.
   No browser, prove contexto/compactação/reparador pelas VNCs.
F. Confirme que WhatsApp desligado não gera erro/dependência; se habilitado, teste apenas
   self-chat e não envie mensagens reais a contatos/grupos.

ROLLBACK
Se um requisito do backend ativo falhar após diagnóstico razoável, pare a nova versão,
restaure exatamente o checkpoint, recrie as imagens/serviços anteriores e execute smoke
tests da versão antiga. Relate erro, evidência, tentativas e condição para retomar.

ENTREGA
Só mantenha v2.12-stack.17 após PASS nos testes aplicáveis. Informe versão anterior/nova,
SHA, profiles ativos, mudanças locais preservadas, backup/rollback, PASS/FAIL por grupo e
pendências externas. Nunca alegue teste que não executou e nunca exponha a chave.
```

## Compatibilidade e licenças

A imagem Agent Zero é fixada por digest porque extensões dependem de caminhos internos.
Automação de `chatgpt.com` depende da interface web e pode exigir manutenção quando ela
muda. Este projeto não é afiliado à Agent Zero, OpenAI, We64, Meta ou WhatsApp. Consulte
os arquivos de licença dos componentes e imagens upstream.
