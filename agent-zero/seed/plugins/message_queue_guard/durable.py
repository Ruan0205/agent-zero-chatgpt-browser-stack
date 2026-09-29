"""Framework integration for the journal, with chat.data as a UI projection only."""
import os
import uuid
import threading
import time
from usr.plugins.message_queue_guard.admission import LOCK
from usr.plugins.message_queue_guard.journal import Journal, Conflict

_journal = None
_recovery_thread = None


def journal():
    global _journal
    if _journal is None:
        from helpers import files
        _journal = Journal(files.get_abs_path('usr/message-queue/queue.sqlite3'))
    return _journal


def ensure(context):
    journal().migrate(context.id, context.get_data('message_queue') or [])


def sync(context):
    pending = journal().rows(context.id)
    context.set_data('message_queue', pending)
    context.set_output_data('message_queue', [{
        'id':item['id'],'seq':item['seq'],'text':item.get('text','')[:100],
        'attachments':[os.path.basename(p) for p in item.get('attachments',[])],
        'attachment_count':len(item.get('attachments',[])),
    } for item in pending])
    return pending


def get_queue(context):
    with LOCK:
        ensure(context)
        return sync(context)


def paths(attachments):
    return [p if p.startswith('/') else '/a0/usr/uploads/'+p for p in (attachments or [])]


def add(context, text, attachments=None, item_id=None):
    with LOCK:
        ensure(context)
        item,_ = journal().enqueue(context.id,{'id':item_id or str(uuid.uuid4()),'text':text,'attachments':paths(attachments)})
        sync(context)
        return item


def boundary(context):
    return max((getattr(log,'no',-1) for log in getattr(context.log,'logs',[])), default=-1)


def dispatch(context, item_id=None):
    from agent import UserMessage
    from helpers import message_queue as mq, persist_chat
    from helpers.state_monitor_integration import mark_dirty_for_context
    with LOCK:
        ensure(context)
        # A queue send is never an intervention and cannot overtake an active turn.
        if context.is_running() or getattr(context,'paused',False):
            return None
        item = journal().reserve(context.id, boundary(context), item_id)
        if not item:
            return None
        sync(context)
        try:
            # Save the queued payload into chat state BEFORE launching the worker.
            context.set_data('message_queue_active',item)
            persist_chat.save_tmp_chat(context)
            mq.log_user_message(context,item['text'],item['attachments'],item['id'],source=' (from durable queue)')
            task=context.communicate(UserMessage(message=item['text'],attachments=item['attachments'],id=item['id']))
        except Exception:
            journal().block(context.id,item['id'])
            raise
        mark_dirty_for_context(context.id,reason='message_queue_dispatch')
        return task


def submit(context,text,attachments,message_id,draft_id=None):
    with LOCK:
        ensure(context)
        item,created=journal().enqueue(context.id,{'id':message_id,'text':text,'attachments':paths(attachments)},draft_id)
        sync(context)
        if not created:
            return None, True
        # Only the head can be sent. New messages never overtake existing work.
        task=dispatch(context) if not context.is_running() else None
        active=journal().active(context.id)
        starts_new=bool(task and active and active['id']==message_id)
        return (task if starts_new else None), not starts_new


def remove(context,item_id=None):
    with LOCK:
        ensure(context); journal().remove(context.id,item_id)
        return len(sync(context))


def pop(context,item_id=None):
    # Compatibility: legacy API reserves rather than deletes before send_message.
    with LOCK:
        ensure(context)
        if context.is_running() or getattr(context,'paused',False):
            return None
        item=journal().reserve(context.id,boundary(context),item_id)
        sync(context)
        return item


def send_message(context,item,source=' (from queue)'):
    # Legacy send endpoint used pop_* first. Put a reserved item through the same
    # guarded dispatch semantics without deleting it on exceptions.
    from agent import UserMessage
    from helpers import message_queue as mq, persist_chat
    with LOCK:
        active=journal().active(context.id)
        if not active or active['id'] != item['id'] or active['state']!='inflight':
            raise Conflict('A mensagem não possui uma reserva válida.')
        if context.is_running():
            journal().block(context.id,item['id'])
            raise Conflict('O chat iniciou outra execução. A mensagem foi preservada.')
        try:
            context.set_data('message_queue_active',active)
            persist_chat.save_tmp_chat(context)
            mq.log_user_message(context,item['text'],item['attachments'],item['id'],source=source)
            context.communicate(UserMessage(message=item['text'],attachments=item['attachments'],id=item['id']))
        except Exception:
            journal().block(context.id,item['id']); raise


def finish(context):
    """Acknowledge only a real final response after this message's boundary."""
    from helpers import persist_chat
    with LOCK:
        ensure(context)
        active=journal().active(context.id)
        if not active:
            return False
        # The last real user input before a final answer must belong to this
        # reservation. A direct API intervention cannot acknowledge it by mistake.
        final=False;last_user_id=None
        for log in getattr(context.log,'logs',[]):
            if getattr(log,'no',-1)<=active['boundary']:continue
            if getattr(log,'type','')=='user':last_user_id=getattr(log,'id',None)
            if (getattr(log,'type','')=='response' and (getattr(log,'kvps',None) or {}).get('finished') is True
                and getattr(log,'agentno',0)==0 and last_user_id==active['id']):
                final=True
        if not final:
            return False
        # Save final history first. A crash before journal ack can be reconciled
        # from this persisted response without executing the message again.
        persist_chat.save_tmp_chat(context)
        journal().acknowledge(context.id,active['id'])
        context.set_data('message_queue_active',None)
        sync(context)
        return True


def snapshot(context):
    with LOCK:
        ensure(context)
        if not context.is_running():
            finish(context)
            active=journal().active(context.id)
            if active and active['state']=='inflight':
                journal().block(context.id,active['id'])
        pending=sync(context); active=journal().active(context.id); drafts=journal().rows(context.id,'draft')
        return {'items':context.get_output_data('message_queue'),
                'active':{'id':active['id'],'state':active['state']} if active else None,
                'draft_id':drafts[0]['id'] if drafts else None,'running':bool(context.is_running())}


def install():
    from helpers import message_queue as mq
    if getattr(mq,'_durable_installed',False):
        return
    mq.add=add; mq.get_queue=get_queue; mq.has_queue=lambda context:bool(get_queue(context))
    mq.remove=remove; mq.pop_first=lambda context:pop(context)
    mq.pop_item=lambda context,item_id:pop(context,item_id)
    mq.send_message=send_message; mq.send_next=lambda context:bool(dispatch(context))
    # "Send all" now preserves distinct messages/order instead of discarding
    # the batch before communication. It starts the head and drains after finals.
    mq.send_all_aggregated=lambda context:1 if dispatch(context) else 0
    mq._durable_installed=True


def start_recovery_worker():
    """After startup, dispatch only confirmed waiting heads, never uncertain work."""
    global _recovery_thread
    if _recovery_thread and _recovery_thread.is_alive():
        return
    def run():
        from agent import AgentContext
        while True:
            time.sleep(5)
            for context in AgentContext.all():
                try:
                    with LOCK:
                        ensure(context)
                        if not context.is_running():
                            finish(context)
                            active=journal().active(context.id)
                            if active and active['state']=='inflight':
                                journal().block(context.id,active['id'])
                            elif not active and journal().rows(context.id):
                                dispatch(context)
                except Exception:
                    # Fail closed: the journal retains the item. A later scan
                    # can retry a pending head, but never replays blocked work.
                    continue
    _recovery_thread=threading.Thread(target=run,name='durable-queue-recovery',daemon=True)
    _recovery_thread.start()
