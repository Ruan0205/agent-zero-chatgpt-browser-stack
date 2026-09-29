import sys
from pathlib import Path
from types import SimpleNamespace
import json
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import safety
from plugins._memory.helpers.memory import Memory

class RemovalDispatchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.docs={k:SimpleNamespace(page_content=text,metadata={'id':k}) for k,text in
                   [('a','TEST-SUBJECT first'),('b','TEST-SUBJECT second'),('c','unrelated user memory')]}
        self.memory=SimpleNamespace(db=SimpleNamespace(get_all_docs=lambda:self.docs),
            delete_documents_by_ids=AsyncMock(return_value=[self.docs['a']]))
        self.tool=SimpleNamespace(agent=object())
        self.get=patch.object(Memory,'get',new=AsyncMock(return_value=self.memory)); self.get.start()
        self.backup=patch.object(safety,'checkpoint',return_value='private-test-snapshot'); self.snapshot=self.backup.start()
        self.addCleanup(self.get.stop); self.addCleanup(self.backup.stop)

    async def test_multiple_matches_require_review_no_deletion(self):
        result=await safety.forget_literal(self.tool,query='TEST-SUBJECT',threshold=0)
        self.assertTrue(json.loads(result.message)['confirmation_required'])
        self.memory.delete_documents_by_ids.assert_not_awaited(); self.snapshot.assert_not_called()

    async def test_confirm_only_one_exact_match_no_cascade(self):
        result=await safety.forget_literal(self.tool,query='TEST-SUBJECT',confirm_ids=['a'])
        self.assertEqual(json.loads(result.message)['memories_deleted'],1)
        self.memory.delete_documents_by_ids.assert_awaited_once_with(['a'],cascade=False)
        self.snapshot.assert_called_once_with(self.memory)

    async def test_unrelated_id_is_not_authorized_by_subject(self):
        result=await safety.forget_literal(self.tool,query='TEST-SUBJECT',confirm_ids=['c'])
        self.assertEqual(json.loads(result.message)['memories_deleted'],0)
        self.memory.delete_documents_by_ids.assert_not_awaited()

    async def test_dry_run_does_not_checkpoint_or_delete(self):
        result=await safety.forget_literal(self.tool,query='first',dry_run=True)
        self.assertEqual(json.loads(result.message)['preview_ids'],['a'])
        self.memory.delete_documents_by_ids.assert_not_awaited(); self.snapshot.assert_not_called()

    async def test_exact_id_delete_never_cascades(self):
        await safety.delete_exact(self.tool,ids='a,a')
        self.memory.delete_documents_by_ids.assert_awaited_once_with(['a'],cascade=False)
        self.snapshot.assert_called_once_with(self.memory)

    async def test_invalid_id_payload_deletes_nothing(self):
        await safety.delete_exact(self.tool,ids=['a'])
        self.memory.delete_documents_by_ids.assert_not_awaited(); self.snapshot.assert_not_called()
