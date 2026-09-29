import unittest
import threading
import asyncio
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from api.message_async import MessageAsync
from helpers import message_queue as mq
from usr.plugins.message_queue_guard.runtime import install
from usr.plugins.message_queue_guard import durable
from usr.plugins.message_queue_guard.journal import Journal

class Context:
    id='queue-regression'
    def __init__(self):
        self.data={}; self.output_data={}; self.running=True; self.intervention='original'; self.calls=0
        self.log=SimpleNamespace(log=lambda **kwargs:None,logs=[])
    def get_data(self,k): return self.data.get(k)
    def set_data(self,k,v): self.data[k]=v
    def get_output_data(self,k): return self.output_data.get(k)
    def set_output_data(self,k,v): self.output_data[k]=v
    def is_running(self): return self.running
    def get_agent(self): return None
    def communicate(self,msg): self.calls+=1; self.intervention=msg; self.running=True; return SimpleNamespace()

class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.journal=patch.object(durable,'_journal',Journal(Path(self.tmp.name)/'queue.db'));self.journal.start()
        install(); self.ctx=Context(); self.api=MessageAsync(None,threading.RLock())
        self.api.use_context=lambda _:self.ctx
        self.persist=patch('helpers.persist_chat.save_tmp_chat'); self.persist.start()
        self.dirty=patch('helpers.state_monitor_integration.mark_dirty_for_context'); self.dirty.start()
        self.extensions=patch('helpers.extension.call_extensions_async'); self.extensions.start()
    async def asyncTearDown(self): self.persist.stop(); self.dirty.stop(); self.extensions.stop();self.journal.stop();self.tmp.cleanup()
    async def send(self,text='test',id='one'):
        data={'text':text,'context':self.ctx.id,'message_id':id}
        req=SimpleNamespace(content_type='application/json',get_json=lambda:data)
        return await self.api.process(data,req)
    async def test_real_async_handler_queues_busy_chat(self):
        result=await self.send(); self.assertTrue(result['queued']); self.assertEqual(result['queue_length'],1)
        self.assertEqual(self.ctx.intervention,'original'); self.assertEqual(self.ctx.calls,0)
        self.assertEqual(result['message_queue'][0]['id'],'one')
    async def test_real_async_handler_idle_starts(self):
        self.ctx.running=False; result=await self.send(); self.assertFalse(result.get('queued',False)); self.assertEqual(self.ctx.calls,1)
    async def test_busy_handler_duplicate_and_fifo(self):
        await self.send('first'); await self.send('first'); await self.send('second','two')
        self.assertEqual([i['text'] for i in mq.get_queue(self.ctx)],['first','second'])
    async def test_multipart_attachments_retained_in_queue(self):
        attachment=SimpleNamespace(filename='test.txt',save=lambda p:Path(p).write_text('fixture'))
        req=SimpleNamespace(content_type='multipart/form-data',form={'text':'file','context':self.ctx.id,'message_id':'file-1'},files=SimpleNamespace(getlist=lambda _:[attachment]))
        with patch('helpers.files.get_abs_path',side_effect=lambda *args:str(Path(self.tmp.name)/args[-1]) if len(args)>1 else self.tmp.name):
            result=await self.api.process({},req)
        self.assertTrue(result['queued']); self.assertTrue(mq.get_queue(self.ctx)[0]['attachments'][0].endswith('-test.txt'))
    async def test_auto_drain_waits_for_active_task_then_sends_head(self):
        from extensions.python.process_chain_end._50_process_queue import ProcessQueue
        await self.send('first'); await self.send('second','two')
        async def finish():
            await asyncio.sleep(0.02); self.assertEqual(self.ctx.calls,0); self.ctx.running=False
        await asyncio.gather(finish(),ProcessQueue(agent=None)._delayed_send(self.ctx))
        self.assertEqual(self.ctx.calls,1); self.assertEqual(self.ctx.intervention.message,'first')
        self.assertEqual(mq.get_queue(self.ctx)[0]['text'],'second')
        self.assertEqual(durable.journal().active(self.ctx.id)['text'],'first')

    async def test_dispatch_error_keeps_message_and_blocks_following(self):
        self.ctx.running=False
        self.ctx.communicate=lambda msg:(_ for _ in ()).throw(RuntimeError('worker failed'))
        with self.assertRaises(RuntimeError):await self.send()
        self.assertEqual(durable.journal().active(self.ctx.id)['state'],'blocked')
        await self.send('next','two');self.assertEqual(len(mq.get_queue(self.ctx)),1)

    async def test_only_finished_main_response_acknowledges(self):
        self.ctx.running=False;await self.send();self.ctx.running=False
        self.ctx.log.logs=[SimpleNamespace(no=1,type='user',id='one',kvps={},agentno=0),SimpleNamespace(no=2,type='warning',kvps={},agentno=0)]
        self.assertFalse(durable.finish(self.ctx));self.assertIsNotNone(durable.journal().active(self.ctx.id))
        self.ctx.log.logs=[SimpleNamespace(no=1,type='user',id='one',kvps={},agentno=0),SimpleNamespace(no=2,type='response',kvps={'finished':True},agentno=1)]
        self.assertFalse(durable.finish(self.ctx))
        self.ctx.log.logs=[SimpleNamespace(no=1,type='user',id='one',kvps={},agentno=0),SimpleNamespace(no=3,type='response',kvps={'finished':True},agentno=0)]
        self.assertTrue(durable.finish(self.ctx));self.assertIsNone(durable.journal().active(self.ctx.id))

    async def test_failed_history_save_never_acknowledges(self):
        self.ctx.running=False;await self.send();self.ctx.running=False
        self.ctx.log.logs=[SimpleNamespace(no=1,type='user',id='one',kvps={},agentno=0),SimpleNamespace(no=3,type='response',kvps={'finished':True},agentno=0)]
        with patch('helpers.persist_chat.save_tmp_chat',side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):durable.finish(self.ctx)
        self.assertIsNotNone(durable.journal().active(self.ctx.id))

    async def test_receipt_survives_beyond_old_128_limit(self):
        for i in range(140):await self.send('message '+str(i),str(i))
        await self.send('message 0','0')
        self.assertEqual(len(mq.get_queue(self.ctx)),140)

    async def test_intervening_user_response_does_not_acknowledge_queued_item(self):
        self.ctx.running=False;await self.send();self.ctx.running=False
        self.ctx.log.logs=[SimpleNamespace(no=1,type='user',id='one',kvps={},agentno=0),
            SimpleNamespace(no=2,type='user',id='other',kvps={},agentno=0),
            SimpleNamespace(no=3,type='response',kvps={'finished':True},agentno=0)]
        self.assertFalse(durable.finish(self.ctx));self.assertIsNotNone(durable.journal().active(self.ctx.id))

    async def test_old_pending_head_starts_without_claiming_new_message_consumed(self):
        await self.send('head','one');self.ctx.running=False
        result=await self.send('tail','two')
        self.assertTrue(result['queued']);self.assertEqual(self.ctx.intervention.message,'head')
        self.assertEqual(mq.get_queue(self.ctx)[0]['text'],'tail')

    async def test_foreign_attachment_reference_is_rejected(self):
        req=SimpleNamespace(content_type='application/json',get_json=lambda:{'text':'edit','context':self.ctx.id,
            'existing_attachments':['/a0/usr/uploads/foreign.png'],'draft_id':'none','message_id':'foreign'})
        with self.assertRaises(ValueError):await self.api.process({},req)
        self.assertEqual(mq.get_queue(self.ctx),[])

    async def test_edited_existing_attachment_does_not_need_reupload(self):
        durable.add(self.ctx,'old',['/a0/usr/uploads/a.png'],'old')
        durable.journal().edit(self.ctx.id,'old')
        req=SimpleNamespace(content_type='application/json',get_json=lambda:{'text':'edited','context':self.ctx.id,
            'existing_attachments':['/a0/usr/uploads/a.png'],'draft_id':'old','message_id':'edited'})
        result=await self.api.process({},req)
        self.assertTrue(result['queued']);self.assertEqual(mq.get_queue(self.ctx)[0]['attachments'],['/a0/usr/uploads/a.png'])
        self.assertEqual(durable.journal().rows(self.ctx.id,'draft'),[])
