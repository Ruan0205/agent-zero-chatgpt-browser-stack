import importlib.util
import json
import tempfile
import time
import unittest
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
                if message.startswith("Autorizo o reparo"):
                    self.assertTrue((controller.CONTROL / f"{context_id}.approved").exists())
                return {"context_id": context_id or "repair-1", "response": "diagnóstico" if not context_id else "reparado"}

            original = controller.invoke
            original_ensure = controller.ensure_services
            original_stop = controller.stop_services
            controller.invoke = invoke
            controller.ensure_services = lambda: None
            controller.stop_services = lambda: None
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
                controller.stop_services = original_stop

    def wait_phase(self, source_id, expected):
        for _ in range(200):
            if controller.sessions().get(source_id, {}).get("phase") == expected:
                return
            time.sleep(.01)
        self.fail(f"phase never reached {expected}: {controller.sessions()}")


if __name__ == "__main__":
    unittest.main()
