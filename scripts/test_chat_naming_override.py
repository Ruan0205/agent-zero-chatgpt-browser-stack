#!/usr/bin/env python3

import importlib.util
import sys
import types
from pathlib import Path


def module(name: str, **attributes):
    value = types.ModuleType(name)
    for key, item in attributes.items():
        setattr(value, key, item)
    sys.modules[name] = value
    return value


class Extension:
    pass


class Dummy:
    pass


module("agent", AgentContext=Dummy, AgentContextType=Dummy, LoopData=Dummy)
module("helpers")
module("helpers.extension", Extension=Extension)
module(
    "helpers.notification",
    NotificationManager=Dummy,
    NotificationPriority=Dummy,
    NotificationType=Dummy,
)
module("plugins")
module("plugins._chat_naming")
module("plugins._chat_naming.helpers")
module("plugins._chat_naming.helpers.naming", naming=Dummy)

path = (
    Path(__file__).resolve().parents[1]
    / "agent-zero"
    / "overrides"
    / "_60_rename_chat.py"
)
spec = importlib.util.spec_from_file_location("chat_naming_override", path)
target = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(target)


class Agent:
    def read_prompt(self, name):
        assert name == "fw.initial_user_message.md"
        return "Hello!\n"


agent = Agent()
assert target.real_user_messages(agent, ["Hello!", "Corrija meu servidor"]) == [
    "Corrija meu servidor"
]
assert target.real_user_messages(agent, ["Hello!", "Hello!"]) == ["Hello!"]
assert target.real_user_messages(agent, ["Pedido real"]) == ["Pedido real"]
assert target.real_user_messages(agent, []) == []
print("chat naming placeholder regression: PASS")
