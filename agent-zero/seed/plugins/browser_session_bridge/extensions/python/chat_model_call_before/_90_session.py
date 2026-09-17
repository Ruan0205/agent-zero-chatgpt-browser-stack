from helpers.extension import Extension
from usr.plugins.browser_session_bridge.session import bind
from helpers.persist_chat import save_tmp_chat
from plugins._model_config.helpers import model_config

class BrowserSession(Extension):
    async def execute(self, **kwargs):
        model=kwargs.get('call_data', {}).get('model')
        if model and 'chatgpt-browser' in str(getattr(model,'model_name','')):
            # Freeze this chat's browser preset at its first actual model call.
            # The browser conversation is the authoritative memory for this chat;
            # changing its model midstream would silently sever that context.
            ctx=self.agent.context
            if not ctx.get_data('browser_model_lock'):
                preset=model_config.get_effective_preset_name(self.agent)
                effective=model_config.get_effective_config(self.agent)
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
