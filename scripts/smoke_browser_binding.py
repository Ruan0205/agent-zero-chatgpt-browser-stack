"""One disposable Power chat, two sequential turns through Agent Zero's API."""

import json
import sys
import urllib.request

from agent import AgentContext, AgentContextType
from helpers.persist_chat import save_tmp_chat
from helpers.settings import get_settings
from initialize import initialize_agent


if len(sys.argv) < 2 or sys.argv[1] not in {"prepare", "run", "turn", "cleanup"}:
    sys.exit("usage: smoke_browser_binding.py prepare | run CONTEXT_ID | turn CONTEXT_ID MARKER | cleanup CONTEXT_ID")

if sys.argv[1] == "prepare":
    context = AgentContext(config=initialize_agent(), type=AgentContextType.USER)
    AgentContext.use(context.id)
    context.set_data("chat_model_override", {"preset_name": "Power"})
    save_tmp_chat(context)
    print(f"CONTEXT_ID={context.id}", flush=True)
    sys.exit(0)

context_id = sys.argv[2]
if sys.argv[1] == "cleanup":
    token = get_settings()["mcp_server_token"]
    request = urllib.request.Request(
        "http://127.0.0.1/api/api_terminate_chat",
        json.dumps({"context_id": context_id}).encode(),
        {"Content-Type": "application/json", "X-API-KEY": token},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        assert json.load(response).get("success")
    print(f"CLEANED={context_id}", flush=True)
    sys.exit(0)

token = get_settings()["mcp_server_token"]
markers = (sys.argv[3],) if sys.argv[1] == "turn" else ("BROWSER-BINDING-ONE", "BROWSER-BINDING-TWO")
for number, marker in enumerate(markers, 1):
    payload = json.dumps({
        "context_id": context_id,
        "message": f"Diga somente {marker}.",
        "lifetime_hours": 1,
    }).encode()
    request = urllib.request.Request(
        "http://127.0.0.1/api/api_message", payload,
        {"Content-Type": "application/json", "X-API-KEY": token},
    )
    with urllib.request.urlopen(request, timeout=420) as response:
        result = json.load(response)
    answer = str(result.get("response") or "")
    print(f"TURN_{number}={answer[:300]!r}", flush=True)
    if marker not in answer:
        sys.exit(f"Turn {number} did not contain expected marker")

print(f"PASS {len(markers)} Agent Zero turn(s) in browser-backed context", flush=True)
