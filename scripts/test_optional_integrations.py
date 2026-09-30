#!/usr/bin/env python3
"""Static contract for optional Kimi/WhatsApp and browser-only fallback."""

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]


def env_values():
    values = {}
    for raw in (ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value
    return values


def main():
    compose = yaml.safe_load((ROOT / "docker-compose.yml").read_text(encoding="utf-8"))
    services = compose["services"]
    env = env_values()

    assert services["featherless-queue"]["profiles"] == ["kimi"]
    assert services["meta-ai-whatsapp"]["profiles"] == ["whatsapp"]
    assert services["chatgpt-browser-utility"]["profiles"] == ["browser-utility"]
    assert services["chatgpt-browser-repair"]["profiles"] == ["browser-repair"]

    optional = {
        "featherless-queue", "meta-ai-whatsapp",
        "chatgpt-browser-utility", "chatgpt-browser-repair",
    }
    for name in ("agent-zero", "agent-zero-repair", "repair-controller"):
        dependencies = services[name].get("depends_on", {})
        assert not optional.intersection(dependencies), (name, dependencies)

    assert env["COMPOSE_PROFILES"] == "browser-utility,browser-repair"
    assert env["DEFAULT_MODEL"] == "chatgpt-browser"
    assert env["UTILITY_MODEL"] == "chatgpt-browser-utility"
    assert env["REPAIR_MODEL"] == "chatgpt-browser"
    assert env["REPAIR_REQUIRES_BROWSER"] == "true"
    assert env["CHATGPT_REPAIR_UTILITY_VNC_PORT"] == "50088"
    assert env["WA_PHONE"] == ""
    assert env["STACK_SCHEMA_VERSION"] == "v2.12-stack.15"

    configurer = (ROOT / "scripts/configure-integrations.sh").read_text(encoding="utf-8")
    for expected in (
        "DEFAULT_MODEL kimi-k3", "UTILITY_MODEL kimi-k3", "REPAIR_MODEL kimi-k3",
        "DEFAULT_CONTEXT_LENGTH 1000000", "REPAIR_REQUIRES_BROWSER false",
        'profiles="browser-utility,browser-repair"', 'profiles="kimi"',
        'set_env COMPOSE_PROFILES "$profiles"',
    ):
        assert expected in configurer, expected
    assert "set_env API_KEY_OTHER" not in configurer

    main_mounts = services["agent-zero"]["volumes"]
    repair_mounts = services["agent-zero-repair"]["volumes"]
    for plugin in (
        "kimi_stream_resilience", "message_queue_guard",
        "visual_evidence_guard", "memory_delete_guard",
    ):
        assert any(plugin in mount for mount in main_mounts), plugin
        assert any(plugin in mount for mount in repair_mounts), plugin

    controller_mounts = services["repair-controller"]["volumes"]
    assert any("/repair-repo:ro" in mount for mount in controller_mounts)
    repair = services["chatgpt-browser-repair"]
    assert repair["environment"]["BROWSER_POOL_MIN"] == "2"
    assert repair["environment"]["BROWSER_POOL_MAX"] == "2"
    assert len(repair["ports"]) == 2
    print("optional integrations and browser fallback: PASS")


if __name__ == "__main__":
    main()
