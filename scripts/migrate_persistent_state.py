#!/usr/bin/env python3
"""Idempotent migrations for state created by older public stack releases."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path

import yaml


VERSION = os.environ.get("STACK_SCHEMA_VERSION", "v2.12-stack.7")
DATA = Path(os.environ.get("STACK_DATA_ROOT", "/data"))
SEED = Path(os.environ.get("STACK_SEED_ROOT", "/seed"))
BACKUP = DATA / ".stack-backups" / VERSION
MARKER = DATA / ".stack-migrations" / f"{VERSION}.json"

EXPECTED_UTILITY = {
    "provider": "other",
    "name": "chatgpt-browser-utility",
    "api_base": "http://chatgpt-browser-utility:8000/v1",
    "kwargs": {"temperature": 0.4, "timeout": 600},
    "ctx_length": 65536,
    "ctx_input": 0.85,
    "rl_requests": 0,
    "rl_input": 0,
    "rl_output": 0,
}


def _json_dump(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _text_dump(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _backup(path: Path) -> None:
    if not path.exists():
        return
    relative = path.relative_to(DATA)
    target = BACKUP / relative
    if target.exists():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    if path.is_dir():
        shutil.copytree(path, target)
    else:
        shutil.copy2(path, target)


def _tree_digest(path: Path) -> str:
    digest = hashlib.sha256()
    if not path.exists():
        return "missing"
    for item in sorted(path.rglob("*")):
        if not item.is_file() or item.suffix == ".pyc" or "__pycache__" in item.parts:
            continue
        digest.update(str(item.relative_to(path)).encode())
        digest.update(item.read_bytes())
    return digest.hexdigest()


def _safe_data_path(relative: str) -> Path:
    candidate = (DATA / relative).resolve()
    root = DATA.resolve()
    if candidate == root or root not in candidate.parents:
        raise ValueError(f"obsolete path escapes data root: {relative!r}")
    return candidate


def cleanup_obsolete() -> list[str]:
    """Remove only release-owned paths declared by an audited seed manifest."""
    manifest_path = SEED / "obsolete-paths.json"
    if not manifest_path.exists():
        return []
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    removed: list[str] = []
    for relative in manifest.get("exact_paths", []):
        if not isinstance(relative, str) or not relative.strip():
            continue
        target = _safe_data_path(relative)
        if not target.exists() and not target.is_symlink():
            continue
        _backup(target)
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
        removed.append(relative)

    for relative in manifest.get("managed_cache_roots", []):
        if not isinstance(relative, str) or not relative.strip():
            continue
        root = _safe_data_path(relative)
        if not root.is_dir():
            continue
        caches = [path for path in root.rglob("__pycache__") if path.is_dir()]
        bytecode = [path for path in root.rglob("*.pyc") if path.is_file()]
        for target in bytecode:
            target.unlink()
            removed.append(str(target.relative_to(DATA)))
        for target in sorted(caches, key=lambda path: len(path.parts), reverse=True):
            if target.exists():
                shutil.rmtree(target)
                removed.append(str(target.relative_to(DATA)))
    return sorted(set(removed))


def sync_owned_bridge() -> bool:
    source = SEED / "plugins" / "browser_session_bridge"
    target = DATA / "agent-zero" / "plugins" / "browser_session_bridge"
    if _tree_digest(source) == _tree_digest(target):
        return False
    _backup(target)
    temporary = target.with_name(f".{target.name}.{VERSION}.tmp")
    if temporary.exists():
        shutil.rmtree(temporary)
    shutil.copytree(
        source,
        temporary,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    if target.exists():
        shutil.rmtree(target)
    os.replace(temporary, target)
    return True


def _is_browser_chat(data: dict) -> bool:
    lock = data.get("browser_model_lock")
    if isinstance(lock, dict) and "chatgpt-browser" in str(lock.get("model_name", "")):
        return True
    override = data.get("chat_model_override")
    chat = override.get("chat") if isinstance(override, dict) else None
    return isinstance(chat, dict) and "chatgpt-browser" in str(chat.get("name", ""))


def migrate_chat(path: Path) -> bool:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    data = document.get("data") if isinstance(document, dict) else None
    if not isinstance(data, dict) or not _is_browser_chat(data):
        return False
    override = data.get("chat_model_override")
    if not isinstance(override, dict) or "preset_name" in override:
        return False
    if override.get("utility") == EXPECTED_UTILITY:
        return False
    _backup(path)
    override["utility"] = dict(EXPECTED_UTILITY)
    _json_dump(path, document)
    return True


def _legacy_utility(slot: object) -> bool:
    if not isinstance(slot, dict):
        return False
    name = str(slot.get("name", "")).lower()
    base = str(slot.get("api_base", "")).lower()
    return (
        "gemma-4-e2b-it" in name
        or ("gemma" in name and "featherless" in base)
        or name in {"google/gemma-4-e2b-it", "gemma-4-e2b-it"}
    )


def migrate_presets(path: Path) -> bool:
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return False
    if not isinstance(document, list):
        return False
    changed = False
    for preset in document:
        if isinstance(preset, dict) and _legacy_utility(preset.get("utility")):
            preset["utility"] = dict(EXPECTED_UTILITY)
            changed = True
    if not changed:
        return False
    _backup(path)
    _text_dump(path, yaml.safe_dump(document, sort_keys=False, allow_unicode=True))
    return True


def migrate_legacy_config(path: Path) -> bool:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(document, dict) or not _legacy_utility(document.get("utility_model")):
        return False
    _backup(path)
    document["utility_model"] = dict(EXPECTED_UTILITY)
    _json_dump(path, document)
    return True


def main() -> None:
    results = {
        "version": VERSION,
        "obsolete_removed": cleanup_obsolete(),
        "bridge_synced": sync_owned_bridge(),
        "presets_migrated": 0,
        "legacy_configs_migrated": 0,
        "browser_chats_migrated": 0,
    }
    agent_root = DATA / "agent-zero"
    for path in agent_root.rglob("presets.yaml"):
        if "_model_config" in path.parts and migrate_presets(path):
            results["presets_migrated"] += 1
    for path in agent_root.rglob("config.json"):
        if "_model_config" in path.parts and migrate_legacy_config(path):
            results["legacy_configs_migrated"] += 1
    for path in (agent_root / "chats").glob("*/chat.json"):
        if migrate_chat(path):
            results["browser_chats_migrated"] += 1
    _json_dump(MARKER, results)
    MARKER.chmod(0o644)
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
