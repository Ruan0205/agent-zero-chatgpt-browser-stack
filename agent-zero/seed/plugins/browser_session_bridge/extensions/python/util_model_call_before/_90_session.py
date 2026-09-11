from helpers.extension import Extension
from usr.plugins.browser_session_bridge.session import bind

class BrowserSession(Extension):
    async def execute(self, **kwargs):
        bind(self.agent, kwargs.get('call_data', {}), 'utility')
        model=kwargs.get('call_data', {}).get('model')
        if model and 'chatgpt-browser' in str(getattr(model,'model_name','')):
            model.kwargs.update(num_retries=0,a0_retry_attempts=0)
            # Also applies when session.py is already imported by a live worker.
            model.kwargs['extra_headers']['X-A0-Call-Scope'] = f'utility:{self.agent.number}:v3'
