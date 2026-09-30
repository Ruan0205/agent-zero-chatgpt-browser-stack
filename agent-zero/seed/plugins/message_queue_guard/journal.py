"""Durable queue journal. Commit before acknowledgement; reserve, then acknowledge.

No time-based message expiry and no automatic replay of uncertain executions.
SQLite transactions also protect mutations made from different request threads.
"""
import json
import os
from pathlib import Path
import sqlite3
import time
from contextlib import contextmanager


class Conflict(ValueError):
    pass


class Journal:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connection() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS contexts (context TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS deleted_contexts (
                    context TEXT PRIMARY KEY, deleted REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS messages (
                    context TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL,
                    state TEXT NOT NULL, payload TEXT NOT NULL, boundary INTEGER NOT NULL DEFAULT -1,
                    updated REAL NOT NULL, PRIMARY KEY(context,id));
                CREATE INDEX IF NOT EXISTS queue_order ON messages(context,state,position);
                CREATE UNIQUE INDEX IF NOT EXISTS one_active ON messages(context)
                    WHERE state IN ('inflight','blocked');
                CREATE UNIQUE INDEX IF NOT EXISTS one_draft ON messages(context) WHERE state='draft';
            ''')
        os.chmod(self.path, 0o600)
        directory=os.open(self.path.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA busy_timeout=15000')
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            with db:
                yield db

    @staticmethod
    def item(row):
        if row is None:
            return None
        return {**json.loads(row['payload']), 'id': row['id'], 'seq': row['position'],
                'state': row['state'], 'boundary': row['boundary']}

    def migrate(self, context, items):
        with self.transaction() as db:
            if db.execute('SELECT 1 FROM deleted_contexts WHERE context=?',(context,)).fetchone():
                return
            if db.execute('SELECT 1 FROM contexts WHERE context=?', (context,)).fetchone():
                return
            for position, item in enumerate(items):
                db.execute('INSERT OR IGNORE INTO messages(context,id,position,state,payload,updated) VALUES(?,?,?,?,?,?)',
                           (context, item['id'], position, 'pending', json.dumps(item), time.time()))
            db.execute('INSERT INTO contexts VALUES(?)', (context,))

    def enqueue(self, context, item, draft_id=None):
        with self.transaction() as db:
            old = db.execute('SELECT * FROM messages WHERE context=? AND id=?', (context, item['id'])).fetchone()
            if old:
                payload = json.loads(old['payload'])
                if old['state'] in ('pending','draft','inflight','blocked') and (payload.get('text') != item.get('text') or payload.get('attachments', []) != item.get('attachments', [])):
                    raise Conflict('Este ID já pertence a outra mensagem. Atualize a página antes de reenviar.')
                return self.item(old), False
            if draft_id:
                draft = db.execute("SELECT id FROM messages WHERE context=? AND id=? AND state='draft'", (context, draft_id)).fetchone()
                if not draft:
                    raise Conflict('O rascunho editado já foi enviado ou alterado em outra aba.')
                db.execute("UPDATE messages SET state='edited',payload='{}',updated=? WHERE context=? AND id=?", (time.time(),context,draft_id))
            position = db.execute('SELECT COALESCE(MAX(position),0)+1 FROM messages WHERE context=?', (context,)).fetchone()[0]
            db.execute('INSERT INTO messages(context,id,position,state,payload,updated) VALUES(?,?,?,?,?,?)',
                       (context,item['id'],position,'pending',json.dumps(item),time.time()))
        return {**item, 'seq': position, 'state':'pending'}, True

    def rows(self, context, state='pending'):
        with self.connection() as db:
            return [self.item(row) for row in db.execute('SELECT * FROM messages WHERE context=? AND state=? ORDER BY position', (context,state))]

    def active(self, context):
        with self.connection() as db:
            return self.item(db.execute("SELECT * FROM messages WHERE context=? AND state IN ('inflight','blocked')", (context,)).fetchone())

    def lookup(self, context, item_id):
        with self.connection() as db:
            return self.item(db.execute('SELECT * FROM messages WHERE context=? AND id=?',(context,item_id)).fetchone())

    def purge_context(self, context):
        """Remove queue state only after its owning chat was explicitly deleted."""
        with self.transaction() as db:
            db.execute('DELETE FROM messages WHERE context=?',(context,))
            db.execute('DELETE FROM contexts WHERE context=?',(context,))
            db.execute('INSERT OR REPLACE INTO deleted_contexts(context,deleted) VALUES(?,?)',(context,time.time()))

    def begin_intervention(self, context, item_id):
        with self.transaction() as db:
            active=db.execute("SELECT * FROM messages WHERE context=? AND state='inflight'",(context,)).fetchone()
            if not active:
                raise Conflict('Não há uma execução ativa que possa receber a intervenção.')
            row=db.execute("SELECT * FROM messages WHERE context=? AND id=? AND state='pending'",(context,item_id)).fetchone()
            if not row:
                raise Conflict('A mensagem já saiu da espera e não pode ser usada como intervenção.')
            db.execute("UPDATE messages SET state='intervening',updated=? WHERE context=? AND id=?",(time.time(),context,item_id))
            return self.item(row),active['id']

    def complete_intervention(self, context, item_id, active_id):
        with self.transaction() as db:
            row=db.execute("SELECT id FROM messages WHERE context=? AND id=? AND state='intervening'",(context,item_id)).fetchone()
            active=db.execute("SELECT * FROM messages WHERE context=? AND id=? AND state IN ('inflight','blocked')",(context,active_id)).fetchone()
            if not row or not active:
                raise Conflict('A execução mudou antes de confirmar a intervenção.')
            payload=json.loads(active['payload'])
            payload['intervention_ids']=list(dict.fromkeys([*(payload.get('intervention_ids') or []),item_id]))
            db.execute('UPDATE messages SET payload=?,updated=? WHERE context=? AND id=?',(json.dumps(payload),time.time(),context,active_id))
            db.execute("UPDATE messages SET state='completed',payload='{}',updated=? WHERE context=? AND id=?",(time.time(),context,item_id))

    def cancel_intervention(self, context, item_id):
        with self.transaction() as db:
            db.execute("UPDATE messages SET state='pending',updated=? WHERE context=? AND id=? AND state='intervening'",(time.time(),context,item_id))

    def settle_observed_intervention(self, context, item_id):
        with self.transaction() as db:
            db.execute("UPDATE messages SET state='completed',payload='{}',updated=? WHERE context=? AND id=? AND state='intervening'",(time.time(),context,item_id))

    def reconcile_interventions(self, context, observed_ids):
        with self.connection() as db:
            rows=list(db.execute("SELECT id FROM messages WHERE context=? AND state='intervening'",(context,)))
        for row in rows:
            item_id=row['id']
            active=self.active(context)
            if item_id in observed_ids and active:
                self.complete_intervention(context,item_id,active['id'])
            elif item_id in observed_ids:
                # The original turn may already have completed between the log
                # write and a process crash. The observed user log is proof that
                # replaying this intervention would duplicate it.
                self.settle_observed_intervention(context,item_id)
            else:
                self.cancel_intervention(context,item_id)

    def reserve(self, context, boundary, item_id=None):
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM messages WHERE context=? AND state IN ('inflight','blocked')",(context,)).fetchone():
                return None
            query = "SELECT * FROM messages WHERE context=? AND state='pending'"
            params = [context]
            if item_id:
                query += ' AND id=?'; params.append(item_id)
            row = db.execute(query+' ORDER BY position LIMIT 1', params).fetchone()
            if row is None:
                return None
            db.execute("UPDATE messages SET state='inflight',boundary=?,updated=? WHERE context=? AND id=?",(boundary,time.time(),context,row['id']))
            return {**self.item(row),'state':'inflight','boundary':boundary}

    def block(self, context, item_id):
        with self.transaction() as db:
            db.execute("UPDATE messages SET state='blocked',updated=? WHERE context=? AND id=? AND state='inflight'",(time.time(),context,item_id))

    def acknowledge(self, context, item_id):
        with self.transaction() as db:
            count=db.execute("UPDATE messages SET state='completed',payload='{}',updated=? WHERE context=? AND id=? AND state IN ('inflight','blocked')",(time.time(),context,item_id)).rowcount
        return bool(count)

    def resume(self,context,boundary):
        with self.transaction() as db:
            row=db.execute("SELECT * FROM messages WHERE context=? AND state='blocked'",(context,)).fetchone()
            if not row: raise Conflict('Não há execução interrompida para retomar.')
            db.execute("UPDATE messages SET state='inflight',boundary=?,updated=? WHERE context=? AND id=?",(boundary,time.time(),context,row['id']))
            return {**self.item(row),'state':'inflight','boundary':boundary}

    def move(self, context, item_id, delta):
        if delta not in (-1,1):
            raise Conflict('Direção inválida.')
        with self.transaction() as db:
            rows=list(db.execute("SELECT id FROM messages WHERE context=? AND state='pending' ORDER BY position",(context,)))
            ids=[row['id'] for row in rows]
            if item_id not in ids:
                raise Conflict('A mensagem já saiu da espera; não pode mais ser reordenada.')
            index=ids.index(item_id); target=index+delta
            if 0 <= target < len(ids):
                ids[index],ids[target]=ids[target],ids[index]
                for position,id in enumerate(ids):
                    db.execute('UPDATE messages SET position=? WHERE context=? AND id=?',(position,context,id))

    def edit(self, context, item_id):
        with self.transaction() as db:
            draft=db.execute("SELECT * FROM messages WHERE context=? AND state='draft'",(context,)).fetchone()
            if draft:
                if draft['id']==item_id:
                    return self.item(draft)
                raise Conflict('Já existe uma mensagem em edição neste chat. Envie-a antes de editar outra.')
            row=db.execute("SELECT * FROM messages WHERE context=? AND id=? AND state='pending'",(context,item_id)).fetchone()
            if not row:
                raise Conflict('A mensagem já foi consumida; a edição não é mais permitida.')
            db.execute("UPDATE messages SET state='draft',updated=? WHERE context=? AND id=?",(time.time(),context,item_id))
            return {**self.item(row),'state':'draft'}

    def save_draft(self, context, item_id, text, attachments):
        with self.transaction() as db:
            row=db.execute("SELECT * FROM messages WHERE context=? AND id=? AND state='draft'",(context,item_id)).fetchone()
            if not row:
                raise Conflict('Rascunho não disponível.')
            payload=json.loads(row['payload'])
            # Only retain original attachment references. New uploads are submitted normally.
            if not isinstance(attachments,list) or any(p not in payload.get('attachments',[]) for p in attachments):
                raise Conflict('Anexo não pertence ao rascunho deste chat.')
            payload.update(text=text,attachments=attachments)
            db.execute('UPDATE messages SET payload=?,updated=? WHERE context=? AND id=?',(json.dumps(payload),time.time(),context,item_id))

    def remove(self, context, item_id=None):
        with self.transaction() as db:
            query="UPDATE messages SET state='removed',payload='{}',updated=? WHERE context=? AND state='pending'"
            params=[time.time(),context]
            if item_id:
                query+=' AND id=?'; params.append(item_id)
            db.execute(query,params)

    def recover(self):
        # An unacknowledged execution may have external side effects. Never replay it automatically.
        with self.transaction() as db:
            db.execute("UPDATE messages SET state='blocked',updated=? WHERE state='inflight'",(time.time(),))
