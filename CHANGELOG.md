# Changelog

## v2.12-stack.17 — ferramentas Kimi nativas e imagens recuperáveis

- Envia ao Kimi o catálogo real de ferramentas como funções nativas da API e
  aceita efeitos somente de `tool_calls`, mantendo o dispatcher do Agent Zero.
- Corrige a compactação Kimi para preservar pedido ativo, restrições e estado
  operacional; limita a espera do Browser a 540 s sem replay cego.
- Delega geração e edição de imagem ao subagente Browser. A edição da imagem
  recém-gerada usa o editor nativo; recibo persistente impede reenvio quando a
  imagem demora, e o PNG é verificado e publicado no chat Kimi.
- Torna duplo clique/Enter do mesmo rascunho idempotente na fila e adiciona
  fallback de busca limitado quando o SearXNG não retorna resultados.
- Inclui catálogo/testes de ferramentas nativas e regressões R-021/R-022.
  Cobertura externa completa ainda é pendente e está documentada na auditoria.

## v2.12-stack.16 — intervenção explícita e Nudge sem ambiguidade

- Exibe **Intervir agora** com texto em cada mensagem pendente durante uma
  execução e oculta o envio normal bloqueado nesse estado.
- Renomeia Nudge visualmente para **Retomar navegador**, deixa a ação desabilitada
  para Kimi e enquanto o navegador ainda trabalha, e explica na própria fila que
  ela não envia mensagens.
- Estende o teste real para reproduzir exatamente a interface observada: ação
  textual visível, envio conflitante oculto, retomada desabilitada e intervenção
  consumida sem reload.
- Mantém a autenticação dos testes pelo `.env`, sem depender de login manual nem
  registrar credenciais no código, nos logs ou na documentação.

## v2.12-stack.15 — interface autoritativa e regressões verificadas

- Torna a reconciliação do histórico independente do cursor do WebSocket: a API
  devolve uma cauda autoritativa limitada e a interface a reaplica durante a
  execução, recuperando eventos perdidos sem F5.
- Mantém **Intervir agora** habilitado a partir da reserva durável `inflight`, sem
  depender do estado visual transitório `running`.
- Remove journal e estado ativo ao apagar um chat e grava um tombstone persistente,
  impedindo que um worker atrasado recrie a fila eliminada.
- Institui uma lista cumulativa de regressões e um teste ponta a ponta em navegador
  real como requisito de entrega, cobrindo atualização sem reload, intervenção,
  preservação da fila e limpeza do chat sintético.

## v2.12-stack.14 — histórico autorreconciliado e intervenção pela fila

- Reconcilia o histórico por HTTP durante uma execução ativa, inclusive quando o
  WebSocket aparenta estar saudável mas deixou de entregar um evento; o estado
  “Calling LLM” deixa de depender de atualizar manualmente a página.
- Adiciona **Intervir agora** a cada mensagem pendente. A mensagem escolhida entra
  no turno em andamento como correção, sem iniciar uma segunda execução e sem
  consumir, reordenar ou perder as outras mensagens da fila.
- Torna a transição da intervenção transacional e recuperável após falha: uma
  mensagem comprovadamente registrada não é reenviada, enquanto uma tentativa
  não observada retorna à posição pendente.
- Restaura o comportamento de acompanhar automaticamente o fim do chat no envio
  controlado pela fila e cobre os fluxos novos com testes de frontend e backend.

## v2.12-stack.13 — Kimi opcional, fallback browser e robustez acumulada

- Torna Kimi-K3/We64 opcional por profile. Quando habilitado, Kimi atende chat,
  Utility/compactação e reparador com contexto configurado em 1M; sem chave externa,
  ChatGPT Browser assume integralmente esses três papéis.
- Torna WhatsApp/Meta AI opcional por profile e remove serviços opcionais da cadeia
  rígida de dependências do Agent Zero.
- Adiciona configurador de integrações que preserva credenciais e seleciona de forma
  atômica os modelos, endpoints, contextos e VNCs necessárias.
- Endurece Kimi contra streams incompletos, respostas vazias e InvalidDSML: parser
  seguro para DSML/JSON, alias estreito `tasks.list_tasks`, correção efêmera e
  retentativa somente do LLM, sem replay de ferramentas já executadas.
- Acrescenta fila transacional SQLite com persistência de anexos, reordenação, edição,
  retomada manual de execução incerta e recuperação após restart.
- Adiciona evidência visual verificada, imagens Kimi em alta resolução e rejeição de
  capturas pretas/uniformes antes da avaliação por subagente.
- Protege exclusão ampla de memórias com dry-run, confirmação por ID e checkpoint.
- Atualiza reparador e controller para respostas longas, autorização em linguagem
  natural, melhoria global, prova de alteração nova e retomada separadamente aprovada.
- Consolida painel de tokens mensal/histórico e por modelo, entrada/saída, estimativas,
  tokens por segundo e compactação manual; corrige preset efetivo e seleção exclusiva.
