const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildPrompt,validateAnswer,isAgentTurn,browserActionContext,operationalActionContext,extractedUserText,isCurrentUserMessage}=require('./bridge-core');
const system={role:'system',content:'# Agent Zero System Manual\n## available tools\n### code_execution_tool\nFULL TOOL DOCS'};
const body=messages=>({messages:[system,...messages]});
test('large tool output is bounded without discarding real task or tool schema',()=>{
 const p=buildPrompt(body([{role:'user',content:'{"user_message":"investigate malware, not inventory"}'},{role:'assistant',content:'{"tool_name":"code_execution_tool"}'},{role:'user',content:'{"tool_result":"'+ 'X'.repeat(35000)+'"}'}]));
 assert.ok(p.includes('investigate malware, not inventory'));assert.ok(p.includes('FULL TOOL DOCS'));assert.ok(p.includes('tool_result compacted by transport'));assert.ok(p.length<64000);
});
test('old inventory is context only, latest request survives',()=>{
 const p=buildPrompt(body([{role:'user',content:'=== RESUMO DO HOST === old inventory'},{role:'user',content:'{"user_message":"explain rainbows"}'}]));assert.ok(p.includes('explain rainbows'));assert.ok(p.includes('old inventory'));
});
test('oversize actual user request rejects instead of silently slicing it',()=>assert.throws(()=>buildPrompt(body([{role:'user',content:'X'.repeat(200000)}])),/actual user request was preserved/));
test('utility format left unchanged',()=>{const b={messages:[{role:'system',content:'extract memories as JSON array'}]};assert.equal(isAgentTurn(b),false);assert.equal(validateAnswer('[]',b),'[]');});
test('valid response preserved',()=>{let s=JSON.stringify({thoughts:[],headline:'result',tool_name:'response',tool_args:{text:'## Answer\n\nCoherent text.'}});assert.equal(validateAnswer(s,body([])),s);});
test('malformed, partial, nested, leaked fields fail closed',()=>{
 for(const s of ['plain text','{"tool_name":','{"thoughts":[],"headline":"x","tool_name":"response","tool_args":{"text":"{\\"partial\\":1}","other":"lost"}}'])assert.throws(()=>validateAnswer(s,body([])));
});
test('terminal command passes unchanged, not replaced by inventory',()=>{const s=JSON.stringify({thoughts:[],headline:'read',tool_name:'code_execution_tool',tool_args:{runtime:'terminal',code:'hostname',session:0}});assert.equal(validateAnswer(s,body([])),s);});
test('terminal command alias is normalized to code',()=>{
 const parsed=JSON.parse(validateAnswer(JSON.stringify({thoughts:[],headline:'x',tool_name:'code_execution_tool',tool_args:{runtime:'terminal',command:'hostname'}}),body([])));
 assert.equal(parsed.tool_args.code,'hostname');
 assert.equal('command' in parsed.tool_args,false);
});
test('fenced JSON preserves terminal quotes and backslashes',()=>{
 const code='printf "%s\\n" "teste com aspas"';
 const raw=JSON.stringify({thoughts:[],headline:'x',tool_name:'code_execution_tool',tool_args:{runtime:'terminal',code}});
 assert.equal(JSON.parse(validateAnswer('```json\n'+raw+'\n```',body([]))).tool_args.code,code);
 assert.ok(buildPrompt(body([])).includes('ONE fenced json code block'));
});
test('image inputs cannot be silently omitted',()=>assert.throws(()=>buildPrompt(body([{role:'user',content:[{type:'image_url',image_url:{url:'x'}}]}])),/image inputs/));

test('explicit browser action gets compact mandatory schema reminder',()=>{
 const b=body([{role:'user',content:'{"user_message":"abra um blog no navegador do Agent Zero"}'}]);
 assert.equal(browserActionContext(b).requested,true);
 const p=buildPrompt(b);
 assert.ok(p.includes('BROWSER ACTION REQUIRED FOR THIS TURN'));
 assert.ok(p.includes('"skill_name":"browser-automation"'));
 assert.ok(p.includes('"action":"open"'));
});

test('short continuation inherits browser action from previous user request',()=>{
 const b=body([{role:'user',content:'{"user_message":"abra um blog no navegador do Agent Zero"}'},{role:'assistant',content:'old refusal'},{role:'user',content:'{"user_message":"faça agora"}'}]);
 assert.equal(browserActionContext(b).requested,true);
});

test('browser action cannot finish before browser tool attempt',()=>{
 const b=body([{role:'user',content:'{"user_message":"abra um blog no navegador do Agent Zero"}'}]);
 const s=JSON.stringify({thoughts:[],headline:'x',tool_name:'response',tool_args:{text:'A ferramenta não está disponível.'}});
 assert.throws(()=>validateAnswer(s,b),/Browser action requested/);
});

