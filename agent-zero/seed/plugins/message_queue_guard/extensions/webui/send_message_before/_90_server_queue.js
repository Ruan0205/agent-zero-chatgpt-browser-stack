import { store as inputStore } from '/components/chat/input/input-store.js';
import { store as chatsStore } from '/components/sidebar/chats/chats-store.js';
import { store as modelGateStore } from '/components/chat/model-gate-store.js';
import { fetchApi } from '/js/api.js';
import { setMessages } from '/js/messages.js';
import { store as durableQueue } from '/plugins/message_queue_guard/webui/queue-store.js';

const submissions = new Map();
const receipts = new Map();

export default async function queueGuard(ctx) {
  if (!ctx.context || (!ctx.message && !ctx.attachments?.length) || ctx.cancel) return;
  if(durableQueue._busy){ctx.cancel=true;globalThis.toast?.('Aguarde a alteração da fila terminar antes de enviar.','warning');return;}
  if (!(await modelGateStore.canSendToModel())) return; // Keep original model setup gate.
  const draft = inputStore.message;
  ctx.cancel = true; // This extension owns exactly one confirmed submission.
  const previous = submissions.get(ctx.context) || Promise.resolve();
  const operation = previous.catch(()=>{}).then(()=>submit(ctx,draft));
  submissions.set(ctx.context,operation);
  try { await operation; }
  finally { if (submissions.get(ctx.context) === operation) submissions.delete(ctx.context); }
}

async function submit(ctx,draft) {
  try {
    const enabled = await fetchApi('/plugins/message_queue_guard/status', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({context:ctx.context}),
    });
    if (!enabled.ok) throw new Error('Não foi possível confirmar o estado da fila. A mensagem não foi enviada.');
    const signature=JSON.stringify([ctx.message,(ctx.attachments||[]).map(a=>[a.serverPath||a.name||a.file?.name,a.file?.size])]);
    let saved=receipts.get(ctx.context);
    if(!saved || saved.signature!==signature){saved={signature,id:globalThis.crypto?.randomUUID?.() || `queue-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`};receipts.set(ctx.context,saved);}
    const id=saved.id;
    const form = new FormData();
    form.append('text',ctx.message); form.append('context',ctx.context); form.append('message_id',id);
    const existing=(ctx.attachments||[]).filter(a=>a.serverPath).map(a=>a.serverPath);
    if(durableQueue.editingContext===ctx.context && durableQueue.editingId) form.append('draft_id',durableQueue.editingId);
    if(existing.length) form.append('existing_attachments',JSON.stringify(existing));
    for (const attachment of ctx.attachments || []) if(!attachment.serverPath) form.append('attachments',attachment.file || attachment);
    const response = await fetchApi('/message_async', {method:'POST',body:form});
    if (!response.ok) throw new Error('Falha ao enviar. Seu rascunho foi preservado.');
    const result = await response.json();
    receipts.delete(ctx.context);
    const context = chatsStore.contexts.find(c=>c.id===ctx.context);
    if (result.queued) {
      if (context) context.message_queue = result.message_queue || [];
    } else if (chatsStore.getSelectedChatId() === ctx.context) {
      await setMessages([{id,type:'user',heading:'',content:ctx.message,kvps:{}}]);
      if (context) context.running = true;
    }
    if (chatsStore.getSelectedChatId() === ctx.context && (inputStore.message === draft || inputStore.message === ctx.message)) inputStore.reset();
    durableQueue.submitted(ctx.context);
  } catch (error) {
    globalThis.toast?.(error.message,'error');
  }
}
