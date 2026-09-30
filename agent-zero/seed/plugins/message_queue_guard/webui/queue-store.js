import { createStore } from '/js/AlpineStore.js';
import { callJsonApi } from '/js/api.js';
import { store as inputStore } from '/components/chat/input/input-store.js';
import { store as attachmentsStore } from '/components/chat/attachments/attachmentsStore.js';
import { store as chatsStore } from '/components/sidebar/chats/chats-store.js';
import { setMessages } from '/js/messages.js';

const endpoint='/plugins/message_queue_guard/queue';
const model={
  items:[], active:null, running:false, nudgeAvailable:false, context:null, editingId:null, editingContext:null,
  _timer:null, _polling:false, _reconciling:false, _lastReconcileAt:0,
  _saving:null, _busy:false, _draftVersion:0, _submissionEpoch:0,
  start() {
    if(this._timer) return;
    this.supportSavedAttachments();
    this._timer=setInterval(()=>this.refresh(),1500);
    document.addEventListener('input',event=>{
      if(event.target?.closest?.('#chat-input') && this.editingId) this.saveDraftSoon();
    });
    this.refresh();
  },
  supportSavedAttachments(){
    if(attachmentsStore._durableQueueRefs) return;
    const original=attachmentsStore.getAttachmentsForSending;
    attachmentsStore.getAttachmentsForSending=function(){
      if(!this.attachments.some(a=>a.serverPath)) return original.call(this);
      return this.attachments.map(a=>a.serverPath?{...a}:
        a.type==='image'?{...a,url:URL.createObjectURL(a.file)}:{...a});
    };
    attachmentsStore._durableQueueRefs=true;
  },
  selected(){return chatsStore.getSelectedChatId();},
  async request(action,data={},context=this.selected()){
    return callJsonApi(endpoint,{context,action,...data});
  },
  apply(result,context){
    if(this.selected()!==context) return;
    this.context=context; this.items=result.items||[]; this.active=result.active;
    this.running=!!result.running;this.nudgeAvailable=!!result.nudge_available;
    this.updateNudge();
  },
  updateNudge(){
    const button=document.querySelector?.('#nudges_window');
    if(!button) return;
    button.disabled=!this.nudgeAvailable;
    button.title=this.nudgeAvailable?'Retomar o ChatGPT Browser que parou':'Não envia mensagens. Use Intervir agora na fila; só fica disponível se o ChatGPT Browser parar.';
    const label=button.querySelector?.('p');if(label) label.textContent='Retomar navegador';
  },
  async reconcile(context,force=false){
    if(this._reconciling || this.selected()!==context || typeof globalThis.poll!=='function') return;
    const now=Date.now();
    if(!force && now-this._lastReconcileAt<2500) return;
    this._lastReconcileAt=now;this._reconciling=true;
    try{await globalThis.poll();}
    catch(error){console.warn('Reconciliação visual temporariamente indisponível.');}
    finally{this._reconciling=false;}
  },
  reconcileNow(context){
    this._lastReconcileAt=0;
    setTimeout(()=>this.reconcile(context,true),150);
  },
  async refresh(){
    if(this._polling || this._busy) return;
    const context=this.selected();
    const epoch=this._submissionEpoch;
    if(!context){this.items=[];this.active=null;this.running=false;this.nudgeAvailable=false;this.updateNudge();return;}
    this._polling=true;
    try{
      const changed=this.context!==context;
      const result=await this.request('snapshot',{},context);
      if(epoch!==this._submissionEpoch) return;
      this.apply(result,context);
      if(this.selected()===context && Array.isArray(result.logs) && result.logs.length) await setMessages(result.logs);
      if(result.running || result.active) void this.reconcile(context);
      if(changed && this.selected()===context){
        this.editingId=null;this.editingContext=null;
      }
      if(this.selected()===context && result.draft_id && this.editingId!==result.draft_id && !inputStore.message && !attachmentsStore.attachments.length){
        const restored=await this.request('draft',{},context);
        if(epoch===this._submissionEpoch && this.selected()===context && !inputStore.message && !attachmentsStore.attachments.length) this.restore(restored.draft,context);
      }
    }catch(error){console.warn('Fila indisponível; o servidor mantém as mensagens pendentes.');}
    finally{this._polling=false;}
  },
  restore(draft,context){
    if(!draft || this.selected()!==context) return;
    this.editingId=draft.id; this.editingContext=context;
    inputStore.message=draft.text;
    for(const path of draft.attachments||[]){
      const name=path.split('/').pop();
      const image=attachmentsStore.isImageFile(name);
      attachmentsStore.addAttachment({name,type:image?'image':'file',extension:name.split('.').pop(),
        serverPath:path,url:image?`/api/image_get?path=${encodeURIComponent(path)}`:attachmentsStore.getFilePreviewUrl(name),
        displayInfo:attachmentsStore.getAttachmentDisplayInfo(name)});
    }
    inputStore.focus(); inputStore.adjustTextareaHeight();
  },
  async action(action,data={}){
    if(this._busy) return;
    const context=this.selected();
    this._busy=true;
    try{const result=await this.request(action,data,context);this.apply(result,context);return result;}
    catch(error){globalThis.toast?.(error.message,'error');}
    finally{this._busy=false;}
  },
  async edit(itemId){
    // Never destroy a draft the user was already composing.
    if(inputStore.message || attachmentsStore.attachments.length){
      globalThis.toast?.('Envie ou guarde o rascunho atual antes de editar uma mensagem da fila.','warning');return;
    }
    const context=this.selected();
    const result=await this.action('edit',{item_id:itemId});
    if(result && this.selected()===context && !inputStore.message && !attachmentsStore.attachments.length) this.restore(result.draft,context);
  },
  async move(itemId,delta){return this.action('move',{item_id:itemId,delta});},
  async remove(itemId){return this.action('remove',{item_id:itemId});},
  async send(itemId){return this.action('send',{item_id:itemId});},
  // An inflight durable reservation is the stable authority for the button.
  // `running` is intentionally not used here: it can briefly lag during model
  // transitions, which previously disabled intervention exactly when needed.
  canIntervene(){return this.active?.state==='inflight';},
  async intervene(itemId){
    const context=this.selected();
    const result=await this.action('intervene',{item_id:itemId});
    if(result){this.reconcileNow(context);globalThis.forceScrollChatToBottom?.();}
    return result;
  },
  async resume(){return this.action('resume');},
  saveDraftSoon(){
    const context=this.editingContext,id=this.editingId,version=++this._draftVersion;
    if(!id || context!==this.selected()) return;
    clearTimeout(this._saving);
    this._saving=setTimeout(async()=>{
      if(context!==this.selected() || id!==this.editingId || version!==this._draftVersion) return;
      try{await this.request('save_draft',{item_id:id,text:inputStore.message,
        attachments:attachmentsStore.attachments.filter(a=>a.serverPath).map(a=>a.serverPath)},context);}
      catch(error){globalThis.toast?.('Não foi possível salvar a última edição; o rascunho anterior continua preservado.','warning');}
    },500);
  },
  submitted(context){
    this._submissionEpoch++;
    if(context===this.editingContext){this.editingId=null;this.editingContext=null;clearTimeout(this._saving);this._draftVersion++;}
    this.refresh();
  },
  restoreAvailableDraft(){this.refresh();},
};
const store=createStore('durableQueue',model);
export {store};
