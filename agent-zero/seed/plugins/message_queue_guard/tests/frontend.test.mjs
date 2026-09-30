import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../extensions/webui/send_message_before/_90_server_queue.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace('export default async function','async function');
function setup({queued=false,failed=false,gate=true}={}) {
  const state={requests:[],renders:[],resets:0,toasts:[],scrolls:0,reconciles:[]};
  const ctx={context:'chat-A',message:'next',attachments:[],cancel:false};
  const chat={id:'chat-A'};
  const box={crypto:{},Date,Math,FormData:class {append(){}},scrollOnNextProcessGroup(){state.scrolls++},durableQueue:{submitted(){},reconcileNow:c=>state.reconciles.push(c),editingId:null},inputStore:{message:'next',reset(){state.resets++;}},chatsStore:{contexts:[chat],getSelectedChatId:()=> 'chat-A'},modelGateStore:{canSendToModel:async()=>gate},setMessages:async rows=>state.renders.push(rows),fetchApi:async(path,opts)=>{state.requests.push(path);return {ok:!failed,json:async()=>queued?{queued:true,message_queue:[{id:'queue-id',text:'next'}]}:{context:'chat-A'}};},toast:(...args)=>state.toasts.push(args)};
  box.globalThis=box;vm.createContext(box);vm.runInContext(source+'\nthis.run=queueGuard;',box);
  return {state,ctx,chat,run:(next=ctx)=>box.run(next)};
}
test('busy acknowledgement displays queue, not chat bubble; HTTP works without randomUUID',async()=>{const x=setup({queued:true});await x.run();assert.equal(x.state.renders.length,0);assert.equal(x.chat.message_queue.length,1);assert.equal(x.state.resets,1);assert.equal(x.state.requests.length,2);assert.equal(x.ctx.cancel,true);});
test('idle acknowledgement draws, follows and reconciles the first process step',async()=>{const x=setup();await x.run();assert.equal(x.state.renders.length,1);assert.equal(x.chat.running,true);assert.equal(x.state.scrolls,1);assert.deepEqual(x.state.reconciles,['chat-A']);});
test('failure keeps draft and prevents original fallback resend',async()=>{const x=setup({failed:true});await x.run();assert.equal(x.state.resets,0);assert.equal(x.ctx.cancel,true);assert.equal(x.state.toasts.length,1);});
test('model setup gate retains original flow',async()=>{const x=setup({gate:false});await x.run();assert.equal(x.ctx.cancel,false);assert.equal(x.state.requests.length,0);});
test('same-chat simultaneous submissions retain request order',async()=>{const x=setup({queued:true});await Promise.all([x.run({...x.ctx,message:'first'}),x.run({...x.ctx,message:'second'})]);assert.deepEqual(x.state.requests,['/plugins/message_queue_guard/status','/message_async','/plugins/message_queue_guard/status','/message_async']);});
