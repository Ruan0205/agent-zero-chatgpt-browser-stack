import unittest
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
from usr.plugins.message_queue_guard.admission import admit

class Context:
    id='test'
    def __init__(self,running=False): self.data={}; self.running=running
    def get_data(self,k): return self.data.get(k)
    def set_data(self,k,v): self.data[k]=v
    def is_running(self): return self.running

class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.ctx=Context(); self.calls=[]; self.logs=[]; self.saved=[]
        self.mq=SimpleNamespace(has_queue=lambda c:bool(c.get_data('queue')),add=self.add)
    def add(self,c,t,a,i):
        q=c.get_data('queue') or []; q.append({'id':i,'text':t,'attachments':a}); c.set_data('queue',q)
    def send(self,t,a,i): self.calls.append((t,a,i)); self.ctx.running=True; return 'task'
    def submit(self,t='one',a=None,i='id1'):
        return admit(self.ctx,t,a or [],i,self.mq,self.send,lambda *a:self.logs.append(a),self.saved.append,lambda *a,**k:None)
    def test_idle_starts_once(self):
        self.assertEqual(self.submit(),('task',False)); self.assertEqual(len(self.calls),1)
    def test_busy_queues_without_intervention_or_log(self):
        self.ctx.running=True; self.assertEqual(self.submit(),(None,True)); self.assertFalse(self.calls); self.assertFalse(self.logs)
    def test_fifo_and_attachments(self):
        self.ctx.running=True; self.submit(a=['/a0/usr/uploads/a.png']); self.submit('two',i='id2')
        self.assertEqual([x['text'] for x in self.ctx.data['queue']],['one','two']); self.assertEqual(self.ctx.data['queue'][0]['attachments'],['/a0/usr/uploads/a.png'])
    def test_existing_queue_never_overtaken(self):
        self.add(self.ctx,'old',[],'old'); self.submit(); self.assertFalse(self.calls); self.assertEqual(self.ctx.data['queue'][0]['text'],'old')
    def test_duplicate_queued_id_not_added_twice(self):
        self.ctx.running=True; self.submit(); self.submit(); self.assertEqual(len(self.ctx.data['queue']),1)
    def test_duplicate_started_id_never_replays(self):
        self.submit(); self.ctx.running=False; self.submit(); self.assertEqual(len(self.calls),1)
    def test_concurrent_sends_have_one_active_and_one_queued(self):
        with ThreadPoolExecutor(2) as pool: list(pool.map(lambda i:self.submit(i=i),['a','b']))
        self.assertEqual(len(self.calls),1); self.assertEqual(len(self.ctx.data['queue']),1)
    def test_queue_persisted(self):
        self.ctx.running=True; self.submit(); self.assertEqual(self.saved,[self.ctx])
