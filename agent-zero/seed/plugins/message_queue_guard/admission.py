"""Serialize admission; never treat an ordinary busy-chat send as intervention."""
import threading

LOCK = threading.RLock()

def admit(context, text, attachments, message_id, mq, communicate, log, persist, dirty):
    with LOCK:
        receipts = dict(context.get_data('ui_message_receipts') or {})
        if message_id and message_id in receipts:
            return None, True  # Already accepted: do not replay a completed send.
        queued = context.is_running() or mq.has_queue(context)
        if queued:
            mq.add(context, text, attachments, message_id)
            task = None
        else:
            log(context, text, attachments, message_id)
            task = communicate(text, attachments, message_id)
        if message_id:
            receipts[message_id] = 'queued' if queued else 'started'
            context.set_data('ui_message_receipts', dict(list(receipts.items())[-128:]))
        persist(context)
        dirty(context.id, reason='ui_message_queued' if queued else 'ui_message_started')
        return task, queued
