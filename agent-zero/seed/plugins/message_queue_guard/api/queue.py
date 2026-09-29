from helpers.api import ApiHandler, Response
from agent import AgentContext
from helpers import persist_chat
from usr.plugins.message_queue_guard import durable
from usr.plugins.message_queue_guard.journal import Conflict
from usr.plugins.message_queue_guard.admission import LOCK

class Queue(ApiHandler):
    async def process(self,input,request):
        from api.message import Message
        from usr.plugins.message_queue_guard import runtime
        if getattr(Message,'_queue_guard_version',0)!=2:
            import importlib
            from helpers import cache,extension,plugins
            importlib.reload(runtime)
            runtime.install()
            plugins.clear_plugin_cache()
            cache.clear(extension._EXTENSIONS_CACHE_AREA)
            cache.clear(extension._CLASSES_CACHE_AREA)
        else:
            runtime.install()
        context=AgentContext.get(input.get('context',''))
        if not context: return Response('Chat não encontrado.',status=404)
        action=input.get('action','snapshot')
        try:
            with LOCK:
                durable.ensure(context)
                result={}
                item_id=input.get('item_id')
                if action=='move':
                    durable.journal().move(context.id,item_id,input.get('delta'))
                elif action=='edit':
                    result['draft']=durable.journal().edit(context.id,item_id)
                elif action=='draft':
                    drafts=durable.journal().rows(context.id,'draft')
                    result['draft']=drafts[0] if drafts else None
                elif action=='save_draft':
                    text=input.get('text')
                    if not isinstance(text,str): raise Conflict('Texto inválido.')
                    durable.journal().save_draft(context.id,item_id,text,input.get('attachments',[]))
                elif action=='remove':
                    durable.remove(context,item_id)
                elif action=='send':
                    # Explicit send also does NOT inject into an active turn.
                    task=durable.dispatch(context,item_id)
                    if not task: raise Conflict('O chat está ocupado, pausado ou tem uma execução interrompida. A fila foi preservada.')
                elif action=='resume':
                    if context.is_running(): raise Conflict('O chat ainda está executando. Não será iniciada uma segunda chamada.')
                    from agent import UserMessage
                    active=durable.journal().resume(context.id,durable.boundary(context))
                    message=('Retome a tarefa interrompida a partir do histórico e dos resultados reais já disponíveis. '
                             'Antes de executar, confira o que já foi feito; não repita comandos ou efeitos externos concluídos. '
                             'Se o estado de uma ação for incerto, verifique-o ou peça ajuda. Pedido original:\n'+active['text'])
                    try:
                        context.set_data('message_queue_active',active)
                        persist_chat.save_tmp_chat(context)
                        from helpers import message_queue as mq
                        mq.log_user_message(context,message,active['attachments'],message_id=active['id'],source=' (queue recovery)')
                        context.communicate(UserMessage(message,active['attachments'],id=active['id']))
                    except Exception:
                        durable.journal().block(context.id,active['id']); raise
                elif action!='snapshot':
                    return Response('Ação inválida.',status=400)
                result.update(durable.snapshot(context))
                if action!='snapshot' and action!='draft':
                    persist_chat.save_tmp_chat(context)
                return {'ok':True,**result}
        except Conflict as error:
            return Response(str(error),status=409)