test('browser action may finish after real browser attempt appears',()=>{
 const b=body([{role:'user',content:'{"user_message":"abra um blog no navegador do Agent Zero"}'},{role:'assistant',content:'{"tool_name":"browser","tool_args":{"action":"open","url":"https://example.com"}}'},{role:'user',content:'browser tool result: opened'}]);
 const s=JSON.stringify({thoughts:[],headline:'ok',tool_name:'response',tool_args:{text:'A página foi aberta.'}});
 assert.doesNotThrow(()=>validateAnswer(s,b));
});

test('operational server change cannot finish without a tool',()=>{
 const b=body([{role:'user',content:'{"user_message":"corrija a configuração do servidor"}'}]);
 assert.equal(operationalActionContext(b).requested,true);
 const s=JSON.stringify({thoughts:[],headline:'done',tool_name:'response',tool_args:{text:'Corrigido.'}});
 assert.throws(()=>validateAnswer(s,b),/Operational task requested/);
 assert.ok(buildPrompt(b).includes('OPERATIONAL COMPLETION GATE'));
});

test('ordinary explanation remains free to respond without tools',()=>{
 const b=body([{role:'user',content:'{"user_message":"explique o que é uma estrutura de algoritmo"}'}]);
 assert.equal(operationalActionContext(b).requested,false);
 const s=JSON.stringify({thoughts:[],headline:'answer',tool_name:'response',tool_args:{text:'É uma organização lógica.'}});
 assert.doesNotThrow(()=>validateAnswer(s,b));
});

test('requested verification requires real tool evidence',()=>{
 const b=body([{role:'user',content:'{"user_message":"teste e verifique o serviço do servidor"}'},{role:'assistant',content:'{"tool_name":"code_execution_tool","tool_args":{"runtime":"terminal","code":"systemctl status x"}}'}]);
 const s=JSON.stringify({thoughts:[],headline:'done',tool_name:'response',tool_args:{text:'Tudo certo.'}});
 assert.throws(()=>validateAnswer(s,b),/Verification was requested/);
});

test('operational response allowed after real tool result',()=>{
 const b=body([{role:'user',content:'{"user_message":"teste e verifique o serviço do servidor"}'},{role:'assistant',content:'{"tool_name":"code_execution_tool","tool_args":{"runtime":"terminal","code":"systemctl status x"}}'},{role:'user',content:'{"tool_result":"active (running); exit 0"}'}]);
 const s=JSON.stringify({thoughts:[],headline:'done',tool_name:'response',tool_args:{text:'Verificado: ativo, código zero.'}});
 assert.doesNotThrow(()=>validateAnswer(s,b));
});

test('last embedded user_message wins over stale browser request',()=>{
 const wrapped='[PROTOCOL] history {"user_message":"abra um blog no navegador"} current {"user_message":"Execute code_execution_tool no servidor"} [EXTRAS]';
 assert.equal(extractedUserText(wrapped),'Execute code_execution_tool no servidor');
 const b=body([{role:'user',content:wrapped}]);
 assert.equal(browserActionContext(b).requested,false);
  assert.equal(operationalActionContext(b).requested,true);
  assert.deepEqual(operationalActionContext(b).requiredTools,['code_execution_tool']);
});

test('wrong stale tool cannot satisfy latest explicit tool request',()=>{
 const b=body([{role:'user',content:'{"user_message":"execute code_execution_tool no terminal do servidor"}'},{role:'assistant',content:'{"tool_name":"browser","tool_args":{"action":"list"}}'},{role:'user',content:'{"tool_result":"browser tabs"}'}]);
 const s=JSON.stringify({thoughts:[],headline:'done',tool_name:'response',tool_args:{text:'Concluído.'}});
 assert.throws(()=>validateAnswer(s,b),/Required tool was not attempted.*code_execution_tool/);
});

test('explicit browser negation does not trigger browser gate',()=>{
 const b=body([{role:'user',content:'{"user_message":"execute code_execution_tool no servidor; não use navegador"}'}]);
 assert.equal(browserActionContext(b).requested,false);
 assert.deepEqual(operationalActionContext(b).requiredTools,['code_execution_tool']);
});

test('tool result containing nested user_message is never a real user turn',()=>{
 const nested=JSON.stringify({tool_result:JSON.stringify({history:[{user_message:'stale request'}]})});
 assert.equal(isCurrentUserMessage({role:'user',content:nested}),false);
 const transcript=[system,{role:'user',content:'{"user_message":"real request"}'},{role:'assistant',content:'tool call'},{role:'user',content:nested}];
 const p=buildPrompt({messages:transcript},180000,null,null,{browserOwnsHistory:true});
 assert.ok(p.includes('real request'));
});

