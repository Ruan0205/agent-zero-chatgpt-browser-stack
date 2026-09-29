import os
import json
from uuid import uuid4
from usr.plugins.message_queue_guard.admission import admit

def install(recover=False):
    from usr.plugins.message_queue_guard import durable
    durable.install()
    if recover:
        durable.journal().recover()
    from api.message import Message
    if getattr(Message, '_queue_guard_version', 0)==2: return
    from agent import UserMessage
    from helpers import files, extension, message_queue as mq, persist_chat
    from helpers.security import safe_filename
    from helpers.state_monitor_integration import mark_dirty_for_context

    async def communicate(self, input, request):
        multipart = (request.content_type or '').startswith('multipart/form-data')
        data = request.form if multipart else (request.get_json() or {})
        text, ctxid = data.get('text', ''), data.get('context', '')
        message_id = data.get('message_id') or str(uuid4())
        context = self.use_context(ctxid)
        durable.ensure(context)
        # A retry after a lost acknowledgement does not re-upload or replay.
        if durable.journal().lookup(context.id,message_id):
            durable.sync(context)
            return None, context
        paths = []
        if multipart:
            folder = files.get_abs_path('usr/uploads')
            os.makedirs(folder, exist_ok=True)
            for attachment in request.files.getlist('attachments'):
                name = safe_filename(attachment.filename or '')
                if not name: continue
                name=str(uuid4())+'-'+name
                destination=files.get_abs_path(folder,name)
                partial=destination+'.partial'
                try:
                    attachment.save(partial)
                    with open(partial,'rb') as stream: os.fsync(stream.fileno())
                    os.replace(partial,destination)
                    directory=os.open(folder,os.O_RDONLY)
                    try: os.fsync(directory)
                    finally: os.close(directory)
                finally:
                    if os.path.exists(partial): os.unlink(partial)
                paths.append('/a0/usr/uploads/' + name)
        draft_id=data.get('draft_id') or None
        references=data.get('existing_attachments','[]')
        references=json.loads(references) if isinstance(references,str) else references
        if references:
            draft=durable.journal().lookup(context.id,draft_id) if draft_id else None
            if not draft or draft['state']!='draft' or not isinstance(references,list) or any(p not in draft.get('attachments',[]) for p in references):
                raise ValueError('Anexo existente não pertence ao rascunho deste chat.')
            paths=references+paths
        # Preserve the normal queue contract: queued input has no immediate
        # user-message side effects and cannot replace the current intervention.
        if not context.is_running() and not mq.has_queue(context):
            ext_data = {'message': text, 'attachment_paths': paths}
            await extension.call_extensions_async('user_message_ui', agent=context.get_agent(), data=ext_data)
            text, paths = ext_data.get('message', ''), ext_data.get('attachment_paths', [])
        task,_ = durable.submit(context,text,paths,message_id,draft_id)
        persist_chat.save_tmp_chat(context)
        mark_dirty_for_context(context.id,reason='durable_message_admission')
        return task, context

    async def process(self, input, request):
        task, context = await self.communicate(input=input, request=request)
        if task is None:
            return {'message':'Message queued or already accepted.', 'context':context.id,
                    'queued':True, 'message_queue':context.get_output_data('message_queue') or [],
                    'queue_length':len(mq.get_queue(context))}
        return await self.respond(task, context)

    Message.communicate = communicate
    Message.process = process
    Message._queue_guard_installed = True
    Message._queue_guard_version = 2