- Inclui as correções acumuladas de artefatos, mídia, sessões de terminal/subagentes,
  diretórios por chat, aliases e documentação fixa de ferramentas.
- Monta as fontes dos quatro plugins recentes diretamente da release, evitando que
  uma cópia antiga no volume persistente sobreviva a uma atualização.
- Reescreve requisitos, instalação, atualização e prompts de outra IA para preservar
  customizações, dados e chaves, testar ambos os modos e realizar rollback verificável.

## v2.12-stack.12 — compatibilidade com a interface atual e operação visível

- Reconhece a estrutura atual dos turnos e do editor do ChatGPT, incluindo upload e botão de envio; não declara uma resposta concluída apenas porque um indicador de atividade sumiu momentaneamente.
- Preserva prompts longos em transporte multipartes e corrige casos de diagnóstico somente leitura e de URL autolinkada no editor.
- Separa navegador principal e Utility do reparador em duas VNCs fixas, evitando que a compactação navegue para fora do chat em análise.
- Acrescenta status das VNCs, recarga sem cache, painel de melhoria, ponto azul para respostas finais não lidas e ordenação de chats que respeita pins.
- Inclui migração e instruções de atualização desde `v2.12-stack.9`; não inclui credenciais, sessões, chats nem personalizações específicas do servidor original.

## v2.12-stack.11 — foco no erro atual e anexos sem reenvio duplicado

- Exige uma descrição do erro atual antes de iniciar o diagnóstico manual; consulta
  evidências recentes primeiro, sem tentar corrigir problemas antigos já resolvidos.
- O botão da VNC do reparador dentro do Agent Zero preenche a senha VNC
  automaticamente, mantendo o endereço direto protegido.
- Conserva o registro de uma imagem já enviada mesmo após múltiplas chamadas de
  ferramentas ou compactação do turno, evitando o falso timeout no reenvio.
- O controlador consulta o token efetivo da API principal quando ele foi gerado
  em memória, para conseguir retomar o chat original após autorização.
- Acrescenta token estável para instalações novas e migrações de `.env`.

## v2.12-stack.10 — reparador isolado e correções acumuladas

- Adiciona controller, Agent Zero e VNC exclusivos para diagnóstico de chats com erro.
  Diagnóstico é somente leitura; reparo e retomada do chat original exigem
  aprovações independentes. O controller sobrevive ao reinício do Agent Zero principal.
- Persiste um vínculo reparador ↔ chat de origem e mantém a mesma conversa do
  navegador em mensagens posteriores do mesmo caso.
- Inclui as correções acumuladas do bridge, anexos, editor, ferramentas de
  diagnóstico e contagem de tokens desde a release anterior.
- Acrescenta testes para a autorização por contexto, vínculo persistente e
  regressões da ponte. Validação ponta a ponta deve ser feita após cada instalação.

## v2.12-stack.9 — Agent Zero mais estável em tarefas longas

- Preserva chats persistentes quando a API retoma uma conversa existente; somente
  chats criados com TTL explícito podem expirar automaticamente.
- Restringe **Nudge** a chats `chatgpt-browser` já parados, evitando interromper
  uma chamada ativa e duplicar o envio.
- Torna o Agent 0 um perfil geral para pesquisa, programação e administração,
  desabilita perfis especializados no seed e adiciona instruções para testes
  longos, buscas limitadas e validação de resultados.
- Diferencia uma sessão de terminal realmente ativa de uma sessão já encerrada,
  com limite finito de consultas de progresso e avisos preservados no bridge.
- Divide prompts extensos em inserções verificadas no navegador, detecta turno
  vazio concluído e não confunde texto de download dentro de código JSON com
  um arquivo gerado.
- Evita classificar um pedido de instalação de infraestrutura como geração de
  mídia apenas por mencionar imagens ou arquivos nos requisitos.
- Testes locais: 79 testes JavaScript, sintaxe Python e migração persistente.
  Isso não substitui a validação ponta a ponta em outra instalação.

## v2.12-stack.8 — anexos por mensagem e upload de imagem com prazo

- Mantém um chat do navegador por chat do Agent Zero e limita anexos à mensagem
  humana atual; uma imagem antiga não acompanha uma nova ordem só de texto.
- Registra uploads concluídos por mensagem, não globalmente pelo caminho do arquivo;
  uma nova anexação explícita do mesmo arquivo continua possível.
- Aguarda a prévia de cada imagem por até três minutos, mostra progresso no Agent Zero
  e, se travar, remove anexo e rascunho e responde `a imagem não carregou` sem loop.
- Evita associar uma primeira tentativa de upload malsucedida ao chat de outra
  instância do navegador.
- Normaliza sessões de terminal não numéricas antes que cheguem ao Agent Zero e
  permite uma série finita de verificações curtas de processos em andamento.
- Amplia os testes de regressão e a matriz de instalação/atualização para cobrir
  a sequência imagem travada → nova ordem de texto no mesmo chat.

## v2.12-stack.7 — release de instalação reproduzível

- Define esta release como a única recomendada para novas instalações; tags antigas
  permanecem apenas como histórico e base de rollback.