test('browser-owned history sends only messages appended after prior hashes',()=>{
 const first=body([{role:'user',content:'{"user_message":"old request"}'},{role:'assistant',content:'old assistant'}]);
 const crypto=require('crypto');
 const hashes=first.messages.filter(m=>m.role!=='system').map(m=>crypto.createHash('sha256').update(JSON.stringify({role:m.role,name:m.name||'',content:m.content})).digest('hex'));
 const second=body([...first.messages.filter(m=>m.role!=='system'),{role:'user',content:'{"tool_result":"NEW_RESULT"}'}]);
 const p=buildPrompt(second,180000,new Set(),{messageHashes:hashes,toolsHash:''},{browserOwnsHistory:true});
 assert.ok(p.includes('NEW_RESULT'));
 assert.ok(!p.includes('old request'));
 assert.ok(!p.includes('old assistant'));
 assert.ok(p.includes('TRANSPORT APPEND DELTA'));
});

test('browser-owned history rebases to newest event when Agent Zero rewrites old history',()=>{
 const b=body([{role:'user',content:'{"user_message":"rewritten historical task"}'},{role:'assistant',content:'old assistant'},{role:'user',content:'{"tool_result":"LATEST_ONLY"}'}]);
 const p=buildPrompt(b,180000,new Set(),{messageHashes:['not-a-prefix'],toolsHash:''},{browserOwnsHistory:true});
 assert.ok(p.includes('LATEST_ONLY'));
 assert.ok(!p.includes('rewritten historical task'));
 assert.ok(!p.includes('old assistant'));
 assert.ok(p.length<10000);
});

test('megabyte recursive tool dump is compacted below provider ceiling',()=>{
 const dump=JSON.stringify({tool_result:'HEAD '+JSON.stringify({user_message:'nested stale'})+' X'.repeat(1050000)+' TAIL'});
 const p=buildPrompt(body([{role:'user',content:'{"user_message":"current task"}'},{role:'assistant',content:'tool call'},{role:'user',content:dump}]),180000,null,null,{browserOwnsHistory:true});
 assert.ok(p.includes('current task'));
 assert.ok(p.includes('tool_result compacted by transport'));
 assert.ok(p.includes('HEAD'));
 assert.ok(p.includes('TAIL'));
 assert.ok(p.length<64000);
});

test('oversized memory utility system payload is bounded for browser UI',()=>{
 const b={messages:[{role:'system',content:'MEMORY_START '+('M'.repeat(76000))+' MEMORY_END'}]};
 const p=buildPrompt(b,180000);
 assert.ok(p.includes('MEMORY_START'));
 assert.ok(p.includes('MEMORY_END'));
 assert.ok(p.includes('utility context compacted by transport'));
 assert.ok(p.length<64000);
});

test('oversized memory utility user payload is bounded for browser UI',()=>{
 const b={messages:[{role:'system',content:'extract durable memories'},{role:'user',content:'HISTORY_START '+('H'.repeat(76000))+' HISTORY_END'}]};
 const p=buildPrompt(b,180000);
 assert.ok(p.includes('HISTORY_START'));
 assert.ok(p.includes('HISTORY_END'));
 assert.ok(p.includes('utility context compacted by transport'));
 assert.ok(p.length<64000);
});

test('utility scope stays auxiliary even when payload contains Agent Zero manual',()=>{
 const b=body([{role:'user',content:'HISTORY_START '+('U'.repeat(76000))+' HISTORY_END'}]);
 const p=buildPrompt(b,180000,null,null,{browserOwnsHistory:true,callScope:'utility:0:v3'});
 assert.ok(p.includes('utility context compacted by transport'));
 assert.ok(p.includes('browser_utility_text'));
 assert.ok(!p.includes('OPERATIONAL COMPLETION GATE'));
 assert.ok(p.length<64000);
});

test('first browser-owned agent call uses lean tool catalog and preserves latest prompt',()=>{
 const hugeSystem={role:'system',content:'# Behavioral rules\nPortuguês\n# Agent Zero System Manual\n'+('RULE '.repeat(9000))+'\n## available tools\n'+Array.from({length:35},(_,i)=>`### tool_${i}\nargs: value\n${'DOC '.repeat(1200)}`).join('\n')};
 const b={messages:[hugeSystem,{role:'user',content:'{"user_message":"PROMPT_MUST_SURVIVE"}'}]};
 const p=buildPrompt(b,180000,new Set(),null,{browserOwnsHistory:true,callScope:'main:0'});
 assert.ok(p.includes('PROMPT_MUST_SURVIVE'));
 assert.ok(p.includes('compact transport catalog'));
 assert.ok(p.length<64000);
});
