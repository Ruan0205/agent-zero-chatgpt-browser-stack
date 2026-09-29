"""Framework hook regressions; run inside /a0 with framework Python."""
import asyncio
import importlib
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from PIL import Image

Before = importlib.import_module('usr.plugins.visual_evidence_guard.extensions.python.tool_execute_before._20_evidence').EvidenceBefore
After = importlib.import_module('usr.plugins.visual_evidence_guard.extensions.python.tool_execute_after._20_evidence').EvidenceAfter
from helpers.errors import RepairableException


class Context:
    def __init__(self): self.data={}
    def get_data(self, key): return self.data.get(key)
    def set_data(self, key, value): self.data[key]=value


class HookTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.file = Path(self.temp.name)/'evidence.png'
        im=Image.new('RGB',(10,10),'black'); im.putpixel((1,1),(255,255,255)); im.save(self.file)
        self.context=Context()
        self.agent=SimpleNamespace(context=self.context,loop_data=SimpleNamespace(current_tool=None))
        self.before=Before(agent=self.agent)
        self.after=After(agent=self.agent)
        self.context.set_data('visual_review_evidence',[str(self.file)])
    async def asyncTearDown(self): self.temp.cleanup()
    async def test_grade_without_load_blocked(self):
        with self.assertRaises(RepairableException):
            await self.before.execute(tool_name='response',tool_args={'text':'Nota 6.5/10'})
    async def test_wrong_upload_blocked(self):
        other=self.file.with_name('wrong.png'); other.write_bytes(self.file.read_bytes())
        with self.assertRaises(RepairableException):
            await self.before.execute(tool_name='vision_load',tool_args={'paths':[str(other)]})
    async def test_expected_path_string_accepted(self):
        await self.before.execute(tool_name='vision_load',tool_args={'paths':str(self.file)})
    async def test_changed_evidence_blocked(self):
        self.context.set_data('visual_review_hashes',{str(self.file):'different-hash'})
        with self.assertRaises(RepairableException):
            await self.before.execute(tool_name='vision_load',tool_args={'paths':[str(self.file)]})
    async def test_failure_report_allowed(self):
        await self.before.execute(tool_name='response',tool_args={'text':'Não avaliável: evidência insuficiente'})
    async def test_successful_load_allows_response(self):
        self.agent.loop_data.current_tool=SimpleNamespace(args={'paths':[str(self.file)]},loaded_paths=[str(self.file)])
        await self.after.execute(tool_name='vision_load',response=SimpleNamespace(message='Loaded images (1)'))
        await self.before.execute(tool_name='response',tool_args={'text':'Avaliação da imagem carregada'})
    async def test_skipped_image_not_marked_loaded(self):
        self.agent.loop_data.current_tool=SimpleNamespace(args={'paths':[str(self.file)]},loaded_paths=[])
        await self.after.execute(tool_name='vision_load',response=SimpleNamespace(message='Loaded images (0)'))
        self.assertEqual(self.context.get_data('visual_review_loaded'),[])
    async def test_vision_error_not_marked_loaded(self):
        self.agent.loop_data.current_tool=SimpleNamespace(args={'paths':[str(self.file)]},loaded_paths=[str(self.file)])
        await self.after.execute(tool_name='vision_load',response=SimpleNamespace(message='Image analysis error: failed'))
        self.assertIsNone(self.context.get_data('visual_review_loaded'))
