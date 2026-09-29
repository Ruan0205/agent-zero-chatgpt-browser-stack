import importlib.util
import json
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("repair_controller", Path(__file__).with_name("controller.py"))
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)


class RepairControllerTest(unittest.TestCase):
    def test_persistent_binding_and_scoped_approval(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            controller.ROOT = root / "incidents"
            controller.SESSIONS = controller.ROOT / "repair-sessions.json"
            controller.INPUTS = controller.ROOT / "repair-inputs"
            controller.CONTROL = root / "control"
            controller.CHATS = root / "chats"
            source = controller.CHATS / "source-1"
            source.mkdir(parents=True)
            (source / "chat.json").write_text(json.dumps({"messages": ["erro"]}))
            seen = []

            def invoke(url, token, message, context_id=""):
                seen.append((context_id, message))
                if message.startswith("AUTORIZAÇÃO FORMAL"):
                    self.assertTrue((controller.CONTROL / f"{context_id}.approved").exists())
                return {"context_id": context_id or "repair-1", "response": "diagnóstico" if not context_id else "reparado"}

            original = controller.invoke
            original_ensure = controller.ensure_services
            original_token = controller.runtime_agent_token
            original_fingerprint = controller.repair_repo_fingerprint
            original_cache = controller._repair_api_token_cache
            controller.invoke = invoke
            controller.ensure_services = lambda: None
            controller.runtime_agent_token = lambda name: 'test-token-only'
            controller._repair_api_token_cache = ''
            fingerprints = iter(['before', 'after'])
            controller.repair_repo_fingerprint = lambda: next(fingerprints)
            try:
                with self.assertRaisesRegex(ValueError, "Descreva o erro atual"):
                    controller.action({"action": "diagnose_chat", "context_id": "source-1"})
                controller.action({"action": "diagnose_chat", "context_id": "source-1",
                                   "chat_name": "Teste", "error_description": "falha atual no anexo",
                                   "interface_snapshot": {"alert": "erro"}})
                self.wait_phase("source-1", "awaiting_approval")
                self.assertEqual(controller.sessions()["source-1"]["context_id"], "repair-1")
                self.assertEqual(len(seen), 1)
                controller.action({"action": "diagnose_chat", "context_id": "source-1",
                                   "error_description": "falha atual no anexo"})
                self.assertEqual(len(seen), 1)
                controller.action({"action": "diagnose_chat", "context_id": "source-1",
                                   "error_description": "erro novo no mesmo chat"})
                self.wait_phase("source-1", "awaiting_approval")
                self.assertEqual(seen[1][0], "repair-1")
                controller.action({"action": "approve_repair", "context_id": "source-1"})
                self.wait_phase("source-1", "repaired")
                self.assertEqual(seen[2][0], "repair-1")
                self.assertFalse((controller.CONTROL / "repair-1.approved").exists())
                controller.action({"action": "diagnose_chat", "context_id": "source-1",
                                   "error_description": "o mesmo erro persiste"})
                self.wait_phase("source-1", "awaiting_approval")
                self.assertEqual(seen[3][0], "repair-1")
            finally:
                controller.invoke = original
                controller.ensure_services = original_ensure
                controller.runtime_agent_token = original_token
                controller.repair_repo_fingerprint = original_fingerprint
                controller._repair_api_token_cache = original_cache

    def test_kimi_repair_has_no_browser_dependency(self):
        with patch.dict(controller.os.environ, {'REPAIR_REQUIRES_BROWSER': 'false'}):
            with patch.object(controller, 'container_action') as docker, patch.object(controller, 'wait_http') as http:
                controller.ensure_services()
                docker.assert_called_once_with('agent-zero-repair', 'start')
                http.assert_called_once_with('http://agent-zero-repair/login')

    def test_browser_repair_is_explicit_opt_in(self):
        with patch.dict(controller.os.environ, {'REPAIR_REQUIRES_BROWSER': 'true'}):
            with patch.object(controller, 'container_action') as docker, patch.object(controller, 'wait_http') as http:
                controller.ensure_services()
                self.assertEqual(docker.call_args_list[0].args, ('chatgpt-browser-repair', 'start'))
                self.assertEqual(http.call_args_list[0].args, ('http://chatgpt-browser-repair:8000/health',))

    def wait_phase(self, source_id, expected):
        for _ in range(200):
            if controller.sessions().get(source_id, {}).get("phase") == expected:
                return
            time.sleep(.01)
        self.fail(f"phase never reached {expected}: {controller.sessions()}")


if __name__ == "__main__":
    unittest.main()
