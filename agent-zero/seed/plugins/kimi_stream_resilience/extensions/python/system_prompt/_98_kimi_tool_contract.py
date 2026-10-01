"""Durable tool protocol reminder for every Kimi main/subordinate/repair turn."""
import re
from helpers.extension import Extension
from plugins._model_config.helpers import model_config


CONTRACT = """## Protocolo de ferramentas do Kimi no Agent Zero
Você pode agir apenas pelas ferramentas realmente presentes no inventário deste
turno. Neste modelo, o inventário autorizado é enviado como `tools` da API:
selecione uma dessas funções pela chamada NATIVA da API e envie os argumentos
como objeto JSON da função. Não escreva envelopes tool_name/tool_args, DSML/XML
ou chamadas simuladas em `content` ou `reasoning_content`. A resposta final
também deve usar a função nativa `response`. Raciocínio e código de exemplo não
são chamadas. Para operações independentes use parallel; comandos dependentes exigem
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
Se o usuário pedir CRIAÇÃO ou EDIÇÃO de imagem em um chat Kimi, a ferramenta
apropriada é `chatgpt_browser_image` (`action=generate` ou `edit`). Ela usa um
subagente Browser exclusivo e publica o arquivo real neste chat. Não procure
imagens antigas no workdir, não use terminal/Python como substituto e não
delegue manualmente a outro subagente. Para editar, forneça em `images` o
caminho absoluto da imagem original anexada ou já publicada neste chat.
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


NATIVE_COMMUNICATION = """## Communication (Kimi native tools)
Use only the functions supplied as `tools` by this API request. Emit one native
function call per dependent step. Use the native `parallel` function for
independent steps, and the native `response` function to finish. Put arguments
in that function's JSON object. Never write a tool envelope in assistant text.

"""


def replace_legacy_json_contract(prompt: str) -> str:
    """Remove the incompatible text-JSON section only in Kimi's system prompt."""
    prompt = re.sub(
        r"(?ms)^## Communication\n.*?(?=^## messages\b)",
        NATIVE_COMMUNICATION,
        prompt,
        count=1,
    )
    return re.sub(
        r"(?ms)^\- O protocolo de ferramentas é um objeto JSON completo.*?(?=^\- Para ações externas,)",
        "- O protocolo de ferramentas deste modelo é exclusivamente a chamada "
        "nativa de função no parâmetro `tools` da API. Não escreva JSON de "
        "ferramenta no texto. Envie argumentos completos; raciocínio não é uma "
        "chamada. Execute uma etapa dependente por vez e use `parallel` para "
        "ações independentes.\n",
        prompt,
        count=1,
    )


def project_kimi_section(section: str) -> str:
    # Tool prose is represented by the API's native catalog instead.
    if section.lstrip().startswith((
        '## available tools',
        '## "Remote (MCP Server) Agent Tools" available:',
    )):
        return ''
    return replace_legacy_json_contract(section)


class KimiToolContract(Extension):
    async def execute(self, system_prompt=None, **kwargs):
        config = model_config.get_chat_model_config(self.agent)
        if isinstance(system_prompt, list) and 'kimi-k3' in str(config.get('name', '')).lower():
            for index, section in enumerate(system_prompt):
                if isinstance(section, str):
                    system_prompt[index] = project_kimi_section(section)
            system_prompt.append(CONTRACT)
