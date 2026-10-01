"""Read-only check that Agent Zero discovers the installed extension."""

import asyncio
from types import SimpleNamespace

from helpers.errors import HandledException
from helpers.extension import _get_extension_classes
from usr.plugins.kimi_stream_resilience.resilience import KimiRetriesExhausted


classes = _get_extension_classes("chat_model_call_before")
active = any(cls.__name__ == "AtomicKimiTurn" for cls in classes)
native = any(cls.__name__ == "NativeKimiTools" for cls in classes)
print("KIMI_EXTENSION_DISCOVERED=" + str(active))
print("KIMI_NATIVE_TOOLS_DISCOVERED=" + str(native))
handlers = _get_extension_classes("_functions/agent/Agent/handle_exception/end")
handled = any(cls.__name__ == "HandleKimiExhaustion" for cls in handlers)
print("KIMI_ERROR_HANDLER_DISCOVERED=" + str(handled))
if not active or not native or not handled:
    raise SystemExit(1)

# The bounded provider retry must not cascade into the generic whole-turn
# retry, which could replay tool decisions and consume extra API calls.
handler_type = next(cls for cls in handlers if cls.__name__ == "HandleKimiExhaustion")
recorded = []
fake_agent = SimpleNamespace(context=SimpleNamespace(log=SimpleNamespace(log=lambda **kw: recorded.append(kw))))
payload = {"exception": KimiRetriesExhausted("test exhaustion")}
asyncio.run(handler_type(agent=fake_agent).execute(data=payload))
guarded = isinstance(payload["exception"], HandledException) and len(recorded) == 1
print("KIMI_EXHAUSTION_GUARDED=" + str(guarded))
if not guarded:
    raise SystemExit(1)
