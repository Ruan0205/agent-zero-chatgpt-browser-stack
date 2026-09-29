from helpers.extension import Extension
from usr.plugins.browser_session_bridge.session import bind
from helpers.persist_chat import save_tmp_chat
from plugins._model_config.helpers import model_config
from langchain_core.messages import HumanMessage


def split_native_image_messages(messages):
    """WE64 Kimi handles one image per user message more reliably than a bundle."""
    result=[]
    for message in messages:
        content=getattr(message, 'content', None)
        if not isinstance(message, HumanMessage) or not isinstance(content, list):
            result.append(message)
            continue
        images=[part for part in content if isinstance(part, dict) and part.get('type') == 'image_url']
        if len(images) < 2:
            result.append(message)
            continue
        non_images=[part for part in content if part not in images]
        result.append(HumanMessage(content=[*non_images, images[0]]))
        for index, image in enumerate(images[1:], start=2):
            result.append(HumanMessage(content=[
                {'type':'text','text':f'Imagem anexa {index} do mesmo pedido; considere também as imagens anteriores.'},
                image,
            ]))
    return result

class BrowserSession(Extension):
    async def execute(self, **kwargs):
        model=kwargs.get('call_data', {}).get('model')
        if model:
            ctx = self.agent.context
            actual_name = str(getattr(model, 'model_name', ''))
            expected_name = str(model_config.get_chat_model_config(self.agent).get('name') or '')
            if expected_name and actual_name != expected_name and not actual_name.endswith('/' + expected_name):
                raise ValueError(
                    'O modelo preparado para este turno não corresponde ao modelo ativo '
                    f'do chat ({actual_name} != {expected_name}). A chamada foi bloqueada '
                    'antes de enviar dados ao navegador ou à API; recarregue o chat.'
                )
            family = 'browser' if actual_name.endswith('chatgpt-browser') else 'native'
            chosen = ctx.get_data('model_transport_family')
            if chosen in ('browser', 'native') and chosen != family:
                raise ValueError('Este chat não pode trocar entre ChatGPT Browser e modelos com contexto local. Crie um novo chat para usar a outra família.')
            if not chosen and any(getattr(item, 'type', None) == 'user' for item in getattr(ctx.log, 'logs', ())):
                ctx.set_data('model_transport_family', family)
                save_tmp_chat(ctx)
            if family == 'native':
                call_data=kwargs.get('call_data', {})
                if isinstance(call_data.get('messages'), list):
                    call_data['messages']=split_native_image_messages(call_data['messages'])
        if model and 'chatgpt-browser' in str(getattr(model,'model_name','')):
            # Freeze this chat's browser preset at its first actual model call.
            # The browser conversation is the authoritative memory for this chat;
            # changing its model midstream would silently sever that context.
            ctx=self.agent.context
            if not ctx.get_data('browser_model_lock'):
                preset=model_config.get_effective_preset_name(self.agent)
                effective=model_config.get_effective_config(self.agent)
                preset_config=model_config.resolve_preset(preset)
                if str((preset_config or {}).get('chat', {}).get('name') or '') != 'chatgpt-browser':
                    preset='Custom'
                # Snapshot every slot, not just the preset name. Future edits
                # to a global preset must not switch this existing chat away
                # from the browser or break its saved conversation mapping.
                frozen={slot:effective.get(section, {}) for slot,section in model_config.PRESET_SLOT_CONFIG_SECTIONS.items()}
                ctx.set_data('chat_model_override', frozen)
                ctx.set_data('browser_model_lock', {'preset_name':preset,'model_name':str(model.model_name)})
                save_tmp_chat(ctx)
            # Three browser slots are permanent; a fourth request can wait in
            # the queue before its own (up to 540s) generation begins. Keep
            # the client timeout above one full queue wave plus one full turn.
            # This is a transport safety bound, not a completion timer.
            model.kwargs.update(num_retries=0,a0_retry_attempts=0,timeout=1200)
        bind(self.agent, kwargs.get('call_data', {}), 'main')
