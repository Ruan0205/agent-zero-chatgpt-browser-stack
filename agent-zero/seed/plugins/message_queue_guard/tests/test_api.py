import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from usr.plugins.message_queue_guard import durable
from usr.plugins.message_queue_guard.journal import Journal
from usr.plugins.message_queue_guard.api.queue import Queue

class QueueApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.dbpatch=patch.object(durable,'_journal',Journal(Path(self.tmp.name)/'queue.db'));self.dbpatch.start()
        self.data={};self.out={}
        self.ctx=SimpleNamespace(id='api-fixture',paused=False,log=SimpleNamespace(logs=[]),
            get_data=lambda k:self.data.get(k),set_data=lambda k,v:self.data.update({k:v}),
            get_output_data=lambda k:self.out.get(k),set_output_data=lambda k,v:self.out.update({k:v}),is_running=lambda:True)
        self.contextpatch=patch('agent.AgentContext.get',return_value=self.ctx);self.contextpatch.start()
        self.persist=patch('helpers.persist_chat.save_tmp_chat');self.persist.start()
        self.api=object.__new__(Queue)
    async def asyncTearDown(self):self.persist.stop();self.contextpatch.stop();self.dbpatch.stop();self.tmp.cleanup()
    async def call(self,action='snapshot',**data):return await self.api.process({'context':self.ctx.id,'action':action,**data},None)
    async def test_standard_auth_and_csrf_protections_not_overridden(self):
        self.assertNotIn('requires_auth',Queue.__dict__);self.assertNotIn('requires_csrf',Queue.__dict__)
    async def test_snapshot_is_not_the_full_message(self):
        durable.add(self.ctx,'x'*1000,[], 'one');result=await self.call()
        self.assertEqual(len(result['items'][0]['text']),100)
        self.assertEqual(result['logs'],[])
    async def test_snapshot_returns_authoritative_recent_log_tail(self):
        items=[SimpleNamespace(output=lambda n=n:{'no':n,'id':f'log-{n}'}) for n in range(170)]
        self.ctx.log.logs=items
        result=await self.call()
        self.assertEqual(len(result['logs']),160)
        self.assertEqual(result['logs'][0]['id'],'log-10')
        self.assertEqual(result['logs'][-1]['id'],'log-169')
    async def test_nudge_is_not_offered_for_kimi_or_a_running_browser(self):
        self.data['chat_model_override']={'chat':{'name':'kimi-k3'}}
        self.assertFalse((await self.call())['nudge_available'])
        self.data['chat_model_override']={'chat':{'name':'chatgpt-browser'}}
        self.assertFalse((await self.call())['nudge_available'])
        self.ctx.is_running=lambda:False
        self.assertTrue((await self.call())['nudge_available'])
    async def test_edit_returns_complete_text_and_attachment_paths(self):
        durable.add(self.ctx,'x'*1000,['/a0/usr/uploads/file.png'],'one')
        result=await self.call('edit',item_id='one');self.assertEqual(len(result['draft']['text']),1000)
        self.assertEqual(result['items'],[]);self.assertEqual(result['draft']['attachments'],['/a0/usr/uploads/file.png'])
    async def test_conflict_edit_of_active_message_returns_409(self):
        durable.add(self.ctx,'one',[],'one');durable.journal().reserve(self.ctx.id,1)
        result=await self.call('edit',item_id='one');self.assertEqual(result.status_code,409)
    async def test_move_updates_projection(self):
        durable.add(self.ctx,'one',[],'one');durable.add(self.ctx,'two',[],'two')
        result=await self.call('move',item_id='two',delta=-1);self.assertEqual(result['items'][0]['id'],'two')
    async def test_send_does_not_interrupt_busy_context(self):
        durable.add(self.ctx,'one',[],'one');result=await self.call('send',item_id='one')
        self.assertEqual(result.status_code,409);self.assertEqual(len(durable.get_queue(self.ctx)),1)
    async def test_invalid_action_returns_400(self):
        self.assertEqual((await self.call('invented')).status_code,400)
    async def test_missing_context_returns_404(self):
        with patch('agent.AgentContext.get',return_value=None):self.assertEqual((await self.call()).status_code,404)
