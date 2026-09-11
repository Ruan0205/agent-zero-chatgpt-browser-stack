from helpers.extension import Extension
from usr.plugins.browser_session_bridge.session import bind

class BrowserSession(Extension):
    async def execute(self, **kwargs):
        bind(self.agent, kwargs.get('call_data', {}), 'main')
        model=kwargs.get('call_data', {}).get('model')
        if model and 'chatgpt-browser' in str(getattr(model,'model_name','')):
            model.kwargs.update(num_retries=0,a0_retry_attempts=0)
