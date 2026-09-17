from helpers.extension import Extension
from agent import LoopData
from helpers.defer import DeferredTask, THREAD_BACKGROUND
from helpers.history import Message, clear_responses_provider_state
from plugins._model_config.helpers import model_config

DATA_NAME_TASK = '_organize_history_task'

BROWSER_MESSAGE_CHAR_LIMIT = 48000
BROWSER_MESSAGE_PREVIEW_CHARS = 12000

def compact_oversized_browser_messages(history, char_limit: int = BROWSER_MESSAGE_CHAR_LIMIT) -> bool:
    changed = False
    for msg in history.all_messages():
        if getattr(msg, 'summary', ''):
            continue
        text = msg.output_text()
        if len(text) <= char_limit:
            continue
        edge = min(BROWSER_MESSAGE_PREVIEW_CHARS, max(1, (char_limit - 1024) // 2))
        msg.set_summary(f'[Large message compacted for model context; original_chars={len(text)}. Full original remains stored in chat history/tool-output files when available.]\n{text[:edge]}\n...[middle omitted from model context]...\n{text[-edge:]}')
        changed = True
    return changed

def browser_history_tail(messages, keep_count):
    """Keep the active user request even after a long chain of tool calls.

    Agent Zero serializes tool results as user-role messages too.  Merely
    retaining the last N messages can leave only tool results and the synthetic
    summary, causing the browser bridge to lose the request it must answer.
    """
    recent = list(messages[-keep_count:])
    for message in reversed(messages[:-keep_count]):
        content = getattr(message, 'content', None)
        if isinstance(content, dict) and isinstance(content.get('user_message'), str):
            return [message, *recent]
    return recent

async def compress_history(agent) -> bool:
    compressed = bool(await agent.history.compress())
    if compressed:
        clear_responses_provider_state(agent)
    return compressed

class OrganizeHistory(Extension):
    async def execute(self, loop_data: LoopData = LoopData(), **kwargs):
        if not self.agent:
            return
        name = str(model_config.get_chat_model_config(self.agent).get('name') or '')
        if name.startswith('chatgpt-browser'):
            # Compact at the end of the turn, not only at the next prompt.
            # The pre-prompt hook remains a safeguard for unusually large
            # incoming user/tool messages.
            cfg = model_config.get_chat_model_config(self.agent)
            limit = int(cfg.get('ctx_length') or 65536) * 0.8
            history = self.agent.history
            if compact_oversized_browser_messages(history):
                clear_responses_provider_state(self.agent)
            keep = 12
            while history.get_tokens() >= limit and keep >= 1:
                messages = list(history.all_messages())
                if len(messages) <= keep:
                    keep //= 2
                    continue
                before = history.get_tokens()
                summary = Message(
                    ai=False,
                    content='[Earlier turns remain in this chat\'s linked ChatGPT browser conversation.]',
                    sequence=int(getattr(messages[0], 'sequence', 0) or 0),
                )
                history.bulks = []
                history.topics = []
                history.current.summary = ''
                history.current.messages = [summary, *browser_history_tail(messages, keep)]
                clear_responses_provider_state(self.agent)
                if history.get_tokens() >= before:
                    keep //= 2
            return
        task = self.agent.get_data(DATA_NAME_TASK)
        if task and not task.is_ready():
            return
        task = DeferredTask(thread_name=THREAD_BACKGROUND)
        task.start_task(compress_history, self.agent)
        self.agent.set_data(DATA_NAME_TASK, task)
