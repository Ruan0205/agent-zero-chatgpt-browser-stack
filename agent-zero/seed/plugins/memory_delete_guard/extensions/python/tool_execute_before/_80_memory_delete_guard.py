from types import MethodType
from helpers.extension import Extension
from usr.plugins.memory_delete_guard.safety import checkpoint, forget_literal


class MemoryDeleteGuard(Extension):
    async def execute(self, tool_name='', **kwargs):
        if tool_name == 'memory_forget':
            tool = self.agent.loop_data.current_tool
            if tool is None: raise RuntimeError('Não há ferramenta ativa para validar a remoção.')
            tool.execute = MethodType(forget_literal, tool)
        elif tool_name == 'memory_delete':
            from usr.plugins.memory_delete_guard.safety import delete_exact
            tool = self.agent.loop_data.current_tool
            if tool is None: raise RuntimeError('Não há ferramenta ativa para validar a remoção.')
            tool.execute = MethodType(delete_exact, tool)
