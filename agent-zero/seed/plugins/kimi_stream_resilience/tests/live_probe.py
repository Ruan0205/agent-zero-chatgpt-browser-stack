"""Opt-in live Kimi non-streaming smoke test; prints no credentials or prompt data."""

import asyncio
import os
from types import SimpleNamespace

from langchain_core.messages import HumanMessage
from models import get_chat_model
from helpers import dotenv
from usr.plugins.kimi_stream_resilience.extensions.python.chat_model_call_before._99_atomic_kimi import AtomicKimiTurn
from usr.plugins.kimi_stream_resilience.resilience import KimiRetryModel


async def main() -> None:
    dotenv.load_dotenv()
    key = os.environ.get("API_KEY_OTHER")
    if not key:
        raise RuntimeError("API_KEY_OTHER is unavailable in the Agent Zero container")
    model = get_chat_model(
        "other",
        "kimi-k3",
        api_base="https://api5.we64.com/v1",
        api_key=key,
        timeout=120,
        num_retries=0,
        max_tokens=128,
    )
    agent = SimpleNamespace(context=SimpleNamespace(log=SimpleNamespace(log=lambda **_: None)))
    call_data = {"model": model}
    await AtomicKimiTurn(agent=agent).execute(call_data=call_data)
    if not isinstance(call_data["model"], KimiRetryModel):
        raise AssertionError("Kimi hook did not install its safe model wrapper")
    browser = SimpleNamespace(model_name="openai/chatgpt-browser")
    browser_call = {"model": browser}
    await AtomicKimiTurn(agent=agent).execute(call_data=browser_call)
    if browser_call["model"] is not browser:
        raise AssertionError("Browser transport must not be modified")
    result = await call_data["model"].unified_turn(
        messages=[HumanMessage(content="Responda somente: OK")],
        response_callback=lambda *_: (_ for _ in ()).throw(AssertionError("streaming callback used")),
    )
    print("KIMI_NONSTREAM_OK=" + str("OK" in (result.response or "").upper()))


if __name__ == "__main__":
    asyncio.run(main())
