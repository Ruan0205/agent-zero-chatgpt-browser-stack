#!/usr/bin/env python3

import importlib.util
import json
import os
import tempfile
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "migrate_persistent_state.py"


def load_migration(data: Path, seed: Path):
    os.environ["STACK_DATA_ROOT"] = str(data)
    os.environ["STACK_SEED_ROOT"] = str(seed)
    os.environ["STACK_SCHEMA_VERSION"] = "test-schema"
    spec = importlib.util.spec_from_file_location("persistent_migration", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def main() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        base = Path(temporary)
        data = base / "data"
        seed = base / "seed"
        bridge_seed = seed / "plugins" / "browser_session_bridge"
        bridge_live = data / "agent-zero" / "plugins" / "browser_session_bridge"
        bridge_seed.mkdir(parents=True)
        bridge_live.mkdir(parents=True)
        (bridge_seed / "plugin.yaml").write_text("version: new\n", encoding="utf-8")
        (bridge_live / "plugin.yaml").write_text("version: old\n", encoding="utf-8")
        cache = bridge_live / "__pycache__"
        cache.mkdir()
        (cache / "stale.pyc").write_bytes(b"obsolete")
        retired = data / "agent-zero" / "plugins" / "retired_stack_plugin"
        retired.mkdir(parents=True)
        (retired / "legacy.txt").write_text("retired\n", encoding="utf-8")
        operator_file = data / "operator-owned.txt"
        operator_file.write_text("preserve\n", encoding="utf-8")
        (seed / "obsolete-paths.json").write_text(
            json.dumps({
                "exact_paths": ["agent-zero/plugins/retired_stack_plugin"],
                "managed_cache_roots": ["agent-zero/plugins/browser_session_bridge"],
            }),
            encoding="utf-8",
        )

        model_dir = data / "agent-zero" / "plugins" / "_model_config"
        model_dir.mkdir(parents=True)
        presets = [
            {
                "name": "Power",
                "chat": {"name": "chatgpt-browser"},
                "utility": {
                    "provider": "other",
                    "name": "google/gemma-4-E2B-it",
                    "api_base": "https://api.featherless.ai/v1",
                },
            },
            {
                "name": "Custom",
                "chat": {"name": "local-model"},
                "utility": {"provider": "other", "name": "operator-choice"},
            },
        ]
        (model_dir / "presets.yaml").write_text(
            yaml.safe_dump(presets, sort_keys=False), encoding="utf-8"
        )

        chat_dir = data / "agent-zero" / "chats" / "example"
        chat_dir.mkdir(parents=True)
        chat = {
            "data": {
                "browser_model_lock": {
                    "preset_name": "Power",
                    "model_name": "openai/chatgpt-browser",
                },
                "chat_model_override": {
                    "chat": {"name": "chatgpt-browser"},
                    "utility": {"name": "google/gemma-4-E2B-it"},
                },
            }
        }
        chat_path = chat_dir / "chat.json"
        chat_path.write_text(json.dumps(chat), encoding="utf-8")

        migration = load_migration(data, seed)
        try:
            migration._safe_data_path("../escape")
        except ValueError:
            pass
        else:
            raise AssertionError("path traversal was accepted")
        migration.main()
        migration.main()  # Must remain safe on every container restart.

        assert (bridge_live / "plugin.yaml").read_text() == "version: new\n"
        migrated_presets = yaml.safe_load((model_dir / "presets.yaml").read_text())
        assert migrated_presets[0]["utility"]["name"] == "chatgpt-browser-utility"
        assert migrated_presets[1]["utility"]["name"] == "operator-choice"
        migrated_chat = json.loads(chat_path.read_text())
        utility = migrated_chat["data"]["chat_model_override"]["utility"]
        assert utility["name"] == "chatgpt-browser-utility"
        assert utility["api_base"] == "http://chatgpt-browser-utility:8000/v1"
        assert not retired.exists()
        assert not cache.exists()
        assert operator_file.read_text() == "preserve\n"
        assert (
            data
            / ".stack-backups"
            / "test-schema"
            / "agent-zero/plugins/retired_stack_plugin/legacy.txt"
        ).read_text() == "retired\n"
        assert (data / ".stack-backups" / "test-schema").exists()
        marker = json.loads((data / ".stack-migrations" / "test-schema.json").read_text())
        assert marker["obsolete_removed"] == []
        assert marker["bridge_synced"] is False
        assert marker["presets_migrated"] == 0
        assert marker["browser_chats_migrated"] == 0
        print("persistent migration regression: PASS")


if __name__ == "__main__":
    main()
