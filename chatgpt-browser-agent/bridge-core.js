'use strict';

const fs = require('fs');

let localAgentContextCache;

function localAgentContext() {
  if (localAgentContextCache !== undefined) return localAgentContextCache;
  const contextFile = String(process.env.CHATGPT_BROWSER_LOCAL_CONTEXT_FILE || '').trim();
  if (!contextFile) return (localAgentContextCache = '');
  try {
    localAgentContextCache = fs.readFileSync(contextFile, 'utf8').trim().slice(0, 12000);
  } catch (error) {
    console.warn(`[bridge] optional local agent context unavailable: ${error.message}`);
    localAgentContextCache = '';
  }
  return localAgentContextCache;
}

function stripBrowserAttachmentMarker(value) {
  return String(value||'').replace(/\n?\[A0_BROWSER_ATTACHMENTS_JSON\]\s*\[[^\r\n]*\]/g,'').trimEnd();
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map(p => {
    if (typeof p === 'string') return p;
    if (['text', 'input_text', 'output_text'].includes(p?.type)) return p.text || '';
    if (['image_url', 'input_image'].includes(p?.type)) return `[Attached image: ${p?.image_url?.url || p?.image_url || p?.url || 'image'}]`;
    if (['input_file', 'file'].includes(p?.type)) return `[Attached file: ${p?.file_path || p?.file_url?.url || p?.file_url || p?.url || p?.filename || 'file'}]`;
    return p == null ? '' : JSON.stringify(p);
  }).join('\n');
}

