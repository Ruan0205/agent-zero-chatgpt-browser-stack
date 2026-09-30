# Lista obrigatória de regressões

Esta lista é cumulativa. Todo problema novo confirmado deve receber um ID e um
teste reproduzível. Uma entrega só pode ser declarada pronta depois de executar o
pedido atual e rever, item a item, todas as regressões aplicáveis.

| ID | Problema que não pode se repetir | Verificação real obrigatória | Última evidência |
|---|---|---|---|
| R-001 | O raciocínio/log da execução só aparece depois de F5. | Em uma aba recém-aberta, iniciar uma geração deliberadamente demorada e confirmar que pelo menos dois eventos posteriores ao prompt aparecem sem reload. | **PASS** em 2026-09-30, contexto `f5IMSFfF`: evento de processo posterior ao prompt apareceu sem reload e a navegação permaneceu a mesma. |
| R-002 | Não é possível direcionar uma mensagem da fila enquanto outra está sendo processada. | Durante a mesma geração, enfileirar duas mensagens, usar **Intervir agora** em uma, confirmar sua entrada no log/turno ativo e confirmar que a outra continua pendente e na mesma ordem. | **PASS** em 2026-09-30, contexto `f5IMSFfF`: botão habilitado durante execução, intervenção renderizada sem reload e mensagem não selecionada preservada. |
| R-003 | Excluir um chat deixa mensagens órfãs no journal SQLite da fila. | Excluir o chat sintético após o teste e confirmar que não restou diretório, mensagem nem estado ativo para seu `context`. É permitido somente o tombstone que impede a ressurreição do contexto apagado. | **PASS** em 2026-09-30, contexto `f5IMSFfF`: diretório ausente, `messages=0`, `contexts=0` e um tombstone persistente. |
| R-004 | Durante uma execução Kimi, a ação de correção fica escondida em um ícone e o usuário tenta usar **Nudge**, que não envia mensagens e só se aplica ao navegador. | Em execução ativa com uma mensagem pendente, esconder o envio normal bloqueado, mostrar **Intervir agora** por texto e confirmar que Nudge aparece como **Retomar navegador** e fica desabilitado para Kimi ou enquanto o navegador ainda executa. | **PASS** em 2026-09-30, contexto `VeSLhRA6`: rótulo visível, envio bloqueado oculto, Retomar navegador desabilitado e intervenção consumida sem reload. |
| R-005 | A validação para esperando o usuário entrar novamente no Agent Zero. | Testes automatizados devem autenticar com as credenciais operacionais já mantidas no `.env`, sem imprimir nem copiar a senha para código, logs ou documentação. A aba interativa pode reutilizar sua sessão autenticada. | **PASS** em 2026-09-30: cenário real autenticou automaticamente pelo `.env`; aba interativa autenticada e preservada, sem persistir a senha no Git. |

## Regra de conclusão

1. Teste unitário ou de integração é necessário, mas não substitui o fluxo real.
2. A evidência deve registrar ambiente, resultado observado e ausência de efeitos
   duplicados.
3. Se qualquer item aplicável falhar, a entrega permanece **não concluída**.
4. Quando surgir um problema novo, adicione-o antes de implementar a correção.
