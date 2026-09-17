"""Focused runtime checks; run inside the Agent Zero container from /a0."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from helpers.history import Message
from extensions.python.message_loop_prompts_before._90_organize_history_wait import OrganizeHistoryWait
from extensions.python.message_loop_end._10_organize_history import OrganizeHistory
from extensions.python.message_loop_end._10_organize_history import browser_history_tail, compact_oversized_browser_messages
from extensions.python.hist_add_tool_result._95_bound_large_tool_result import bound_tool_result
from plugins._model_config.api.model_override import ModelOverride, browser_model_is_locked
from plugins._model_config.api.model_presets import ModelPresets
from plugins._model_config.helpers import model_config
from usr.plugins.browser_session_bridge.extensions.python.chat_model_call_before._90_session import BrowserSession


class FakeHistory:
    def __init__(self):
        self.current = SimpleNamespace(summary="", messages=[
            Message(ai=bool(i % 2), content=("turn %d " % i) * 100, sequence=i)
            for i in range(20)
        ])
        self.bulks = []
        self.topics = []

    def all_messages(self):
        return self.current.messages

    def get_tokens(self):
        return sum(message.get_tokens() for message in self.current.messages)


class FakeAgent:
    def __init__(self):
        self.history = FakeHistory()
        self.context = SimpleNamespace(log=SimpleNamespace(log=lambda **kwargs: None))

    def get_data(self, name):
        return None


async def main():
    request = Message(ai=False, content={"user_message": "Confira o processo atual"}, sequence=1)
    tool_tail = [Message(ai=False, content={"tool_name": "code_execution_tool", "tool_result": str(i)}, sequence=i + 2) for i in range(20)]
    retained = browser_history_tail([request, *tool_tail], 4)
    assert retained[0] is request and retained[-1] is tool_tail[-1]
    oversized = Message(ai=False, content={"tool_name": "code_execution_tool", "tool_result": "X" * 1_030_000}, tokens=1, sequence=99)
    assert compact_oversized_browser_messages(SimpleNamespace(all_messages=lambda: [oversized]))
    assert len(oversized.output_text()) < 48_000
    tool_data = {"file": "/a0/usr/chats/test/messages/1.txt", "tool_result": "X" * 1_030_000}
    assert bound_tool_result(tool_data) and len(tool_data["tool_result"]) < 48_000
    assert tool_data["tool_result_original_chars"] == 1_030_000
    agent = FakeAgent()
    before = agent.history.get_tokens()
    with patch("plugins._model_config.helpers.model_config.get_chat_model_config", return_value={"name": "chatgpt-browser", "ctx_length": 1000}):
        await OrganizeHistoryWait(agent).execute()
    assert agent.history.get_tokens() < 800, agent.history.get_tokens()
    assert agent.history.get_tokens() < before
    assert "linked ChatGPT browser" in agent.history.current.messages[0].content
    end_agent = FakeAgent()
    with patch("plugins._model_config.helpers.model_config.get_chat_model_config", return_value={"name": "chatgpt-browser", "ctx_length": 1000}):
        await OrganizeHistory(end_agent).execute()
    assert end_agent.history.get_tokens() < 800

    context = SimpleNamespace(id="unit-test", agent0=agent, get_data=lambda name: {"browser_model_lock": {"preset_name": "Power"}}.get(name))
    with patch("plugins._model_config.api.model_override.AgentContext.get", return_value=context):
        for action in ("set", "set_preset", "clear"):
            result = await object.__new__(ModelOverride).process({"context_id": context.id, "action": action}, None)
            assert result.status_code == 409, (action, result)
        with patch.object(model_config, "get_configured_preset_name", return_value="Default"), \
             patch.object(model_config, "get_effective_preset_name", return_value="Power"):
            result = await object.__new__(ModelOverride).process({"context_id": context.id, "action": "get"}, None)
            assert result["allowed"] is False
            assert result["effective_preset"] == "Power"
    with patch("plugins._model_config.api.model_presets.AgentContext.get", return_value=context):
        result = await object.__new__(ModelPresets).process({"context_id": context.id, "action": "select", "name": "Default"}, None)
        assert result.status_code == 409
    legacy = SimpleNamespace(agent0=agent, get_data=lambda name: None,
                             log=SimpleNamespace(logs=[SimpleNamespace(type="user")]))
    fresh = SimpleNamespace(agent0=agent, get_data=lambda name: None,
                            log=SimpleNamespace(logs=[]))
    with patch.object(model_config, "get_chat_model_config", return_value={"name": "chatgpt-browser"}):
        assert browser_model_is_locked(legacy)
        assert not browser_model_is_locked(fresh)

    data = {}
    mutable_context = SimpleNamespace(
        id="frozen-test",
        get_data=lambda name: data.get(name),
        set_data=lambda name, value: data.__setitem__(name, value),
    )
    frozen_agent = SimpleNamespace(context=mutable_context, number=0)
    browser_cfg = {"provider": "other", "name": "chatgpt-browser", "api_base": "http://chatgpt-browser-agent:8000/v1", "ctx_length": 65536}
    frozen_cfg = {"chat_model": browser_cfg, "vision_model": {}, "utility_model": {}, "embedding_model": {}}
    model = SimpleNamespace(model_name="chatgpt-browser", kwargs={})
    with patch.object(model_config, "get_effective_preset_name", return_value="Power"), \
         patch.object(model_config, "get_effective_config", return_value=frozen_cfg), \
         patch("usr.plugins.browser_session_bridge.extensions.python.chat_model_call_before._90_session.save_tmp_chat"):
        await BrowserSession(frozen_agent).execute(call_data={"model": model})
    assert data["browser_model_lock"]["preset_name"] == "Power"
    assert data["chat_model_override"]["chat"]["name"] == "chatgpt-browser"
    assert model.kwargs["timeout"] == 1200
    mutable_context.agent0 = frozen_agent
    global_qwen = {"chat_model": {"provider": "other", "name": "qwen-local"}, "vision_model": {}, "utility_model": {}, "embedding_model": {}}
    with patch.object(model_config, "get_config", return_value=global_qwen):
        assert model_config.get_chat_model_config(frozen_agent)["name"] == "chatgpt-browser"
        assert model_config.get_effective_preset_name(frozen_agent) == "Power"
    print("PASS 80% compaction, preset lock, and frozen browser configuration")


if __name__ == "__main__":
    asyncio.run(main())