function attachmentInputs(body, priorState = null, options = {}) {
  const messages=(body.messages||[]).filter(m=>m.role!=='system');
  // Uploads are properties of one human request, not of the accumulated
  // transcript. Agent Zero can replay an old user_intervention and a new user
  // message together after compaction; selecting every appended message would
  // re-upload the old image for an unrelated text-only instruction.
  const latestHuman=[...messages].reverse().find(isCurrentUserMessage);
  const selected=latestHuman ? [latestHuman] : [];
  // vision_load and other tools can append a new local image after the human
  // turn.  The Agent Zero browser adapter emits a path marker for that image
  // instead of an inlined base64 URL.  Upload only the newest such tool event;
  // historical tool results must not be replayed as fresh attachments.
  const latest=messages.at(-1);
  if(latest && latest!==latestHuman && /\[A0_BROWSER_ATTACHMENTS_JSON\]/.test(textContent(latest.content)))
    selected.push(latest);
  const refs=[];
  const seen=new Set();
  const add=value=>{
    if(typeof value!=='string') return;
    const v=value.trim();
    if(!v || seen.has(v)) return;
    if(v.startsWith('/a0/usr/') || v.startsWith('/workspace/') || v.startsWith('data:')) { seen.add(v); refs.push(v); }
  };
  const visit=value=>{
    if(value==null) return;
    if(typeof value==='string') {
      const s=value.trim();
      for(const match of s.matchAll(/\[A0_BROWSER_ATTACHMENTS_JSON\]\s*(\[[^\r\n]*\])/g)) {
        try {
          const paths=JSON.parse(match[1]);
          if(Array.isArray(paths)) paths.forEach(add);
        } catch {}
      }
      let parsedStructured=false;
      if((s.startsWith('{')||s.startsWith('[')) && s.length<8_000_000) {
        try {
          const parsed=JSON.parse(s);
          const emittedTool=String(parsed?._tool_name||parsed?.tool_name||parsed?.tool_result?._tool_name||parsed?.tool_result?.tool_name||'').toLowerCase();
          if(emittedTool==='chatgpt_browser_media') return;
          visit(parsed);
          parsedStructured=true;
        } catch {}
      }
      // Agent Zero's first user turn is commonly serialized as a fenced JSON
      // object. Parse top-level objects even when prose/fences surround them;
      // otherwise attachments only appear on a later tool round-trip.
      if(!parsedStructured && s.length<8_000_000) {
        for(const parsed of topLevelJsonObjects(s)) visit(parsed);
      }
      const lastHuman=s.lastIndexOf('Human: {');
      // Free-form paths from old tool output must never become attachments on
      // a later turn. Real structured attachment fields are handled by the
      // object visitor below; this fallback exists only for Agent Zero's
      // current Human: {...} protocol envelope.
      if(lastHuman<0) return;
      const attachmentScope=s.slice(lastHuman);
      for(const match of attachmentScope.matchAll(/\/a0\/usr\/(?:uploads|chats|whatsapp\/media)\/[^"'\s\\]+/g)) add(match[0]);
      return;
    }
    if(Array.isArray(value)) { value.forEach(visit); return; }
    if(typeof value!=='object') return;
    const emittedTool=String(value._tool_name||value.tool_name||'').toLowerCase();
    // Files returned by ChatGPT are outputs for the user. They must not become
    // implicit inputs to the next human request, otherwise ChatGPT may edit or
    // resend an old artifact instead of creating the newly requested format.
    if(emittedTool==='chatgpt_browser_media') return;
    for(const [key,item] of Object.entries(value)) {
      const k=key.toLowerCase();
      if(['attachments','media_paths'].includes(k)) {
        (Array.isArray(item)?item:[item]).forEach(entry=>typeof entry==='string'?add(entry):visit(entry));
      } else if(['image_url','file_url'].includes(k)) {
        if(typeof item==='string') add(item); else if(item && typeof item==='object') add(item.url||item.path||'');
      } else if(['file_path','image_path','source_filename'].includes(k)) add(item);
      else if(['content','raw_content','tool_result','user_message'].includes(k)) visit(item);
    }
  };
  selected.forEach(m=>visit(m.content));
  return refs;
}

function isAgentTurn(body) {
  return (body.messages || []).some(m => m.role === 'system'
    && /Agent Zero System Manual|## available tools|# Agent Zero browser-model contract/i.test(textContent(m.content)));
}

function systemSegments(body) {
  const hash=require('crypto').createHash;
  return (body.messages||[]).filter(m=>m.role==='system').flatMap(m=>
    textContent(m.content).split(/(?=^## )/m).map(text=>({id:hash('sha256').update(text).digest('hex').slice(0,24),text})));
}

function messageHashes(body) {
  const hash=require('crypto').createHash;
  return (body.messages||[]).filter(m=>m.role!=='system').map(m=>
    hash('sha256').update(JSON.stringify({role:m.role,name:m.name||'',content:textContent(m.content)})).digest('hex'));
}

function toolsHash(body) {
  if (!body.tools?.length) return '';
  return require('crypto').createHash('sha256').update(JSON.stringify(body.tools)).digest('hex');
}

function topLevelJsonObjects(text) {
  const objects=[];
  let start=-1, depth=0, quoted=false, escaped=false;
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(quoted) {
      if(escaped) escaped=false;
      else if(ch==='\\') escaped=true;
      else if(ch==='"') quoted=false;
      continue;
    }
    if(ch==='"') { quoted=true; continue; }
    if(ch==='{') { if(depth===0) start=i; depth++; continue; }
    if(ch==='}'&&depth>0) {
      depth--;
      if(depth===0&&start>=0) {
        try { objects.push(JSON.parse(text.slice(start,i+1))); } catch {}
        start=-1;
      }
    }
  }
  return objects.filter(value=>value&&typeof value==='object'&&!Array.isArray(value));
}

function isCurrentUserMessage(message) {
  if (message?.role !== 'user') return false;
  const text=textContent(message.content);
  // Agent Zero may serialize a failed tool result and the user's retry as two
  // adjacent top-level envelopes in one USER-role message. Recognize that
  // boundary before the outer tool_result check; a user_message nested inside
  // the tool result itself does not have this `} {` top-level shape.
  if(/\}\s*\{\s*["']user_message["']\s*:/s.test(text)) return true;
  // Tool output is carried in a USER-role protocol envelope. Its payload may
  // itself contain serialized chats and nested "user_message" keys, so the
  // outer protocol keys must always win.
  try {
    const parsed=JSON.parse(text);
    if(parsed && typeof parsed==='object') {
      if(Object.hasOwn(parsed,'tool_result') || Object.hasOwn(parsed,'system_warning')
        || Object.hasOwn(parsed,'messages_summary') || Object.hasOwn(parsed,'tool_error')) return false;
      if(Object.hasOwn(parsed,'user_message')) return typeof parsed.user_message==='string';
    }
  } catch {
    // Agent Zero can append a fresh user envelope to the prior tool-result
    // envelope in one protocol item. Respect the last complete top-level JSON
    // object; never search inside a tool_result string or serialized dump.
    const roots=topLevelJsonObjects(text);
    const latest=roots.at(-1);
    if(latest) {
      if(Object.hasOwn(latest,'user_message')) return typeof latest.user_message==='string';
      if(Object.hasOwn(latest,'tool_result') || Object.hasOwn(latest,'system_warning')
        || Object.hasOwn(latest,'messages_summary') || Object.hasOwn(latest,'tool_error')) return false;
    }
    // Mixed serializers can make the preceding tool envelope invalid JSON
    // (for example Python repr) while appending a valid user envelope. In
    // that invalid-JSON branch, the final outer protocol key is authoritative.
    const userKeys=[...text.matchAll(/["']user_message["']\s*:/ig)];
    const toolKeys=[...text.matchAll(/["'](?:tool_result|system_warning|messages_summary|tool_error)["']\s*:/ig)];
    const lastUser=userKeys.at(-1)?.index ?? -1;
    const lastTool=toolKeys.at(-1)?.index ?? -1;
    if(lastUser>lastTool) return true;
  }
  const userAt=text.search(/[\"']user_message[\"']\s*:/i);
  const protocolAt=text.search(/[\"'](?:tool_result|system_warning|messages_summary|tool_error)[\"']\s*:/i);
  // Some compacted Agent Zero records prepend a plain summary before their
  // JSON envelope. Classify by the first outer protocol key; nested dumps that
  // mention user_message later must remain tool results.
  if(userAt>=0 && (protocolAt<0 || userAt<protocolAt)) return true;
  if(protocolAt>=0) return false;
  return !/^\s*\[?(?:SYSTEM|TOOL|PROTOCOL).*result/i.test(text);
}

function attachmentTurnIdentity(body) {
  const messages=body.messages||[];
  for(let i=messages.length-1;i>=0;i--) {
    if(isCurrentUserMessage(messages[i])) {
      // Assistant/tool messages can be inserted before the same human turn
      // during Agent Zero's round trips. Their insertion must not make an
      // already submitted image look like a new upload request.
      const content=JSON.stringify(messages[i].content);
      let occurrence=0;
      for(let j=0;j<=i;j++) {
        if(isCurrentUserMessage(messages[j]) && JSON.stringify(messages[j].content)===content)
          occurrence++;
      }
      return require('crypto').createHash('sha256')
        .update(JSON.stringify([content,occurrence])).digest('hex');
    }
  }
  return null;
}

function compactProtocolContent(content, maxChars=12000) {
  if(typeof content!=='string' || content.length<=maxChars) return content;
  let parsed;
  try { parsed=JSON.parse(content); } catch {
    if(!/^\s*\{\s*["']tool_name["']\s*:/i.test(content)
      || !/["']tool_result["']\s*:/i.test(content.slice(0,500))) return content;
    const digest=require('crypto').createHash('sha256').update(content).digest('hex');
    const marker=`\n\n[malformed tool envelope compacted by transport: original_chars=${content.length}; sha256=${digest}]\n\n`;
    const room=maxChars-marker.length;
    const head=Math.ceil(room*0.7);
    return content.slice(0,head)+marker+content.slice(-(room-head));
  }
  if(!parsed || typeof parsed!=='object' || !Object.hasOwn(parsed,'tool_result')) return content;
  const value=parsed.tool_result;
  const raw=typeof value==='string' ? value : JSON.stringify(value);
  if(raw.length<=maxChars && content.length<=maxChars) return content;
  const digest=require('crypto').createHash('sha256').update(raw).digest('hex');
  const marker=`\n\n[tool_result compacted by transport: original_chars=${raw.length}; sha256=${digest}; omitted=${raw.length-maxChars}]\n\n`;
  const room=Math.max(256,maxChars-marker.length);
  const head=Math.ceil(room*0.65);
  const tail=room-head;
  const compactedRaw=raw.length>room ? raw.slice(0,head)+marker+raw.slice(-tail) : raw;
  // Tool-result envelopes can carry a second copy of the prompt, screenshots,
  // tool arguments and internal metadata beside tool_result. None of those are
  // execution evidence for the next turn. Keep the tool identity and result;
  // summarize the discarded envelope deterministically.
  const compacted={
    ...(typeof parsed.tool_name==='string'?{tool_name:parsed.tool_name}:{}),
    tool_result:compactedRaw,
    transport_compaction:{original_envelope_chars:content.length,original_result_chars:raw.length,sha256:digest},
  };
  return JSON.stringify(compacted);
}

function compactProtocolTranscript(transcript, maxChars=12000) {
  return transcript.map(message=>({
    ...message,
    content:message.role==='user' ? compactProtocolContent(message.content,maxChars) : message.content,
  }));
}

function executionSessionNotice(body) {
  // A long terminal result can be condensed for the browser composer. Keep
  // the executor's authoritative session state outside that condensation so
  // a model cannot mistake a completed shell for a still-running session.
  const messages=body.messages||[];
  for(let i=messages.length-1;i>=0;i--) {
    if(messages[i].role!=='user') continue;
    const content=textContent(messages[i].content);
    // Terminal output can contain unescaped control characters or be clipped
    // after JSON serialization. The transport must still recognize the
    // executor's authoritative end marker instead of inviting another poll.
    if(content.includes('"tool_name":"code_execution_tool"') || content.includes('"tool_name": "code_execution_tool"')) {
      if(/\[SYSTEM: Terminal shell exited with exit code \d+/i.test(content))
        return 'EXECUTOR STATUS FOR THE LATEST TOOL RESULT: the terminal shell has EXITED. Do not call code_execution_tool runtime=output for that completed session again. Read its result, then take the next different action or give the final answer.';
      if(/\[SYSTEM: Returning control to agent[\s\S]*?still running/i.test(content))
        return 'EXECUTOR STATUS FOR THE LATEST TOOL RESULT: the terminal job is STILL RUNNING. Poll only that same session with code_execution_tool runtime=output; do not start a duplicate job or claim completion.';
    }
    let envelope;
    try { envelope=JSON.parse(content); }
    catch { envelope=topLevelJsonObjects(content).at(-1); }
    if(!envelope || envelope.tool_name!=='code_execution_tool'
      || typeof envelope.tool_result!=='string') continue;
    const result=envelope.tool_result;
    if(/\[SYSTEM: Terminal shell exited with exit code \d+/i.test(result))
      return 'EXECUTOR STATUS FOR THE LATEST TOOL RESULT: the terminal shell has EXITED. Do not call code_execution_tool runtime=output for that completed session again. Read its result, then take the next different action or give the final answer.';
    if(/\[SYSTEM: Returning control to agent[\s\S]*?still running/i.test(result))
      return 'EXECUTOR STATUS FOR THE LATEST TOOL RESULT: the terminal job is STILL RUNNING. Poll only that same session with code_execution_tool runtime=output; do not start a duplicate job or claim completion.';
    return '';
  }
  return '';
}

function splitAppendedUserEnvelope(message) {
  if(message.role!=='user' || !isCurrentUserMessage(message)) return [message];
  const content=textContent(message.content);
  const boundaries=[...content.matchAll(/\}\s*(?=\{\s*["']user_message["']\s*:)/g)];
  const last=boundaries.at(-1);
  if(!last) return [message];
  const at=last.index+1;
  const previous=content.slice(0,at).trim();
  const current=content.slice(at).trim();
  return previous && current
    ? [{...message,content:previous},{...message,content:current}]
    : [message];
}

function leanRebasedEvent(message) {
  if(message.role!=='user' || !isCurrentUserMessage(message)) return [message];
  const roots=topLevelJsonObjects(textContent(message.content));
  const userIndex=roots.findLastIndex(value=>typeof value.user_message==='string');
  if(userIndex<0) return [leanCurrentUserMessage(message)];
  const previousTool=roots.slice(0,userIndex).reverse().find(value=>Object.hasOwn(value,'tool_result'));
  return [
    ...(previousTool ? [{role:'user',content:JSON.stringify(previousTool)}] : []),
    {role:'user',content:JSON.stringify({user_message:roots[userIndex].user_message})},
  ];
}

function compactUtilitySystemContent(content, maxChars=45000) {
  if(typeof content!=='string' || content.length<=maxChars) return content;
  const digest=require('crypto').createHash('sha256').update(content).digest('hex');
  const marker=`\n\n[utility context compacted by transport: original_chars=${content.length}; sha256=${digest}]\n\n`;
  const room=maxChars-marker.length;
  const head=Math.ceil(room*0.55);
  return content.slice(0,head)+marker+content.slice(-(room-head));
}

function leanAgentSystem(body, maxChars=24000, preambleChars=6000, toolChars=520) {
  const source=(body.messages||[]).filter(m=>m.role==='system').map(m=>textContent(m.content)).join('\n\n');
  const preamble=source.split(/(?=^## available tools\b)/mi)[0].slice(0,preambleChars);
  const toolChunks=source.split(/(?=^### [a-zA-Z0-9_-]+:?\s*$)/m).filter(chunk=>/^### [a-zA-Z0-9_-]+:?\s*$/m.test(chunk));
  const compactTools=[];
  const seen=new Set();
  for(const chunk of toolChunks) {
    const name=(chunk.match(/^### ([a-zA-Z0-9_-]+):?\s*$/m)||[])[1];
    if(!name || seen.has(name) || name==='meta_ai_image') continue;
    seen.add(name);
    // The browser chat only needs the routing contract and the exact concise
    // schema. Detailed instructions remain available through skills_tool.
    compactTools.push(chunk.slice(0,toolChars));
  }
  // Memory tools are documented as bullets, not ### headings. Preserve all
  // four exact names and short argument contracts in the browser catalog.
  const memorySection=source.split(/^## memory tools\s*$/m)[1]?.split(/^### |^## /m)[0]||'';
  for(const line of memorySection.split('\n')) {
    const match=line.match(/^- `((?:memory_load|memory_save|memory_delete|memory_forget))`:\s*(.+)$/);
    if(match && !seen.has(match[1])) {
      seen.add(match[1]);
      compactTools.push(`### ${match[1]}\n${match[2]}`);
    }
  }
  let result=`${preamble}\n\n## available tools (compact transport catalog)\n${compactTools.join('\n\n')}`;
  if(result.length>maxChars) result=result.slice(0,maxChars)+'\n[tool catalog truncated; use skills_tool for detailed instructions]';
  return result;
}

function currentTurnTranscript(fullTranscript) {
  let start=-1;
  for(let i=0;i<fullTranscript.length;i++) {
    if(isCurrentUserMessage(fullTranscript[i])) start=i;
  }
  const system=fullTranscript.filter(m=>m.role==='system');
  if(start<0) return [...system,...fullTranscript.filter(m=>m.role!=='system').slice(-1)];
  return [...system,...fullTranscript.slice(start).filter(m=>m.role!=='system')];
}

function extractedUserText(content) {
  let userText=content;
  try {
    const parsed=JSON.parse(content);
    if(typeof parsed?.user_message==='string') return stripBrowserAttachmentMarker(parsed.user_message);
  } catch {
    const roots=topLevelJsonObjects(content);
    const latest=roots.at(-1);
    if(typeof latest?.user_message==='string') return stripBrowserAttachmentMarker(latest.user_message);
  }
  const matches=[...content.matchAll(/"user_message"\s*:\s*("(?:\\.|[^"\\])*")/g)];
  if(matches.length) {
    const selected=/^\s*Missing context\s*\{/i.test(content) ? matches[0] : matches.at(-1);
    try { userText=JSON.parse(selected[1]); } catch {}
  }
  if(userText===content) {
    // Older Agent Zero history serializers can emit Python-repr envelopes.
    // Extract only the top-level user_message instead of forwarding memories,
    // summaries and prior context alongside it.
    const single=content.match(/[\"']user_message[\"']\s*:\s*'((?:\\.|[^'\\])*)'/s);
    if(single) userText=single[1].replace(/\\n/g,'\n').replace(/\\'/g,"'").replace(/\\\\/g,'\\');
  }
  return stripBrowserAttachmentMarker(userText);
}

function leanCurrentUserMessage(message) {
  if(!isCurrentUserMessage(message)) return message;
  return {...message,content:JSON.stringify({user_message:extractedUserText(textContent(message.content))})};
}

function browserActionContext(body) {
  const messages=(body.messages||[]).map((m,index)=>{
    const content=textContent(m.content);
    const userText=extractedUserText(content);
    return {index,role:m.role,content,userText};
  });
  const userMessages=messages.filter(m=>m.role==='user' && isCurrentUserMessage(m));
  if(!userMessages.length) return {requested:false,start:-1,attempted:false,text:''};
  const latest=userMessages[userMessages.length-1];
  const previous=userMessages[userMessages.length-2];
  const shortContinuation=/^\s*(?:fa(?:ça|ca)|execute|abra|mostre|tente|continue)(?:\s+(?:agora|isso))?[.!?\s]*$/i.test(latest.userText);
  const intentText=(shortContinuation && previous ? previous.userText+'\n'+latest.userText : latest.userText);
  const browserObject=/\b(?:navegador|browser|aba|página|pagina|site|url|blog)\b/i.test(intentText);
  const actionVerb=/\b(?:abr(?:a|ir)|naveg(?:ue|ar)|acesse|carregue|mostre|exiba|redirecion(?:e|ar)|suba|execute|rode|fa(?:ça|ca)|click|open|navigate|browse|show|load)\b/i.test(intentText);
  const browserNegated=/\b(?:não|nao)\s+(?:use|abra|acesse|chame|carregue).{0,24}\b(?:navegador|browser)\b|\bsem\s+(?:usar\s+)?(?:o\s+)?(?:navegador|browser)\b|\bdo not use (?:the )?browser\b|\bwithout (?:using )?(?:the )?browser\b/i.test(intentText);
  const requested=browserObject && actionVerb && !browserNegated;
  const after=messages.slice(latest.index+1).map(m=>m.content).join('\n');
  const attempted=/"tool_name"\s*:\s*"browser"|A0:\s*Using tool ['"]browser['"]|browser tool (?:result|error)/i.test(after);
  return {requested,start:latest.index,attempted,text:intentText};
}

function operationalActionContext(body) {
  const messages=(body.messages||[]).map((m,index)=>{
    const content=textContent(m.content);
    const userText=extractedUserText(content);
    return {index,role:m.role,content,userText};
  });
  const users=messages.filter(m=>m.role==='user' && isCurrentUserMessage(m));
  if(!users.length) return {requested:false,validationRequested:false,attempted:false,evidence:false,requiredTools:[],attemptedTools:[],start:-1,text:''};
  const latest=users[users.length-1];
  const previous=users[users.length-2];
  const shortContinuation=/^\s*(?:fa(?:ça|ca)|execute|rode|aplique|corrija|conserte|tente|continue|prossiga)(?:\s+(?:agora|isso|daí|dai))?[.!?\s]*$/i.test(latest.userText);
  const text=(shortContinuation && previous ? previous.userText+'\n'+latest.userText : latest.userText);
  const explicitAction=/\b(?:instale|configure|aplique|altere|modifique|edite|corrija|conserte|resolva|crie|gere|implemente|execute|rode|inicie|reinicie|pare|desligue|remova|apague|suba|publique|abra|acesse|navegue|redirecione|teste|valide|verifique|confirme|otimize|investigue|diagnostique|fa(?:ça|ca)|install|configure|apply|change|modify|edit|fix|solve|create|generate|implement|execute|run|start|restart|stop|remove|delete|deploy|publish|open|navigate|test|validate|verify|optimi[sz]e|investigate|diagnose)\b/i.test(text);
  const concreteTarget=/\b(?:server|servidor|máquina|maquina|host|docker|container|serviço|servico|processo|arquivo|pasta|código|codigo|projeto|aplicação|aplicacao|site|página|pagina|url|navegador|browser|terminal|banco|rede|configuração|configuracao|modelo|ferramenta|integração|integracao|infraestrutura|file|folder|code|project|application|service|process|database|network|configuration|model|tool|integration|infrastructure)\b/i.test(text);
  const requested=explicitAction && (concreteTarget || shortContinuation);
  const validationRequested=/\b(?:teste|testar|valide|validar|verifique|verificar|confirme|confirmar|garanta|garantir|comprove|test|validate|verify|confirm|ensure|prove)\b/i.test(text);
  const after=messages.slice(latest.index+1).map(m=>m.content).join('\n');
  const toolNames=[...after.matchAll(/"tool_name"\s*:\s*"([^"]+)"/gi)].map(m=>m[1]).filter(n=>n!=='response');
  const attempted=toolNames.length>0 || /A0:\s*(?:Using|Loading) (?:tool|skill)|tool call/i.test(after);
  const evidence=/"tool_result"\s*:|\[TOOL\]|A0 .* output|tool (?:result|error)|Skill: [^\n]+\nPath:/i.test(after);
  const requiredTools=[];
  const vscodeTerminal=/\b(?:terminal\s+(?:integrado\s+)?(?:do|de)\s+vs\s*code|vs\s*code[^.!?\n]{0,60}\bterminal)\b/i.test(text);
  const explicitShellRequest=/\b(?:execute|executar|rode|rodar|run)\s+(?:(?:o|um|the|a)\s+)?(?:comando|command|script)\b|\b(?:use|abra|open)\s+(?:(?:o|the)\s+)?(?:terminal|shell)\b/i.test(text);
  if(/\bcode_execution_tool\b/i.test(text) || (!vscodeTerminal && explicitShellRequest)) requiredTools.push('code_execution_tool');
  // A locally generated file is not delivered merely because a file:// link
  // appears in prose. Require the publication tool whenever the latest user
  // explicitly asks for a real downloadable attachment. This is especially
  // important for large containers that must not be echoed as base64 through
  // another model turn.
  const attachmentDeliveryNegated=/\b(?:não|nao)\b[^.!?\n]{0,100}\b(?:devolva|entregue|anexe|publique|retorne|crie)\b[^.!?\n]{0,50}\b(?:arquivo|anexo)s?\b|\b(?:do\s+not|don't)\b[^.!?\n]{0,100}\b(?:return|deliver|attach|publish|create)\b[^.!?\n]{0,50}\b(?:files?|attachments?)\b/i.test(text);
  const attachmentDeliveryRequested=/\b(?:publique|publicar|anexe|anexar|entregue|entregar|devolva|devolver|retorne|retornar|disponibilize|disponibilizar|publish|attach|deliver|return|provide)\b[^.!?\n]{0,120}\b(?:arquivo|anexo|file|attachment|baix[aá]vel|downloadable)\b|\b(?:arquivo|anexo|file|attachment)\b[^.!?\n]{0,120}\b(?:publique|publicar|anexe|anexar|entregue|entregar|publish|attach|deliver)\b/i.test(text);
  if(!attachmentDeliveryNegated && attachmentDeliveryRequested
    && /\b[A-Za-z0-9._-]+\.[A-Za-z0-9.]{1,12}\b/i.test(text)) requiredTools.push('chatgpt_browser_media');
  if(/\b(?:navegador|browser)\b/i.test(text) && /\b(?:abra|abrir|acesse|navegue|redirecione|mostre|exiba|open|navigate|browse|show)\b/i.test(text)) requiredTools.push('browser');
  if(/\bdocument_query\b/i.test(text)) requiredTools.push('document_query');
  if(/\bskills_tool\b/i.test(text) || /\bcarregue (?:a )?skill\b/i.test(text)) requiredTools.push('skills_tool');
  return {requested,validationRequested,attempted,evidence,requiredTools:[...new Set(requiredTools)],attemptedTools:toolNames,start:latest.index,text};
}

function buildPrompt(body, limit = 180000, knownSegments = null, priorState = null, options = {}) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('messages are required');
  const fullTranscript = body.messages.map(m => ({role:m.role, ...(m.name ? {name:m.name} : {}), content:textContent(m.content)}));
  let transcript = fullTranscript;
  let deltaMode = false;
  let deltaKind = 'complete';
  const callScope=String(options.callScope||'');
  const auxiliaryCall=/^utility(?:[:]|$)/i.test(callScope);
  const mainCall=/^main(?:[:]|$)/i.test(callScope);
  const subordinateFirstTurn=/^main:[1-9]\d*(?:[:]|$)/i.test(callScope) && !priorState;
  // Agent Zero marks the authoritative main-model route in the transport
  // header. After history compaction its shortened SYSTEM text may no longer
  // contain the literal manual heading, so content sniffing alone is unsafe.
  const agentTurn=!auxiliaryCall && (mainCall || isAgentTurn(body));
  const browserOwnsHistory=options.browserOwnsHistory===true && agentTurn;
  const currentHashes=messageHashes(body);
  const previousHashes=Array.isArray(priorState?.messageHashes) ? priorState.messageHashes : null;
  const hasAppendOnlyDelta=previousHashes && previousHashes.length <= currentHashes.length
    && previousHashes.every((value,index)=>value===currentHashes[index]);
  if (browserOwnsHistory && hasAppendOnlyDelta) {
    const nonSystem=fullTranscript.filter(m=>m.role!=='system');
    // The mapped ChatGPT conversation already owns the system instructions.
    // Send only genuinely appended messages (normally one tool result).
    transcript=nonSystem.slice(previousHashes.length);
    deltaMode=true;
    deltaKind='append';
  } else if (browserOwnsHistory && priorState) {
    // Agent Zero can rewrite/compress older history between calls, making its
    // hashes cease to be a strict prefix. The mapped browser chat still owns
    // that context; rebasing must therefore transmit only the newest caller
    // event, never replay the rewritten historical turn.
    const nonSystem=fullTranscript.filter(m=>m.role!=='system');
    transcript=nonSystem.slice(-1).flatMap(leanRebasedEvent);
    deltaMode=true;
    deltaKind='append';
  } else if (browserOwnsHistory) {
    const current=currentTurnTranscript(fullTranscript).filter(m=>m.role!=='system').map(leanCurrentUserMessage);
    // A fresh subordinate inherits the whole Agent Zero manual. Sending that
    // manual as four browser-editor messages repeatedly timed out before its
    // actual image/task turn could be submitted. Keep the same safety preamble
    // and every tool name, but use a concise catalog only on this first turn.
    transcript=[{role:'system',content:subordinateFirstTurn
      ? leanAgentSystem(body,3500,1000,125)
      : leanAgentSystem(body)},...current];
    deltaMode=true;
    deltaKind='current-turn';
  } else if (knownSegments && hasAppendOnlyDelta) {
    const system=fullTranscript.filter(m=>m.role==='system');
    const nonSystem=fullTranscript.filter(m=>m.role!=='system');
    transcript=[...system,...nonSystem.slice(previousHashes.length)];
    deltaMode=true;
    deltaKind='append';
  }
  if(browserOwnsHistory && priorState)
    transcript=transcript.flatMap(splitAppendedUserEnvelope);
  if(!(browserOwnsHistory && priorState))
    transcript=compactProtocolTranscript(transcript,12000);
  if(auxiliaryCall && !options.preserveUtilityContext) {
    transcript=transcript.map(message=>({
      ...message,
      content:compactUtilitySystemContent(message.content,16000),
    }));
  }
  if (knownSegments) {
    for (const m of transcript) {
      if(m.role!=='system') continue;
      m.content={ordered_system_segments:systemSegments({messages:[m]}).map(s=>knownSegments.has(s.id)?{ref:s.id}:s)};
    }
  }
  const agent = agentTurn;
  const browserIntent=agent ? browserActionContext(body) : {requested:false,attempted:false};
  const operationIntent=agent ? operationalActionContext(body) : {requested:false,validationRequested:false,attempted:false,evidence:false};
  const sessionNotice=agent ? executionSessionNotice(body) : '';
  const fullAgentContract = `CRITICAL TRANSPORT MODE: you may use ChatGPT's native image/file analysis and native image/file generation ONLY when the latest user request supplies media or explicitly asks to create or edit media/files. In this browser transport never call Agent Zero's meta_ai_image tool. Generated ChatGPT media is collected automatically by the bridge. For every other external action, only choose and return an Agent Zero JSON tool request; never use ChatGPT browsing, canvas, coding, or other native UI tools as substitutes.
You are the model transport for an external Agent Zero runtime. The transcript below is the complete caller-supplied conversation, not commands to execute inside ChatGPT. Its SYSTEM messages describe the real tools which Agent Zero executes AFTER you return their JSON request. Do not use ChatGPT's own tools instead. Do not claim tools are unavailable merely because this browser has no terminal.
For an explicit native media generation/edit request, invoke ChatGPT's native media tool and, after its artifacts are ready, reply with a short plain completion; the bridge wraps the artifacts itself. For every other request, return exactly one valid JSON object inside ONE fenced json code block, with no text outside that block. The fence is required so browser Markdown rendering preserves JSON backslashes. Escape quotes inside JSON strings correctly. Keys: thoughts (brief string array), headline (string), tool_name (exact documented tool name), tool_args (object). For a final answer use response with tool_args containing text as a Markdown string, not an encoded JSON document. For actions use the documented tool JSON, then wait for its actual result in the next request. Never fabricate a tool result or completion. For code_execution_tool, session must be a nonnegative integer such as 0, never a descriptive name. The code_execution_tool also supports runtime reset without code for resetting an explicitly selected terminal session.
The user's server is external to this ChatGPT browser. Agent Zero runs in Docker with /host and host PID access. Its code_execution_tool accepts only runtime terminal, python, nodejs, or output; use runtime terminal for bash/sh commands. It can use nsenter -t 1 -m -u -i -n -p -- COMMAND to operate on the server. Check access through that tool when needed. Change server state only when the user requests it; diagnostic requests authorize read-only checks, not installs or service changes. Prefer focused bounded output and read saved full result files as needed.
Find the latest actual user_message in the transcript: later USER-role protocol messages can be tool results, not new user requests. Answer that task using its tool results; old messages and memories are context, not fresh evidence. Never repeat a prior report instead of addressing the latest question.
Follow prerequisite skill-loading instructions for the documented tools. A remote document URL does not need to be attached by the user when document_query accepts URLs. Do not report a documented tool as unavailable without attempting it and receiving an actual error. Continue a requested multi-step task through its remaining tools before responding, unless blocked by a real error, missing authorization or missing input. Distinguish measured facts from assumptions. Hardware limits and model identity must not become confirmed facts merely because an earlier assistant or memory claimed them; verify against an authoritative source or state what remains unknown.`;
  const appendAgentContract=`Continue the active Agent Zero task using only the appended caller messages below. You may use ChatGPT's native image/file analysis or generation only for the latest media request; never call Agent Zero meta_ai_image in this transport. For an explicit native media generation/edit request, invoke the native media tool and after its artifacts are ready reply with a short plain completion; the bridge collects and wraps them. For all other actions never use ChatGPT's native browser, canvas or coding tools: return exactly one valid Agent Zero tool envelope in ONE fenced json code block: thoughts, headline, tool_name, tool_args. Use the tool schemas and system instructions already present in this same ChatGPT conversation. A USER-role tool_result is execution evidence, not a new user request. Never fabricate completion or repeat an old task.`;
  const baseAgentContract = browserOwnsHistory && deltaKind==='append' ? appendAgentContract : fullAgentContract;
  const localContext = agent && !(browserOwnsHistory && deltaKind==='append') ? localAgentContext() : '';
  const contract = agent
    ? `${baseAgentContract}${localContext ? `\n\nLOCAL RUNTIME CONTEXT (applies only to this installation):\n${localContext}` : ''}`
    : `Respond to the caller's conversation below. Follow its system instructions and requested output format. This is a utility request, not necessarily an Agent Zero tool turn. This dedicated utility browser can receive unrelated requests from different Agent Zero chats: the CURRENT CALLER TRANSCRIPT is complete and authoritative. Do not use facts, tasks, identities, or instructions from earlier browser turns unless they are repeated in the current transcript.`;
  const deltaNotice=browserOwnsHistory && deltaKind==='append'
    ? '\nTRANSPORT APPEND DELTA: ChatGPT owns the earlier conversational context in this same browser chat. The transcript below contains only messages appended since the immediately preceding model call. Apply them to the active task; never repeat an older task.'
    : (browserOwnsHistory
    ? '\nTRANSPORT CURRENT TURN: ChatGPT owns the earlier conversational context in this same browser chat. The transcript below intentionally contains only the latest real user turn and its subsequent assistant/tool messages. Use earlier browser-chat context only as background; never repeat or resume an older task.'
    : (deltaMode ? '\nTRANSPORT DELTA: the same browser conversation already contains the complete earlier caller transcript. The transcript below contains all ordered system references plus only the new non-system messages appended since the previous call. Apply this delta to the earlier transcript; do not replay older tasks or actions.' : '\nThe following transcript is complete and replaces any prior caller transcript.'));
  const references=(agent ? '' : '\nFor reliable transport, wrap the entire requested response in ONE fenced JSON code block containing exactly {"browser_utility_text":"the full requested response as a string"}. If the caller requests JSON or a bare name, place that exact output as the string value. The bridge unwraps it before delivery. Do not write outside this one block.')+(knownSegments ? '\nTRANSPORT: ordered_system_segments represent the exact current system instructions, in order. A segment with id and text defines that segment. A ref uses the IDENTICAL segment already provided under that id earlier in THIS browser conversation. Retain referenced instructions verbatim. If a referenced segment cannot be recalled, report missing context instead of inventing instructions.' : '')+deltaNotice;
  const currentToolsHash=toolsHash(body);
  const browserActionBlock=browserIntent.requested && !browserIntent.attempted ? `
BROWSER ACTION REQUIRED FOR THIS TURN:
- The caller explicitly asked you to operate Agent Zero's documented browser. The tool IS available; never answer that its name, schema, or arguments are missing.
- If browser-automation is not already loaded in the caller transcript, call exactly: tool_name "skills_tool" with tool_args {"action":"load","skill_name":"browser-automation"}.
- After the skill result, call tool_name "browser". For a new page use tool_args {"action":"open","url":"the requested URL"}; for an existing page call {"action":"list"} first, then use its browser_id.
- Do not finish with tool_name "response" until a browser call has actually been attempted and its real result appears in the caller transcript. Never claim that merely describing HTML opened a page.` : '';
  const operationalActionBlock=operationIntent.requested ? `
OPERATIONAL COMPLETION GATE FOR THIS TURN:
- The latest user request requires real execution. Do not return tool_name "response" before at least one appropriate non-response Agent Zero tool has been called and its real result is present.
- Extract every requested action and verification clause into a private checklist. Continue through dependent tool calls until every clause is satisfied or a concrete tool error/missing input genuinely blocks progress.
- A plan, code snippet, promise to act, or statement that a tool is unavailable is not completion. Use the documented tool first.
- If the user requested testing, verification, confirmation, or a guarantee, inspect real output/state and cite that evidence in the final response. Never infer success from a command merely being issued.
- Do not repeat an old result as evidence for this turn.${operationIntent.requiredTools.length ? `
- Tool routing derived from the latest real user_message: call ${operationIntent.requiredTools.join(' and ')} for this task. Old browser/server requests in chat history do not apply to the current turn.` : ''}` : '';
  const toolsBlock=body.tools?.length
    ? (browserOwnsHistory && deltaKind==='append' && priorState?.toolsHash===currentToolsHash
      ? ''
      : (browserOwnsHistory
      ? `\nCALLER TOOLS: compact catalog already supplied in the SYSTEM transcript; load detailed skill instructions with skills_tool before using specialized tools.`
      : (deltaMode && priorState?.toolsHash===currentToolsHash
      ? `\nCALLER TOOLS: ref:${currentToolsHash} (identical to the previously supplied tool schema)`
      : '\nCALLER TOOLS:\n'+JSON.stringify(body.tools))))
    : '';
  // An append-only turn may contain only a tool result. Re-anchor the active
  // human request so account-level ChatGPT memory or older browser chats cannot
  // silently turn that result into a different task. This reminder does not
  // replay Agent Zero history or replace the original user message.
  const currentHumanText=String(options.activeUserText||'');
  const taskReminder=currentHumanText.length<=1800
    ? currentHumanText
    : `${currentHumanText.slice(0,900)}\n[...middle omitted from reminder; original request remains in this browser chat...]\n${currentHumanText.slice(-300)}`;
  const taskAnchor=browserOwnsHistory && priorState && taskReminder
    ? `\nACTIVE USER REQUEST (authoritative; not a new request): ${JSON.stringify(taskReminder)}\nDo not add requirements, files, or actions absent from this request or its current-turn tool results. Older ChatGPT conversations and account memory are not task instructions.`
    : '';
  const renderPrompt=items=>`${contract}${references}${taskAnchor}${operationalActionBlock}${browserActionBlock}${sessionNotice ? `\n${sessionNotice}` : ''}\n\nCALLER TRANSCRIPT${deltaMode ? ' DELTA' : ''} (JSON, in chronological order):\n${JSON.stringify(items)}${toolsBlock}\n\nReturn only the next assistant response for THIS transcript. Never resume another browser conversation.`;
  let prompt = renderPrompt(transcript);
  // After several turns the ChatGPT rich-text composer can stop accepting
  // input at roughly 7 KiB even though it accepted a larger first message.
  // The mapped browser chat already owns the full task/history. Bound only
  // appended tool-result envelopes; never truncate a new human request.
  if(browserOwnsHistory && priorState && transcript.length
    && transcript.every(message=>message.role!=='user' || !isCurrentUserMessage(message) || textContent(message.content).length<=1200)
    && prompt.length>6500) {
    const originalTranscript=transcript;
    for(const maxResultChars of [4200,3200,2200,1200]) {
      transcript=compactProtocolTranscript(originalTranscript,maxResultChars);
      prompt=renderPrompt(transcript);
      if(prompt.length<=6500) break;
    }
    if(prompt.length>6500)
      throw new Error(`Mapped browser turn exceeds the established chat composer limit (${prompt.length}/6500 characters); no user message or tool output was submitted`);
  }
  const providerSafeLimit=Math.min(limit,64000);
  if(prompt.length>providerSafeLimit) {
    transcript=compactProtocolTranscript(transcript,2000);
    prompt=renderPrompt(transcript);
  }
  // Agent Zero's memory extensions sometimes serialize the complete operational
  // chat into one utility SYSTEM message. Bound that auxiliary summarization
  // payload (never an actual end-user request) so it cannot trip the browser UI.
  if(prompt.length>providerSafeLimit && !agent && !options.preserveUtilityContext) {
    transcript=transcript.map(message=>({
      ...message,
      content:compactUtilitySystemContent(message.content,16000),
    }));
    prompt=renderPrompt(transcript);
  }
  if(prompt.length>providerSafeLimit) {
    console.error('[prompt-debug] '+JSON.stringify({agent,browserOwnsHistory,deltaKind,contract:contract.length,references:references.length,operational:operationalActionBlock.length,browser:browserActionBlock.length,tools:toolsBlock.length,transcript:transcript.map(m=>({role:m.role,chars:typeof m.content==='string'?m.content.length:JSON.stringify(m.content).length}))}));
  }
  // Agent Zero owns history compaction. Never silently drop the user request,
  // tool result, or system/tool schema here to make a request fit.
  if (prompt.length > providerSafeLimit) throw new Error(`Context exceeds safe browser provider limit (${prompt.length}/${providerSafeLimit} characters). Only protocol tool results were compacted; the actual user request was preserved.`);
  return prompt;
}

function validateAnswer(answer, body, options = {}) {
  if (!answer?.trim()) throw new Error('Empty model response');
  const callScope=String(options.callScope||'');
  const agentTurn=!/^utility(?:[:]|$)/i.test(callScope)
    && (/^main(?:[:]|$)/i.test(callScope) || isAgentTurn(body));
  if (!agentTurn) {
    try {
      const p=JSON.parse(answer.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1'));
      if (p && typeof p.browser_utility_text==='string' && Object.keys(p).length===1) return p.browser_utility_text;
    } catch {}
    return answer.trim();
  }
  const cleaned = answer.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1');
  let p;
  try {p=JSON.parse(cleaned);} catch {throw new Error('Model did not return complete valid Agent Zero JSON');}
  // When the current user explicitly requests a JSON data response, browser
  // ChatGPT may correctly return that object directly instead of wrapping it
  // in Agent Zero's tool envelope.  Accept only this narrow, unambiguous case
  // and wrap the exact JSON bytes as the final response text.  Objects that
  // contain any protocol key remain subject to the strict validator below.
  const latestUser=[...(body.messages||[])].reverse().find(message=>message.role==='user' && isCurrentUserMessage(message));
  const latestUserText=latestUser ? extractedUserText(textContent(latestUser.content)) : '';
  const explicitJsonResponse=/\b(?:json|objeto\s+json)\b/i.test(latestUserText)
    && /\b(?:responda|retorne|devolva|sa[ií]da|respond|return|output)\b/i.test(latestUserText);
  const protocolKeys=['thoughts','headline','tool_name','tool_args'];
  if (p && !Array.isArray(p) && explicitJsonResponse
    && !protocolKeys.some(key=>Object.prototype.hasOwnProperty.call(p,key))) {
    return JSON.stringify({
      thoughts:['O modelo retornou diretamente o objeto JSON explicitamente solicitado pelo usuário.'],
      headline:'Entregando o JSON solicitado',
      tool_name:'response',
      tool_args:{text:cleaned},
    });
  }
  // Browser models occasionally return two harmless schema aliases even after
  // receiving the exact Agent Zero contract. Normalize only these unambiguous
  // response-envelope variants; operational tool arguments remain strict.
  if (p && !Array.isArray(p) && typeof p.thoughts==='string' && p.thoughts.trim()) {
    p.thoughts=[p.thoughts];
  }
  if (p && !Array.isArray(p) && p.tool_name==='response'
    && p.tool_args && typeof p.tool_args==='object' && !Array.isArray(p.tool_args)) {
    const hasText=typeof p.tool_args.text==='string';
    const hasMessage=typeof p.tool_args.message==='string';
    if (!hasText && hasMessage) {
      p.tool_args.text=p.tool_args.message;
      delete p.tool_args.message;
    } else if (hasText && hasMessage && p.tool_args.text===p.tool_args.message) {
      delete p.tool_args.message;
    }
  }
  if (!p || Array.isArray(p) || !Array.isArray(p.thoughts) || !p.thoughts.every(x=>typeof x==='string')
    || typeof p.headline!=='string' || typeof p.tool_name!=='string' || !p.tool_name
    || !p.tool_args || typeof p.tool_args!=='object' || Array.isArray(p.tool_args)) throw new Error('Invalid Agent Zero tool envelope');
  if (p.tool_name==='response') {
    if (typeof p.tool_args.text!=='string' || !p.tool_args.text.trim()) throw new Error('Final response must have a nonempty Markdown text string');
    const unexpectedResponseFields=Object.keys(p.tool_args).filter(k=>!['text','break_loop'].includes(k));
    if (unexpectedResponseFields.length) throw new Error('Final response fields leaked outside tool_args.text: '+unexpectedResponseFields.join(', '));
    if (/^\s*\{\s*"/.test(p.tool_args.text) && !explicitJsonResponse)
      throw new Error('Final response is nested JSON instead of Markdown');
    const browserIntent=browserActionContext(body);
    if(browserIntent.requested && !browserIntent.attempted)
      throw new Error('Browser action requested but no browser tool call was attempted; call skills_tool/load if needed, then browser, before responding');
    const operationIntent=operationalActionContext(body);
    if(operationIntent.requested && !operationIntent.attempted)
      throw new Error('Operational task requested but no Agent Zero tool was attempted; execute an appropriate documented tool before responding');
    const missingRequired=operationIntent.requiredTools.filter(name=>!operationIntent.attemptedTools.includes(name));
    if(operationIntent.requested && missingRequired.length)
      throw new Error('Required tool was not attempted for the latest user task: '+missingRequired.join(', '));
    if(operationIntent.requested && operationIntent.validationRequested && !operationIntent.evidence)
      throw new Error('Verification was requested but no real tool result is present; inspect actual output/state before responding');
  }
  if (p.tool_name==='code_execution_tool') {
    // Accept the equivalent terminal vocabulary emitted by models that have
    // just used the VS Code tool. Agent Zero's legacy execution tool calls the
    // shell payload `code`, while VS Code calls it `command`.
    if (typeof p.tool_args.code!=='string' && typeof p.tool_args.command==='string') {
      p.tool_args.code=p.tool_args.command;
      delete p.tool_args.command;
    }
    if (typeof p.tool_args.runtime!=='string' && p.tool_args.action==='terminal') {
      p.tool_args.runtime='terminal';
      delete p.tool_args.action;
    }
    // Models commonly use generic runtime names even when Agent Zero documents
    // its own enum. Normalize only unambiguous aliases; never guess unknown ones.
    const runtimeAliases={bash:'terminal',shell:'terminal',sh:'terminal',javascript:'nodejs',js:'nodejs',node:'nodejs',python3:'python',py:'python'};
    if (typeof p.tool_args.runtime==='string') {
      const key=p.tool_args.runtime.trim().toLowerCase();
      p.tool_args.runtime=runtimeAliases[key] || key;
    }
    // Agent Zero casts session to int before running the command. A model's
    // descriptive session label would otherwise crash the whole tool turn.
    if (p.tool_args.session !== undefined) {
      const value=p.tool_args.session;
      p.tool_args.session=(Number.isInteger(value) && value>=0) ? value
        : (typeof value==='string' && /^\d+$/.test(value.trim())) ? Number(value.trim()) : 0;
    }
    if (!['terminal','python','nodejs','output','reset'].includes(p.tool_args.runtime)) throw new Error('Invalid execution runtime: use terminal, python, nodejs, output, or reset');
    if (!['output','reset'].includes(p.tool_args.runtime) && typeof p.tool_args.code!=='string') throw new Error('Execution tool requires code');
  }
  return JSON.stringify(p);
}

module.exports={textContent,attachmentInputs,attachmentTurnIdentity,isAgentTurn,buildPrompt,validateAnswer,systemSegments,messageHashes,toolsHash,isCurrentUserMessage,currentTurnTranscript,compactProtocolContent,compactProtocolTranscript,compactUtilitySystemContent,browserActionContext,operationalActionContext,executionSessionNotice,extractedUserText};
