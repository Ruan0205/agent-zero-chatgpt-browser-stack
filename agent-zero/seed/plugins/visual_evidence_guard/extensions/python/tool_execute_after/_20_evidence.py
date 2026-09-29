import json
from helpers.extension import Extension


class EvidenceAfter(Extension):
    async def execute(self, tool_name='', response=None, **kwargs):
        tool = self.agent.loop_data.current_tool
        args = getattr(tool, 'args', {}) or {}
        if tool_name.split(':')[0] == 'browser' and args.get('action') == 'screenshot':
            try:
                data = json.loads(response.message)
                report = data.get('visual_evidence')
                if report:
                    self.agent.context.set_data('last_visual_capture', report)
            except (ValueError, TypeError):
                pass
        if tool_name.split(':')[0] == 'vision_load' and self.agent.context.get_data('visual_review_evidence'):
            if response.message.startswith(('Loaded images', 'Analyzed ')):
                from pathlib import Path
                loaded = set(self.agent.context.get_data('visual_review_loaded') or [])
                loaded.update(str(Path(p).resolve()) for p in getattr(tool, 'loaded_paths', []))
                self.agent.context.set_data('visual_review_loaded', sorted(loaded))
