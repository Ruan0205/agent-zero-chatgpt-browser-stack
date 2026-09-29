import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

spec=importlib.util.spec_from_file_location('queue_journal',Path(__file__).parents[1]/'journal.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
Journal,Conflict=module.Journal,module.Conflict

class JournalTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'queue.sqlite3';self.db=Journal(self.path)
        self.db.migrate('a',[])
    def put(self,id='one',text='pedido',attachments=None,context='a'):
        return self.db.enqueue(context,{'id':id,'text':text,'attachments':attachments or []})
    def test_commit_survives_new_instance(self):
        self.put(attachments=['/a0/usr/uploads/image.png'])
        self.assertEqual(Journal(self.path).rows('a')[0]['attachments'],['/a0/usr/uploads/image.png'])
    def test_hard_process_exit_after_commit(self):
        script="import importlib.util,os; s=importlib.util.spec_from_file_location('j',%r); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); j=m.Journal(%r); j.enqueue('a',{'id':'killed','text':'survive','attachments':[]}); os._exit(17)"%(str(Path(__file__).parents[1]/'journal.py'),str(self.path))
        result=subprocess.run([sys.executable,'-c',script],capture_output=True)
        self.assertEqual(result.returncode,17)
        self.assertEqual(Journal(self.path).rows('a')[0]['id'],'killed')
    def test_reserved_message_retained_until_ack(self):
        self.put();self.db.reserve('a',7)
        self.assertEqual(self.db.active('a')['text'],'pedido')
        self.assertEqual(self.db.rows('a'),[])
        self.db.acknowledge('a','one');self.assertIsNone(self.db.active('a'))
    def test_restart_blocks_uncertain_work_without_replaying(self):
        self.put();self.put('two');self.db.reserve('a',7)
        restarted=Journal(self.path);restarted.recover()
        self.assertEqual(restarted.active('a')['state'],'blocked')
        self.assertIsNone(restarted.reserve('a',8))
        self.assertEqual(restarted.rows('a')[0]['id'],'two')
    def test_resume_preserves_same_id_and_changes_boundary(self):
        self.put();self.db.reserve('a',7);self.db.recover()
        resumed=self.db.resume('a',42)
        self.assertEqual(resumed['id'],'one');self.assertEqual(resumed['boundary'],42)
    def test_duplicate_ids_survive_completion_and_restart(self):
        self.put();self.db.reserve('a',1);self.db.acknowledge('a','one')
        item,created=Journal(self.path).enqueue('a',{'id':'one','text':'','attachments':[]})
        self.assertFalse(created);self.assertEqual(item['state'],'completed')
    def test_duplicate_pending_not_appended(self):
        self.put();self.assertFalse(self.put()[1]);self.assertEqual(len(self.db.rows('a')),1)
    def test_conflicting_id_does_not_replace_payload(self):
        self.put()
        with self.assertRaises(Conflict):self.put(text='different')
        self.assertEqual(self.db.rows('a')[0]['text'],'pedido')
    def test_migration_once_does_not_resurrect_old_chat_snapshot(self):
        self.db.migrate('legacy',[{'id':'old','text':'old','attachments':[]}])
        self.db.remove('legacy','old')
        self.db.migrate('legacy',[{'id':'old','text':'old','attachments':[]}])
        self.assertEqual(self.db.rows('legacy'),[])
    def test_move_order_persisted(self):
        self.put('one');self.put('two');self.put('three')
        self.db.move('a','three',-1);self.db.move('a','three',-1)
        self.assertEqual([x['id'] for x in Journal(self.path).rows('a')],['three','one','two'])
    def test_edit_is_removed_from_queue_and_retained_as_draft(self):
        self.put(attachments=['/a0/usr/uploads/a.png']);draft=self.db.edit('a','one')
        self.assertEqual(self.db.rows('a'),[]);self.assertEqual(draft['attachments'],['/a0/usr/uploads/a.png'])
        self.assertEqual(Journal(self.path).rows('a','draft')[0]['text'],'pedido')
    def test_edit_after_consumption_is_rejected(self):
        self.put();self.db.reserve('a',3)
        with self.assertRaises(Conflict):self.db.edit('a','one')
    def test_edit_again_is_idempotent(self):
        self.put();self.db.edit('a','one');self.assertEqual(self.db.edit('a','one')['id'],'one')
    def test_only_one_editing_draft_per_chat(self):
        self.put();self.put('two');self.db.edit('a','one')
        with self.assertRaises(Conflict):self.db.edit('a','two')
    def test_save_draft_cannot_steal_attachment(self):
        self.put(attachments=['/a0/usr/uploads/a.png']);self.db.edit('a','one')
        with self.assertRaises(Conflict):self.db.save_draft('a','one','edited',['/private/b.png'])
    def test_resubmit_draft_and_new_message_committed_together(self):
        self.put();self.db.edit('a','one')
        self.db.enqueue('a',{'id':'new','text':'edited','attachments':[]},'one')
        self.assertEqual(self.db.rows('a','draft'),[]);self.assertEqual(self.db.rows('a')[0]['text'],'edited')
    def test_failed_resubmission_keeps_draft(self):
        self.put();self.db.edit('a','one')
        with self.assertRaises(Conflict):self.db.enqueue('a',{'id':'new','text':'edited','attachments':[]},'wrong')
        self.assertEqual(self.db.rows('a','draft')[0]['id'],'one');self.assertEqual(self.db.rows('a'),[])
    def test_concurrent_reservations_only_one_wins(self):
        self.put();self.put('two')
        with ThreadPoolExecutor(2) as pool:
            results=list(pool.map(lambda _:Journal(self.path).reserve('a',10),range(2)))
        self.assertEqual(sum(bool(x) for x in results),1)
    def test_edit_consume_race_only_one_wins(self):
        self.put()
        def edit():
            try:return bool(Journal(self.path).edit('a','one'))
            except Conflict:return False
        with ThreadPoolExecutor(2) as pool:
            editing=pool.submit(edit);sending=pool.submit(lambda:bool(Journal(self.path).reserve('a',2)))
            self.assertEqual(int(editing.result())+int(sending.result()),1)
    def test_contexts_are_isolated(self):
        self.put();self.db.migrate('b',[])
        with self.assertRaises(Conflict):self.db.edit('b','one')
        self.db.remove('b');self.assertEqual(len(self.db.rows('a')),1)
    def test_remove_all_cannot_remove_active_or_draft(self):
        self.put();self.put('two');self.put('three');self.db.edit('a','three');self.db.reserve('a',1)
        self.db.remove('a')
        self.assertIsNotNone(self.db.active('a'));self.assertEqual(len(self.db.rows('a','draft')),1)
    def test_database_failure_not_acknowledged(self):
        with self.db.connection() as db:db.execute('DROP TABLE messages')
        with self.assertRaises(Exception):self.put()

if __name__=='__main__':unittest.main()
