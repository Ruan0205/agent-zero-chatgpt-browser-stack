# Auditoria de ferramentas nativas do Kimi-K3 (30/09/2026)

Critério: **UI** exige prompt humano em chat descartável do Agent Zero, chamada
`tool_calls` nativa observada no log, resultado conferido e ausência de efeito
duplicado. Catálogo ou teste unitário sozinho não equivale a UI. Ferramentas
destrutivas devem usar somente dados descartáveis identificados. A Meta AI fica
excluída por decisão expressa do usuário.

O runtime do chat de teste expôs 32 ferramentas locais (inclui o alias `tasks`)
e 36 ferramentas MCP do Blender. O adaptador usa `/chat/completions` da we64
com `tools`, `tool_choice=required` e o dispatcher normal do Agent Zero. As
sondagens diretas com 32 e 68 funções retornaram `finish_reason=tool_calls`,
mas respostas textuais ocasionais ainda exigem retry. Suite Kimi: 67/67.

| Ferramenta | Estado de UI | Evidência/pendência |
|---|---|---|
| a2a_chat | Pendente | Requer agente A2A remoto de teste controlado. |
| artifact_verify | Passou parcialmente | Arquivo PNG e publicação verificados; variantes de ZIP/PDF pendentes. |
| behaviour_adjustment | Pendente | Mudança persistente precisa cenário reversível isolado. |
| browser | Passou parcialmente | list/open/close; demais ações pendentes. |
| browser_bridge_status | Passou | Consulta no chat de teste. |
| call_subordinate | Passou parcialmente | Criou/continuou subagente; cancelamento e recuperação pendentes. |
| chatgpt_browser_image | Passou para imagem recém-gerada | Geração PNG verde e edição PNG azul no chat `oqzrhjFg`, mesma conversa Browser, sem upload na edição; hashes distintos e ambos publicados. Edição de arquivo arbitrário, múltiplas saídas e outros formatos pendentes. |
| chatgpt_browser_media | Passou parcialmente | Publicou PNG real da geração; outros tipos pendentes. |
| code_execution_tool | Passou parcialmente | Terminal; Python/Node/sessões interativas pendentes. |
| document_query | Passou | Consulta real a ODT. |
| goal | Passou parcialmente | create/get/complete; outros estados pendentes. |
| input | Passou parcialmente | Envio a sessão de terminal de teste; controles adicionais pendentes. |
| job_status | Passou | Consulta de job no chat de teste. |
| memory_load | Passou | Busca em memória. |
| memory_save | Passou | Marcador descartável salvo. |
| memory_delete | Passou parcialmente | Marcador exato removido; guard de exclusão requer reauditoria. |
| memory_forget | Pendente | Teste anterior removeu registros além do marcador; não repetir sem isolamento. |
| meta_ai_image | Excluída | Usuário não usa mais Meta AI. |
| notify_user | Passou | Aviso não final no chat de teste. |
| office_artifact | Passou parcialmente | create/read; edit/export pendentes. |
| parallel | Passou parcialmente | Chamadas independentes; background/wait pendentes. |
| project_check | Passou | Checagem do workspace. |
| response | Passou | Resposta final nativa visível. |
| scheduler | Parcial | list/create/show; delete e update pendentes. |
| search_engine | Parcial | Chamada nativa com `query`; fallback deu resultados irrelevantes. |
| server_diagnostics | Passou | Chamada somente leitura. |
| skills_tool | Passou parcialmente | list/load; busca pendente. |
| tasks | Passou parcialmente | Alias `list_tasks` de delegação; estados pendentes. |
| text_editor | Passou parcialmente | read/write/patch; outras operações pendentes. |
| vscode | Passou parcialmente | status; terminal integrado pendente. |
| wait | Passou | Espera curta em UI. |
| vision_load | Passou | Leitura de imagem de teste. |

Não declarar 100% antes de converter cada linha aplicável a **Passou**, testar
os comandos MCP relevantes e validar compactação longa. R-021 passou no fluxo de
edição da imagem recém-gerada; R-022 exige cobertura adicional de concorrência.
