"""Framework integration for the journal, with chat.data as a UI projection only."""
import os
import uuid
import threading
import time
from usr.plugins.message_queue_guard.admission import LOCK
from usr.plugins.message_queue_guard.journal import Journal, Conflict

_journal = None
_recovery_thread = None


def browser_nudge_available(context):
    """Nudge is only meaningful for an idle ChatGPT Browser conversation."""
    override=context.get_data('chat_model_override') or {}
    chat=override.get('chat',{}) if isinstance(override,dict) else {}
    name=str(chat.get('name','')) if isinstance(chat,dict) else ''
    if not name:
        try:
            from plugins._model_config.helpers.model_config import get_chat_model_config
            name=str((get_chat_model_config(context.agent0) or {}).get('name',''))
        except Exception:
            name=''
    return name.startswith('chatgpt-browser') and not bool(context.is_running())


def journal():
    global _journal
    if _journal is None:
        from helpers import files
        _journal = Journal(files.get_abs_path('usr/message-queue/queue.sqlite3'))
    return _journal


def ensure(context):
    journal().migrate(context.id, context.get_data('message_queue') or [])
    observed={getattr(item,'id',None) for item in getattr(context.log,'logs',[]) if getattr(item,'id',None)}
    journal().reconcile_interventions(context.id,observed)


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


def intervene(context,item_id):
    """Move one pending message into the active turn without starting a competing run."""
    from agent import UserMessage
    from helpers import message_queue as mq, persist_chat
    from helpers.state_monitor_integration import mark_dirty_for_context
    with LOCK:
        ensure(context)
        if not context.is_running():
            raise Conflict('O chat não está mais executando. Envie a mensagem normalmente pela fila.')
        agent=context.get_agent()
        if getattr(agent,'intervention',None):
            raise Conflict('Já existe uma intervenção aguardando consumo pelo agente. Tente novamente depois que ela aparecer no histórico.')
        item,active_id=journal().begin_intervention(context.id,item_id)
        try:
            context.communicate(UserMessage(message=item['text'],attachments=item['attachments'],id=item['id']))
            # Commit the delivery receipt before ancillary UI/history work. Once
            # communicate() accepted the intervention, no later failure may put
            # it back in pending state and replay it to the model.
            journal().complete_intervention(context.id,item['id'],active_id)
            mq.log_user_message(context,item['text'],item['attachments'],item['id'],source=' (intervenção da fila)')
            sync(context)
            persist_chat.save_tmp_chat(context)
            mark_dirty_for_context(context.id,reason='message_queue_intervention')
            return item
        except Exception:
            # Only a message still in the uncertain pre-receipt state is safe to
            # return to the queue. A completed receipt proves it was accepted.
            if journal().lookup(context.id,item['id'])['state']=='intervening':
                journal().cancel_intervention(context.id,item['id'])
            sync(context)
            raise


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
        # The last real user input must belong to this reservation or to an
        # explicit queue intervention attached to it. Unrelated API messages
        # still cannot acknowledge the active item by mistake.
        final=False;last_user_id=None
        accepted_ids={active['id'],*(active.get('intervention_ids') or [])}
        for log in getattr(context.log,'logs',[]):
            if getattr(log,'no',-1)<=active['boundary']:continue
            if getattr(log,'type','')=='user':last_user_id=getattr(log,'id',None)
            if (getattr(log,'type','')=='response' and (getattr(log,'kvps',None) or {}).get('finished') is True
                and getattr(log,'agentno',0)==0 and last_user_id in accepted_ids):
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
        # The websocket cursor can advance even if the browser fails to render a
        # particular batch. Return a bounded authoritative tail so the queue's
        # independent heartbeat can repair the visible history without F5.
        raw_logs=list(getattr(context.log,'logs',[]) or [])[-160:]
        recent_logs=[item.output() for item in raw_logs if hasattr(item,'output')]
        return {'items':context.get_output_data('message_queue'),
                'active':{'id':active['id'],'state':active['state']} if active else None,
                'draft_id':drafts[0]['id'] if drafts else None,'running':bool(context.is_running()),
                'logs':recent_logs,'nudge_available':browser_nudge_available(context)}


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
