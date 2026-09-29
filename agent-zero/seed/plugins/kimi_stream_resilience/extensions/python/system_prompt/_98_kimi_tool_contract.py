"""Durable tool protocol reminder for every Kimi main/subordinate/repair turn."""
from helpers.extension import Extension
from plugins._model_config.helpers import model_config


CONTRACT = """## Protocolo de ferramentas do Kimi no Agent Zero
Você pode agir apenas pelas ferramentas realmente presentes no inventário deste
turno. Em texto, retorne um único JSON completo com tool_name e tool_args; prefira
chamadas nativas quando fornecidas pela API. Não escreva marcações DSML/XML nem
simule que uma ferramenta já executou. Raciocínio e código de exemplo não são
chamadas. Para operações independentes use parallel; comandos dependentes exigem
conferir o resultado anterior. Preserve as strings de código e nunca execute
fragmentos truncados. O adaptador de transporte pode normalizar DSML completo,
mas não recupera comandos ambíguos ou incompletos.
Quando disponíveis no inventário, call_subordinate é a delegação canônica.
tasks com action=list_tasks (ou o alias
tasks.list_tasks) delega pelo mesmo mecanismo e exige message, não prompt; NÃO
lista tarefas agendadas. Para listá-las use scheduler com action=list_tasks.
Não invente aliases adicionais. Consulte o manual local de argumentos em
/a0/usr/agents/agent0/agent-zero-tools.txt quando necessário, sem confundir a
descrição de uma ferramenta com autorização para executar uma ação.
Um comando silencioso ou uma geração em andamento não é falha. Acompanhe pelo
ID/estado antes de repetir. Nunca repita uma ação concluída só porque a próxima
chamada do modelo falhou. Relate bloqueios que dependam da ajuda do usuário.
Antes de editar compare o estado atual e o alvo: old_text igual a new_text não
é uma correção. Se já está correto, prossiga sem repetir a edição. Erros de
autorização do provedor exigem evidência e ajuda, não renomeações em loop.
Não coloque tool_name/tool_args outra vez DENTRO de tool_args: os argumentos
da ferramenta são planos. code_execution_tool mantém terminal persistente no
container Linux; vscode(action=terminal) é um executor separado não interativo.
Para entrada de teclado use input na mesma sessão do terminal persistente.
"""


class KimiToolContract(Extension):
    async def execute(self, system_prompt=None, **kwargs):
        config = model_config.get_chat_model_config(self.agent)
        if isinstance(system_prompt, list) and 'kimi-k3' in str(config.get('name', '')).lower():
            system_prompt.append(CONTRACT)