- Revisa os prompts de instalação e atualização para verificar commit, estado
  persistente, segredos e o fluxo real de anexos, inclusive PDF.
- Amplia o diagnóstico para verificar o bridge, o plugin de mídia, o handler da
  interface e o outbox compartilhado. Esse diagnóstico não é apresentado como
  substituto de um PDF gerado e recebido ponta a ponta.
- Mantém fora da distribuição um helper local de auditoria sem referências no
  código executado e todas as integrações pessoais desta máquina.
- Corrige instruções antigas de auditoria e diferencia a documentação upstream
  isolada da instalação integrada desta stack.

## v2.12-stack.6 — nomes coerentes para chats novos

- Corrige o nome repetido `Greeting`: o gerador ignorava a mensagem sintética `Hello!`
  criada internamente pelo Agent Zero e a confundia com o primeiro pedido do usuário.
- A nomeação automática agora usa a primeira solicitação real e continua respeitando
  renomeações manuais e o modo de nomeação configurado.
- Adiciona regressão para conversa normal e para o caso em que o próprio usuário escreve
  `Hello!` como sua mensagem real.

## v2.12-stack.5 — limpeza segura de componentes aposentados

- Torna padrão remover arquivos e configurações que deixaram oficialmente de fazer
  parte da stack.
- Usa uma lista explícita de caminhos, valida confinamento ao diretório de dados e cria
  backup antes da remoção; dados desconhecidos e dados do operador são preservados.
- Remove caches Python de componentes gerenciados e registra tudo no marcador da migração.

## v2.12-stack.4 — migração confiável de instalações existentes

- Corrige o processo de atualização que mantinha indefinidamente uma cópia antiga do
  `browser_session_bridge` no volume persistente.
- Migra seletivamente o antigo Utility `google/gemma-4-E2B-it` para a instância
  `chatgpt-browser-utility`, inclusive em snapshots congelados de chats Power.
- Cria backup antes de cada mudança persistente, marcador de migração e verificações
  no `doctor.sh`.
- Adiciona regressão que executa a migração duas vezes e comprova idempotência.

## v2.12-stack.3 — três VNCs fixas e auditoria manual (histórico)

- Três Chromes em displays/noVNC separados; chamadas excedentes ficam em fila, sem escala.
- Mantém a afinidade persistente chat Agent Zero ↔ conversa web ↔ display e remapeia
  atribuições legadas acima da terceira vaga.
- Impõe cooldown global mínimo de 30 segundos após "too many requests".
- Remove a auditoria automática. O botão **Chat com erro** analisa sob demanda
  o histórico completo e um retrato da interface visível em display oculto.
- Ordena a barra lateral pela atividade persistida: ao selecionar ou enviar uma
  mensagem, o chat (ou seu grupo pai) passa ao topo.

## v2.12-stack.2 — navegador Utility dedicado (histórico)

- Substitui Gemma como modelo auxiliar por uma instância Chrome/noVNC isolada na porta 50084.
- Usa um único chat auxiliar ativo para chamadas seriadas e envia cada tarefa completa,
  evitando que pedidos de conversas diferentes dependam de instruções anteriores.
- Divide contextos auxiliares grandes em trechos completos e pede ao GPT uma síntese
  semântica de cada trecho antes da resposta final, em vez de cortar o transporte.
- Mantém o login apenas nos volumes privados; a nova instância copia o perfil principal
  no primeiro start e não compartilha o diretório de escrita com ele.

## v2.12-stack.1 — 2026-09-16

- Atualiza a imagem base e os seeds para Agent Zero v2.12.
- Corrige recriação limpa do container quando plugins oficiais ainda não existem em `/a0`.
- Adiciona pool de duas instâncias permanentes do ChatGPT Browser, escala elástica e afinidade por chat.
- Mantém o contexto no ChatGPT e envia deltas compactos pelo bridge.
- Adiciona recuperação limitada de popup, timeout e HTTP 429, além de keep-alive SSE para tarefas longas.
- Corrige anexos quando a UI do ChatGPT omite `fn`/`cd=attachment` e usa outbox compartilhado por todas as instâncias.
- Adiciona suporte de imagens e arquivos entre ChatGPT Browser, Agent Zero e workspace do VS Code.
- Adiciona auditor opcional de respostas e painel persistente de incidentes.
- Adiciona painel noVNC e VS Code integrados à lateral do Agent Zero.
- Adiciona tela opcional de pareamento **Meta AI WhatsApp Bridge** em Settings > External.
- Reforça self-chat e isolamento das integrações de WhatsApp.
- Serializa chamadas Featherless e aplica retentativas limitadas para falhas temporárias.
- Evita que falhas de memorização interrompam tarefas e melhora compactação/repetição.
- Amplia o README com prompts completos de instalação e atualização, incluindo rollback.
  A instalação mantém a matriz abrangente de formatos; a atualização usa testes essenciais
  de imagem, ZIP, TXT e YAML.

O repositório não inclui chats, cookies, sessões, bancos, números, credenciais ou dados pessoais.
