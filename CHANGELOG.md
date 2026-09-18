# Changelog

## Em desenvolvimento — três VNCs fixas e auditoria manual

- Três Chromes em displays/noVNC separados; chamadas excedentes ficam em fila, sem escala.
- Mantém a afinidade persistente chat Agent Zero ↔ conversa web ↔ display e remapeia
  atribuições legadas acima da terceira vaga.
- Impõe cooldown global mínimo de 30 segundos após "too many requests".
- Remove a auditoria automática. O botão **Chat com erro** analisa sob demanda
  o histórico completo e um retrato da interface visível em display oculto.
- Ordena a barra lateral pela atividade persistida: ao selecionar ou enviar uma
  mensagem, o chat (ou seu grupo pai) passa ao topo.

## Em desenvolvimento — navegador Utility dedicado

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
