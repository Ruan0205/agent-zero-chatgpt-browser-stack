import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../webui/queue-store.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export {store};','');
function setup(){
  const state={selected:'a',requests:[],toasts:[],result:{items:[],active:null},focus:0};
  const inputStore={message:'',focus(){state.focus++},adjustTextareaHeight(){}};
  const attachmentsStore={attachments:[],isImageFile:n=>n.endsWith('.png'),getFilePreviewUrl:n=>'/file/'+n,
    getAttachmentDisplayInfo:n=>({filename:n}),addAttachment(a){this.attachments.push(a)},
    getAttachmentsForSending(){return this.attachments.map(a=>a.type==='image'?{...a,url:box.URL.createObjectURL(a.file)}:{...a})}};
  const box={createStore:(_n,m)=>m,inputStore,attachmentsStore,chatsStore:{getSelectedChatId:()=>state.selected},
    callJsonApi:async (_endpoint,payload)=>{state.requests.push(payload);return typeof state.result==='function'?state.result(payload):state.result},
    setTimeout,clearTimeout,setInterval:()=>1,document:{addEventListener(){}},console,
    URL:{createObjectURL:file=>{if(!file)throw new Error('missing file');return 'blob:test'}},
    toast:(...a)=>state.toasts.push(a)};
  box.globalThis=box;vm.createContext(box);vm.runInContext(source+'\nthis.store=store;',box);
  return {state,inputStore,attachmentsStore,store:box.store};
}
const draft={id:'q1',text:'texto completo',attachments:['/a0/usr/uploads/a.png','/a0/usr/uploads/a.pdf']};
test('edit transfers text and original attachment references without downloading bytes',async()=>{
  const x=setup();x.state.result={items:[],active:null,draft};await x.store.edit('q1');
  assert.equal(x.inputStore.message,draft.text);assert.equal(x.store.editingId,'q1');
  assert.deepEqual(x.attachmentsStore.attachments.map(a=>a.serverPath),draft.attachments);
  assert.equal(x.attachmentsStore.attachments[0].type,'image');assert.equal(x.attachmentsStore.attachments[1].type,'file');
});
test('restored image reference can be resent without a browser File object',()=>{
  const x=setup();x.store.supportSavedAttachments();x.store.restore(draft,'a');
  assert.deepEqual(x.attachmentsStore.getAttachmentsForSending().map(a=>a.serverPath),draft.attachments);
  x.attachmentsStore.addAttachment({name:'new.png',type:'image',file:{name:'new.png'}});
  assert.equal(x.attachmentsStore.getAttachmentsForSending()[2].url,'blob:test');
});
test('existing typed draft is not overwritten',async()=>{
  const x=setup();x.inputStore.message='user draft';await x.store.edit('q1');
  assert.equal(x.state.requests.length,0);assert.equal(x.inputStore.message,'user draft');assert.equal(x.state.toasts.length,1);
});
test('existing attachment-only draft is not overwritten',async()=>{
  const x=setup();x.attachmentsStore.attachments.push({name:'own.png'});await x.store.edit('q1');assert.equal(x.state.requests.length,0);
});
test('edit conflict preserves composer and reports error',async()=>{
  const x=setup();x.state.result=()=>{throw new Error('consumed')};await x.store.edit('q1');
  assert.equal(x.inputStore.message,'');assert.equal(x.store.editingId,null);assert.equal(x.state.toasts[0][0],'consumed');
});
test('switching chats during edit never inserts into new chat',async()=>{
  const x=setup();x.state.result=()=>{x.state.selected='b';return {draft,items:[]}};await x.store.edit('q1');assert.equal(x.inputStore.message,'');
});
test('typing while edit request runs is preserved',async()=>{
  const x=setup();x.state.result=()=>{x.inputStore.message='new typing';return {draft,items:[]}};await x.store.edit('q1');assert.equal(x.inputStore.message,'new typing');
});
test('up/down actions preserve exact selected ID and direction',async()=>{
  const x=setup();await x.store.move('q2',-1);assert.equal(x.state.requests[0].item_id,'q2');assert.equal(x.state.requests[0].delta,-1);
});
test('lost edit acknowledgement can restore saved draft on later poll',async()=>{
  const x=setup();x.store.context='a';x.state.result=p=>p.action==='draft'?{draft}:{items:[],draft_id:'q1'};
  await x.store.refresh();assert.equal(x.inputStore.message,draft.text);assert.equal(x.store.editingId,'q1');
});
test('draft restore waits if composer already contains another draft',async()=>{
  const x=setup();x.inputStore.message='keep';x.state.result={items:[],draft_id:'q1'};
  await x.store.refresh();assert.equal(x.state.requests.length,1);assert.equal(x.inputStore.message,'keep');
});
test('confirmed submission resets only its own editing context',()=>{
  const x=setup();x.store.editingId='q1';x.store.editingContext='a';x.store.refresh=()=>{};
  x.store.submitted('b');assert.equal(x.store.editingId,'q1');x.store.submitted('a');assert.equal(x.store.editingId,null);
});
test('a stale poll cannot restore an already-submitted draft',async()=>{
  const x=setup();let resolve;
  x.state.result=()=>new Promise(done=>{resolve=done});
  const polling=x.store.refresh();
  x.store.editingId='q1';x.store.editingContext='a';
  x.store.submitted('a');
  resolve({items:[],draft_id:'q1'});
  await polling;
  assert.equal(x.store.editingId,null);
  assert.equal(x.state.requests.length,1);
  assert.equal(x.inputStore.message,'');
});
test('poll failure does not remove previously confirmed waiting messages',async()=>{
  const x=setup();x.store.items=[{id:'saved'}];x.state.result=()=>{throw new Error('server down')};await x.store.refresh();assert.equal(x.store.items[0].id,'saved');
});
test('no simultaneous polling while mutating queue',async()=>{
  const x=setup();x.store._busy=true;await x.store.refresh();assert.equal(x.state.requests.length,0);
});
