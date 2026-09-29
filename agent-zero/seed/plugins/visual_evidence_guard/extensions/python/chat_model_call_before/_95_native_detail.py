from helpers.extension import Extension
from usr.plugins.visual_evidence_guard.native_vision import detailed_messages

class NativeVisualDetail(Extension):
    async def execute(self, **kwargs):
        data = kwargs.get('call_data')
        if not isinstance(data, dict): return
        model = data.get('model')
        if 'kimi-k3' not in str(getattr(model, 'model_name', '')).casefold(): return
        if isinstance(data.get('messages'), list):
            data['messages'] = detailed_messages(data['messages'])
