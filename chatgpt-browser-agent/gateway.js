'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bridge = require('./bridge-core');
const { BrowserPool } = require('./browser-pool');
const { IncidentAuditor } = require('./incident-auditor');
const { ProviderCooldown } = require('./provider-cooldown');
const { isProviderMessageLimit, retryProviderRejection } = require('./retry-policy');
const { compactUtilityBody } = require('./utility-compactor');
const { isImageUploadTimeout, imageUploadFailureAnswer, failedUploadChatUrl, uploadedAttachmentsForTurn } = require('./image-upload');
const { isInfrastructureWorkflow } = require('./media-intent');

const PORT = Number(process.env.GATEWAY_PORT || 8000);
const SCRIPT = process.env.CHATGPT_BROWSER_SCRIPT || path.join(__dirname, 'chatgpt.js');
const STATE_DIR = process.env.CHATGPT_BROWSER_STATE_DIR || '/data';
const MODEL_ID = process.env.MODEL_ID || 'chatgpt-browser';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_PROMPT_CHARS = Number(process.env.MAX_PROMPT_CHARS || 180000);
const BROWSER_OWNS_HISTORY = String(process.env.BROWSER_OWNS_HISTORY || '').toLowerCase() === 'true';
// File uploads are unreliable on the connected ChatGPT account: the UI can
// show an enabled send button while silently rejecting the submission. Keep
// the complete prompt in the composer by default; uploads remain opt-in only.
const UPLOAD_THRESHOLD_CHARS = Number(process.env.UPLOAD_THRESHOLD_CHARS || (MAX_PROMPT_CHARS + 1));
const IDLE_RECYCLE_MS = Number(process.env.IDLE_RECYCLE_MS || 60000);
const REQUEST_TIMEOUT_MS = Number(process.env.BROWSER_REQUEST_TIMEOUT_MS || 540000);
const MEDIA_REQUEST_TIMEOUT_MS = Number(process.env.BROWSER_MEDIA_TIMEOUT_MS || 540000);
const PROVIDER_429_RETRIES = Math.max(0, Number(process.env.PROVIDER_429_RETRIES || 2));
const PROVIDER_429_RETRY_DELAY_MS = Math.max(30000, Number(process.env.PROVIDER_429_RETRY_DELAY_MS || 30000));
const BROWSER_POOL_MIN = Math.max(1, Number(process.env.BROWSER_POOL_MIN || 2));
const BROWSER_POOL_MAX = Math.max(BROWSER_POOL_MIN,Number(process.env.BROWSER_POOL_MAX || 3));
const UTILITY_SINGLE_CHAT = process.env.UTILITY_SINGLE_CHAT === 'true';
const BROWSER_POOL_IDLE_MS = Math.max(1_000, Number(process.env.BROWSER_POOL_IDLE_MS || 1_800_000));
const BROWSER_POOL_DIR = process.env.BROWSER_POOL_DIR || path.join(STATE_DIR, 'browser-pool');
const PROFILE_TEMPLATE = path.join(STATE_DIR, '.chatgpt-poc-profile');
const INCIDENTS_DIR = process.env.BROWSER_INCIDENTS_DIR || path.join(STATE_DIR,'incidents');
const A0_CHATS_DIR = process.env.A0_CHATS_DIR || '/a0/usr/chats';
const POOL_ASSIGNMENT_FILE = path.join(STATE_DIR, '.chatgpt-poc-pool-assignments.json');
const AGENT_ZERO_NOTICE_URL = process.env.AGENT_ZERO_NOTICE_URL || 'http://agent-zero/api/browser_pool_notice';
const AGENT_ZERO_NOTICE_TOKEN = process.env.AGENT_ZERO_NOTICE_TOKEN || '';
const CHATMAP_FILE = path.join(STATE_DIR, '.chatgpt-poc-chatmap.json');
const UPLOAD_COOLDOWN_FILE = path.join(STATE_DIR, '.upload-cooldown.json');
const ARTIFACT_EXTENSION_PATTERN='(?:tar\\.gz|png|jpe?g|webp|gif|pdf|docx?|xlsx?|pptx|csv|tsv|txt|md|json|xml|ya?ml|html?|svg|py|js|ts|jsx|tsx|java|c|cpp|h|hpp|cs|go|rs|php|rb|sh|ps1|bat|sql|css|toml|ini|cfg|conf|log|ipynb|zip|7z|rar|tar|tgz|gz|bz2|xz|sqlite|db|parquet|feather|npy|npz|h5|hdf5|mat|stl|obj|ply|gltf|glb|dae|dxf|wav|mp3|flac|ogg|opus|aac|mp4|mov|mkv|avi|webm|iso|bin|exe|dll|so|apk|jar)';
// ChatGPT's web composer accepts an .xls selection but can remain forever in
// its processing state without producing an assistant turn.  Agent Zero still
// receives the real multipart upload and exposes its original path to tools;
// only the unreliable duplicate upload into the browser UI is suppressed.
const BROWSER_UI_UPLOAD_BLOCKED_EXTENSIONS=new Set(['.xls']);
const providerCooldown=new ProviderCooldown({
  delayMs:PROVIDER_429_RETRY_DELAY_MS,
  directory:process.env.PROVIDER_429_COOLDOWN_DIR || '',
});

function loadJsonFile(file,fallback={}) {
  try { return JSON.parse(fs.readFileSync(file,'utf8')); }
  catch { return fallback; }
}

function saveJsonFile(file,value) {
  const temporary=`${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(temporary,file);
}

function loadChatMap() {
  return loadJsonFile(CHATMAP_FILE,{});
}

function saveChatMap(map) {
  saveJsonFile(CHATMAP_FILE,map);
}

function requestChatUrlFromError(error) {
  return String(error?.message || '').match(/CHATGPT_REQUEST_URL=(https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+)/)?.[1] || null;
}

function latestSessionChatUrl(slot) {
  try {
    const value=fs.readFileSync(path.join(slot.stateDir, '.chatgpt-poc-session'), 'utf8').trim();
    return /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function displayForSlot(slot) {
  const number=Number(String(slot.id).match(/^browser-(\d+)$/)?.[1]);
  if(!Number.isInteger(number) || number<1 || number>3) throw new Error(`Invalid browser display slot: ${slot.id}`);
  return `:${98+number}`;
}

function conversationKey(req) {
  const id=req.headers['x-a0-conversation-id'];
  const scope=req.headers['x-a0-call-scope'];
  if (!id || !scope) return null;
  if (!/^[\w:-]{1,160}$/.test(id) || !/^[\w:-]{1,160}$/.test(scope)) throw new Error('Invalid conversation identifier');
  if(UTILITY_SINGLE_CHAT && /^utility(?:[:]|$)/i.test(scope)) return 'utility-dedicated-chat-v1';
  return 'v2-'+crypto.createHash('sha256').update(JSON.stringify([id,scope])).digest('hex');
}

function runProcess(command,args,env={},timeoutMs=120_000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:__dirname,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let stdout=''; let stderr='';
    const timer=setTimeout(()=>{
      child.kill('SIGTERM');
      reject(new Error(`${path.basename(command)} ${args.join(' ')} timed out`));
    },timeoutMs);
    child.stdout.on('data',chunk=>(stdout+=chunk));
    child.stderr.on('data',chunk=>(stderr+=chunk));
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code===0) resolve({stdout,stderr});
      else reject(new Error((stderr||stdout||`${command} exited ${code}`).trim()));
    });
  });
}

async function prepareInstanceState(slot) {
  slot.stateDir=path.join(BROWSER_POOL_DIR,slot.id);
  const profileDir=path.join(slot.stateDir,'.chatgpt-poc-profile');
  fs.mkdirSync(BROWSER_POOL_DIR,{recursive:true,mode:0o700});
  if(!fs.existsSync(profileDir)) {
    if(!fs.existsSync(PROFILE_TEMPLATE)) {
      if(String(process.env.BROWSER_ALLOW_EMPTY_PROFILE||'')!=='1')
        throw new Error(`ChatGPT profile template missing: ${PROFILE_TEMPLATE}`);
      fs.mkdirSync(PROFILE_TEMPLATE,{recursive:true,mode:0o700});
      console.warn('[pool] using an empty disposable profile because BROWSER_ALLOW_EMPTY_PROFILE=1');
    }
    fs.mkdirSync(slot.stateDir,{recursive:true,mode:0o700});
    const temporary=path.join(slot.stateDir,`.profile-${crypto.randomUUID()}.tmp`);
    await runProcess('cp',['-a','--reflink=auto',PROFILE_TEMPLATE,temporary],{},180_000);
    fs.renameSync(temporary,profileDir);
    console.log(`[pool] cloned authenticated profile for ${slot.id}`);
  }
  for(const name of ['SingletonLock','SingletonCookie','SingletonSocket']) {
    try { fs.rmSync(path.join(profileDir,name),{force:true}); } catch {}
  }
  try { fs.rmSync(path.join(slot.stateDir,'.chatgpt-poc-daemon.json'),{force:true}); } catch {}
}

async function warmBrowserInstance(slot) {
  await prepareInstanceState(slot);
  await runProcess(process.execPath,[SCRIPT,'--warm'],{
    DISPLAY:displayForSlot(slot),
    CHATGPT_BROWSER_STATE_DIR:slot.stateDir,
    CHATGPT_BROWSER_OUTBOX_DIR:path.join(STATE_DIR,'outbox'),
  },120_000);
  console.log(`[pool] ${slot.id} ready`);
}

async function checkBrowserInstance(slot) {
  if(!slot.stateDir) slot.stateDir=path.join(BROWSER_POOL_DIR,slot.id);
  await runProcess(process.execPath,[SCRIPT,'--warm'],{
    DISPLAY:displayForSlot(slot),
    CHATGPT_BROWSER_STATE_DIR:slot.stateDir,
    CHATGPT_BROWSER_OUTBOX_DIR:path.join(STATE_DIR,'outbox'),
  },120_000);
}

async function stopBrowserInstance(slot) {
  if(!slot.stateDir) slot.stateDir=path.join(BROWSER_POOL_DIR,slot.id);
  await runProcess(process.execPath,[SCRIPT,'--stop'],{
    DISPLAY:displayForSlot(slot),
    CHATGPT_BROWSER_STATE_DIR:slot.stateDir,
    CHATGPT_BROWSER_OUTBOX_DIR:path.join(STATE_DIR,'outbox'),
  },30_000).catch(error=>console.warn(`[pool] stop ${slot.id}: ${error.message}`));
  console.log(`[pool] ${slot.id} stopped`);
}

async function notifyScale({slot,metadata,message}) {
  console.warn(`[pool] ${message}: ${slot.id} context=${metadata?.contextId||'unknown'}`);
  if(!AGENT_ZERO_NOTICE_TOKEN || !metadata?.contextId) return;
  try {
    const response=await fetch(AGENT_ZERO_NOTICE_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Browser-Pool-Token':AGENT_ZERO_NOTICE_TOKEN},
      body:JSON.stringify({context_id:metadata.contextId,message}),
      signal:AbortSignal.timeout(5_000),
    });
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch(error) {
    console.warn(`[pool] unable to publish scale notice to Agent Zero: ${error.message}`);
  }
}

const pool=new BrowserPool({
  minSize:BROWSER_POOL_MIN,
  maxSize:BROWSER_POOL_MAX,
  idleMs:BROWSER_POOL_IDLE_MS,
  onWarm:warmBrowserInstance,
  onStop:stopBrowserInstance,
  onCheck:checkBrowserInstance,
  onScale:notifyScale,
  loadAssignments:()=>loadJsonFile(POOL_ASSIGNMENT_FILE,{}),
  saveAssignments:value=>saveJsonFile(POOL_ASSIGNMENT_FILE,value),
});

const auditor=new IncidentAuditor({
  script:SCRIPT,
  stateRoot:INCIDENTS_DIR,
  profileTemplate:PROFILE_TEMPLATE,
  display:process.env.AUDITOR_DISPLAY || process.env.DISPLAY || ':99',
});

function safeChatName(contextId) {
  if(!/^[\w-]{1,160}$/.test(String(contextId||''))) return String(contextId||'Chat desconhecido');
  const data=loadJsonFile(path.join(A0_CHATS_DIR,contextId,'chat.json'),{});
  return String(data.name||data.title||contextId);
}

function validNoticeToken(req) {
  const supplied=String(req.headers['x-browser-pool-token']||'');
  if(!AGENT_ZERO_NOTICE_TOKEN || supplied.length!==AGENT_ZERO_NOTICE_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(AGENT_ZERO_NOTICE_TOKEN));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function resolveAttachmentPaths(refs) {
  const allowed=['/a0/usr/uploads','/a0/usr/chats','/a0/usr/whatsapp/media','/workspace'];
  const paths=[];
  let total=0;
  for(const ref of refs||[]) {
    if(typeof ref!=='string' || ref.startsWith('data:')) continue;
    const abs=path.resolve(ref);
    if(!allowed.some(root=>abs===root || abs.startsWith(root+path.sep))) throw new Error(`Attachment path is outside allowed storage: ${ref}`);
    const stat=fs.statSync(abs);
    if(!stat.isFile()) throw new Error(`Attachment is not a file: ${ref}`);
    total+=stat.size;
    if(stat.size>100*1024*1024 || total>250*1024*1024) throw new Error('Attachment size limit exceeded');
    paths.push(abs);
  }
  return [...new Set(paths)].slice(0,20);
}

function mediaEnvelope(validated, raw, artifacts) {
  if(!artifacts?.length) return validated;
  let text='Arquivos prontos.';
  try {
    const parsed=JSON.parse(validated);
    if(parsed?.tool_name==='response' && typeof parsed?.tool_args?.text==='string') text=parsed.tool_args.text;
  } catch {
    if(typeof raw==='string' && raw.trim() && raw.length<4000) text=raw.replace(/```(?:json)?/gi,'').trim();
  }
  return JSON.stringify({
    thoughts:['ChatGPT concluiu a mídia solicitada; o bridge coletou os arquivos desta resposta.'],
    headline:'Entregando arquivos gerados',
    tool_name:'chatgpt_browser_media',
    tool_args:{text,files:artifacts.map(a=>({source:a.filename,name:a.originalName,mime:a.mime,size:a.size,sha256:a.sha256}))},
  });
}

function requestedArtifactName(text) {
  const source=String(text||'');
  const filename=`([A-Za-z0-9._-]+\\.${ARTIFACT_EXTENSION_PATTERN})`;

  // Prefer an explicitly named deliverable. Prompts commonly mention Python
  // modules after the requested filename (for example `validacao.feather`
  // followed by `pyarrow.feather`). Choosing the last dotted token caused the
  // bridge to serialize the library source instead of the requested artifact.
  const named=source.match(new RegExp(`\\b(?:chamad[oa]|named)\\s+[\"'\\x60]?${filename}\\b`,'i'));
  if(named) return named[1];

  const output=source.match(new RegExp(`\\b(?:arquivo|file|anexo|attachment|sa[ií]da|output)\\b[^.!?\\n]{0,80}?${filename}\\b`,'i'));
  if(output) return output[1];

  const matches=[...source.matchAll(new RegExp(`\\b${filename}\\b`,'ig'))];
  return matches.at(-1)?.[1] || '';
}

function isNativeMediaRequest(body) {
  const nonSystem=(body.messages||[]).filter(m=>m.role!=='system');
  const users=nonSystem.filter(m=>m.role==='user' && bridge.isCurrentUserMessage(m));
  const latestHumanIndex=nonSystem.reduce((found,message,index)=>message.role==='user'&&bridge.isCurrentUserMessage(message)?index:found,-1);
  const latestMediaIndex=nonSystem.reduce((found,message,index)=>isExactMediaToolResult(message)?index:found,-1);
  // A newly appended human request wins over every earlier artifact. When the
  // media result is newer, this is only Agent Zero's post-tool closing turn.
  if(latestHumanIndex<0 || latestHumanIndex<latestMediaIndex) return false;
  const text=users.length ? bridge.extractedUserText(bridge.textContent(users.at(-1).content)) : '';
  // A long setup/build request must run through Agent Zero's tools. Mentions
  // of images, downloads or filenames inside requirements and prohibitions
  // are not a request for ChatGPT to return a single native media artifact.
  if(isInfrastructureWorkflow(text)) return false;
  // Feather generation is more reliable through Agent Zero's local Python
  // toolchain. The connected ChatGPT runtime otherwise tries to download
  // PyArrow through web search and can remain in visible processing until the
  // browser timeout. The model still decides and performs the tool call; the
  // gateway only chooses the transport path.
  // Feather and ISO need a local tool turn. ISO prompts necessarily mention
  // the file stored *inside* the image (for example MARKER.TXT); the native
  // browser path can mistake that inner member for the requested deliverable.
  // The Agent Zero executor can build and validate the container first, then
  // the compatibility envelope transports the exact outer file.
  if(/\b[A-Za-z0-9._-]+\.(?:feather|iso)\b/i.test(text)) return false;
  // Source-code/project work frequently says "create files" and lists names
  // such as index.html, compose.yaml or README.md.  Those are instructions for
  // Agent Zero's VS Code/text_editor tools, not a request for ChatGPT to emit a
  // downloadable artifact.  Keep native media available when the same request
  // explicitly asks for a visual asset or an attachment/download delivery.
  const programmingWorkflow=/\b(?:vs\s*code|vscode|workspace|text_editor|terminal|dockerfile|docker\s+compose|compose\.ya?ml|git|commit|projeto|project|c[oó]digo|codebase|aplica(?:ção|cao)|application)\b/i.test(text);
  const explicitVisualMedia=/\b(?:gere|gerar|crie|criar|edite|editar|modifique|produza|generate|create|edit|modify|produce)\b[^.!?\n]{0,140}\b(?:imagem|imagens|foto|fotos|ilustra(?:ção|cao|ções|coes)|image|images|picture|pictures)\b/i.test(text);
  const explicitAttachmentDelivery=/\b(?:anexe|anexo|attachment|baix[aá]vel|downloadable|download|entregue\s+(?:o\s+)?arquivo|retorne\s+(?:o\s+)?arquivo|attach)\b/i.test(text);
  if(programmingWorkflow && !explicitVisualMedia && !explicitAttachmentDelivery) return false;
  const media='(?:imagem|imagens|foto|fotos|ilustra(?:ção|cao|ções|coes)|image|images|picture|pictures|pdf|zip|arquivo|file)';
  const explicitAction=new RegExp(`\\b(?:gere|gerar|crie|criar|edite|editar|modifique|produza|generate|create|edit|modify|produce)\\b[^.!?\\n]{0,140}\\b${media}\\b`,'i');
  const directMake=new RegExp(`\\b(?:faça|faca)\\b\\s+(?:(?:para\\s+mim)\\s+)?(?:(?:uma?|o|a|duas?|dois|esta?|esse?|essa?)\\s+){0,2}\\b${media}\\b`,'i');
  // A request can name the output directly ("regenere validacao.feather")
  // without repeating the generic word "arquivo". Treat only creation-style
  // verbs as native artifact generation here; deliberately exclude "editar"
  // so ordinary requests to edit source files remain Agent Zero tool tasks.
  const explicitFilenameGeneration=new RegExp(`\\b(?:gere|gerar|crie|criar|produza|recrie|regenere|generate|create|produce|recreate|regenerate)\\b[^.!?\\n]{0,180}\\b[\\w.-]+\\.${ARTIFACT_EXTENSION_PATTERN}\\b`,'i');
  // Route only an explicit media creation/edit instruction. Generic verbs such
  // as "faça" must directly govern the media object; merely discussing a
  // reference image/file elsewhere in the sentence is not a native-media task.
  return text.split(/(?:[.!?]+\s+|\n+)/).some(clause=>explicitAction.test(clause) || directMake.test(clause) || explicitFilenameGeneration.test(clause));
}

function isExactMediaToolResult(message) {
  if(message?.role!=='user') return false;
  const content=bridge.textContent(message.content);
  // A fresh user retry can be appended to the failed media tool envelope in
  // the same protocol item. It is a new task, not the closing follow-up for
  // the old tool call.
  if(/\}\s*\{\s*["']user_message["']\s*:/s.test(content)) return false;
  try {
    const parsed=JSON.parse(content);
    if(!parsed || typeof parsed!=='object' || !Object.hasOwn(parsed,'tool_result')) return false;
    const result=parsed.tool_result;
    const outer=String(parsed._tool_name||parsed.tool_name||'').toLowerCase();
    const inner=result && typeof result==='object' ? String(result._tool_name||result.tool_name||'').toLowerCase() : '';
    return outer==='chatgpt_browser_media' || inner==='chatgpt_browser_media';
  } catch {
    // Some Agent Zero serializers emit a Python-repr-like outer envelope.
    // Match only when chatgpt_browser_media is the first top-level tool_name;
    // this cannot confuse later memory text that merely quotes an old result.
    return /^\s*\{\s*["']tool_name["']\s*:\s*["']chatgpt_browser_media["']\s*,\s*["']tool_result["']\s*:/i.test(content);
  }
}

function protocolDebug(body) {
  return (body.messages||[]).filter(message=>message.role!=='system').slice(-8).map(message=>{
    const content=bridge.textContent(message.content);
    let keys=[]; try { const parsed=JSON.parse(content); keys=parsed&&typeof parsed==='object'?Object.keys(parsed).slice(0,12):[]; } catch {}
    const userAt=content.lastIndexOf('"user_message"');
    const toolAt=content.lastIndexOf('"tool_result"');
    return {role:message.role,name:message.name||'',current:message.role==='user'&&bridge.isCurrentUserMessage(message),media:isExactMediaToolResult(message),keys,length:content.length,userAt,toolAt,boundary:userAt>=0?content.slice(Math.max(0,userAt-65),userAt+20).replace(/\s+/g,' '):'',snippet:content.replace(/\s+/g,' ').slice(0,260)};
  });
}

function isMediaToolFollowup(body) {
  const messages=(body.messages||[]).filter(message=>message.role!=='system');
  const latestHumanIndex=messages.reduce((found,message,index)=>message.role==='user'&&bridge.isCurrentUserMessage(message)?index:found,-1);
  const latestMediaIndex=messages.reduce((found,message,index)=>isExactMediaToolResult(message)?index:found,-1);
  return latestMediaIndex>latestHumanIndex;
}

function nativeMediaPrompt(body) {
  const users=(body.messages||[]).filter(m=>m.role==='user' && bridge.isCurrentUserMessage(m));
  const text=users.length ? bridge.extractedUserText(bridge.textContent(users.at(-1).content)) : '';
  return `Handle the following latest Agent Zero user request directly. You may use ChatGPT's native image/file analysis, image generation, or image editing as appropriate. Never use Meta AI. Any user attachments are uploaded with this prompt. Preserve the user's exact requested content and number of outputs. Save every requested output under /mnt/data using the exact requested filename. Your final response MUST expose every output as a real clickable Markdown sandbox link in the form [Download filename](sandbox:/mnt/data/filename); a plain /mnt/data path, a citation without a download link, source code, or a claim that the file was attached is not sufficient. After those clickable links, add only one short completion sentence.\n\nUSER REQUEST:\n${text}`;
}

async function runBrowser(slot, prompt, chatUrl, options={}) {
  await providerCooldown.wait();
  if(options.deadline && Date.now()>=options.deadline-1_000)
    throw new Error('Browser request safety deadline reached; submitted turn was not resent');
  return new Promise((resolve, reject) => {
    const timeoutMs=Math.max(1_000,Math.min(
      Number(options.timeoutMs)||REQUEST_TIMEOUT_MS,
      options.deadline ? options.deadline-Date.now() : Number.POSITIVE_INFINITY,
    ));
    let contextFile=null;
    const args=[SCRIPT];
    if (chatUrl) {
      args.push('--chat-url', chatUrl);
    } else {
      args.push('--new');
    }
    args.push('--raw-stdin');
    for(const uploadPath of options.uploadPaths||[]) args.push('--upload',uploadPath);
    if(prompt.length>UPLOAD_THRESHOLD_CHARS) {
      let until=0;
      try { until=JSON.parse(fs.readFileSync(UPLOAD_COOLDOWN_FILE,'utf8')).until || 0; } catch {}
      if (until>Date.now()) return reject(new Error(`UPLOAD_RATE_LIMIT retry_after_seconds=${Math.ceil((until-Date.now())/1000)}; provider upload quota exhausted`));
      contextFile=path.join(slot.stateDir,`context-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(contextFile,prompt,{mode:0o600});
      args.push('--upload',contextFile);
    }
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        DISPLAY:displayForSlot(slot),
        CHATGPT_BROWSER_STATE_DIR: slot.stateDir,
        CHATGPT_BROWSER_OUTBOX_DIR: path.join(STATE_DIR, 'outbox'),
        BROWSER_RECOVERY_RELOAD: options.reloadBeforeAttempt ? '1' : '0',
        BROWSER_REQUEST_TIMEOUT_MS: String(timeoutMs),
        BROWSER_EXPECTED_ARTIFACT: options.expectedArtifact || '',
        A0_CONTEXT_ID: options.contextId || '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => {});
    child.stdin.end(contextFile
      ? 'Read the attached context text file completely. It contains the current caller instructions and conversation for an external Agent Zero runtime. Produce ONLY its next assistant response, following its tool protocol, as ONE fenced json code block. Do not summarize the file or execute actions in ChatGPT. Preserve the latest user task and use the actual documented tools via JSON.'
      : prompt);
    const cleanup=()=>{if(contextFile) {try {fs.unlinkSync(contextFile);}catch{}}};
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('ChatGPT browser request timed out'));
    }, timeoutMs+10_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => { clearTimeout(timer); cleanup(); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0) {
        const message=(stderr || stdout || `process exited ${code}`).trim();
        if(isProviderMessageLimit(message)) providerCooldown.block();
        const limit=message.match(/UPLOAD_RATE_LIMIT retry_after_seconds=(\d+)/);
        if(limit) fs.writeFileSync(UPLOAD_COOLDOWN_FILE,JSON.stringify({until:Date.now()+Number(limit[1])*1000}),{mode:0o600});
        return reject(new Error(message));
      }
      const match = stdout.match(/--- RESPONSE ---\s*([\s\S]*?)\s*--- END ---/);
      if (!match) return reject(new Error('Could not parse browser response'));
      const artifactMatch=stdout.match(/--- ARTIFACTS ---\s*([\s\S]*?)\s*--- END ARTIFACTS ---/);
      let artifacts=[];
      if(artifactMatch) { try { artifacts=JSON.parse(artifactMatch[1]); } catch {} }
      const returnedChatUrl=stdout.match(/--- CHAT URL ---\s*(https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+)\s*--- END CHAT URL ---/)?.[1] || null;
      resolve({raw:match[1].trim(),artifacts:Array.isArray(artifacts)?artifacts:[],chatUrl:returnedChatUrl});
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(body));
}

function usage(prompt, answer) {
  const input = Math.ceil(prompt.length / 4);
  const output = Math.ceil(answer.length / 4);
  return {prompt_tokens: input, completion_tokens: output, total_tokens: input + output};
}

function openAiResponse(answer, prompt) {
  return {
    id: `chatcmpl-browser-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{index: 0, message: {role: 'assistant', content: answer}, finish_reason: 'stop'}],
    usage: usage(prompt, answer),
  };
}

function streamResponse(res, answer) {
  const id = `chatcmpl-browser-${Date.now()}`;
  if(!res.headersSent) res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
  res.write(`data: ${JSON.stringify({id, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model:MODEL_ID, choices:[{index:0, delta:{role:'assistant', content:answer}, finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model:MODEL_ID, choices:[{index:0, delta:{}, finish_reason:'stop'}]})}\n\n`);
  res.end('data: [DONE]\n\n');
}

function beginStreamHeartbeat(res) {
  if(!res.headersSent) res.writeHead(200, {
    'Content-Type':'text/event-stream',
    'Cache-Control':'no-cache, no-transform',
    Connection:'keep-alive',
    'X-Accel-Buffering':'no',
  });
  // Comments are valid SSE frames. They contain no model output, but prevent
  // aiohttp/OpenAI-compatible clients from closing a healthy long operation.
  res.write(': browser-processing\n\n');
  const timer=setInterval(()=>{
    if(res.destroyed||res.writableEnded) return clearInterval(timer);
    res.write(': browser-processing\n\n');
  },10_000);
  timer.unref?.();
  return timer;
}

function streamError(res,error) {
  const payload={error:{message:String(error?.message||error),type:'browser_error',code:'browser_error'}};
  if(!res.headersSent) res.writeHead(500,{'Content-Type':'application/json'});
  if(String(res.getHeader('Content-Type')||'').startsWith('text/event-stream')) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if(req.method==='POST' && req.url==='/v1/audit-chat') {
    try {
      if(!validNoticeToken(req)) return json(res,403,{success:false,error:'Invalid audit token'});
      const input=await readJson(req);
      const contextId=String(input.context_id||'');
      if(!/^[\w-]{1,160}$/.test(contextId)) return json(res,400,{success:false,error:'Invalid context ID'});
      const auditInputName=String(input.audit_input||'');
      if(!/^audit-context-[a-f0-9-]{36}\.json$/.test(auditInputName))
        return json(res,400,{success:false,error:'Invalid audit input'});
      const auditContextFile=path.resolve(INCIDENTS_DIR,'audit-inputs',auditInputName);
      const auditInputsRoot=path.resolve(INCIDENTS_DIR,'audit-inputs')+path.sep;
      if(!auditContextFile.startsWith(auditInputsRoot) || !fs.existsSync(auditContextFile))
        return json(res,404,{success:false,error:'Prepared audit input was not found'});
      const queued=auditor.enqueue({
        chatId:contextId,
        chatName:String(input.chat_name||safeChatName(contextId)).slice(0,300),
        auditContextFile,
        question:'Auditoria manual solicitada pelo botão “Chat com erro”.',
        response:'O histórico completo e o estado visível da interface foram anexados à análise.',
        events:['Auditoria iniciada manualmente pelo usuário.'],
        manual:true,
      },{force:true});
      return json(res,202,{success:true,queued:Boolean(queued),auditor:auditor.snapshot()});
    } catch(error) {
      return json(res,500,{success:false,error:String(error.message||error)});
    }
  }
  if(req.method==='POST' && req.url==='/v1/preview-route') {
    try {
      const input=await readJson(req);
      const contextId=String(input.context_id||'');
      if(!/^[\w-]{1,160}$/.test(contextId)) return json(res,400,{error:'Invalid context ID'});
      const chatHash='v2-'+crypto.createHash('sha256').update(JSON.stringify([contextId,'main:0'])).digest('hex');
      const chatUrl=loadChatMap()[chatHash];
      if(!chatUrl) return json(res,200,{status:'unmapped'});
      let slotId=pool.assignments[chatHash];
      if(!slotId) {
        const candidates=[...pool.slots.values()].filter(item=>Number(String(item.id).match(/^browser-(\d+)$/)?.[1])<=3);
        const existing=candidates.find(item=>latestSessionChatUrl(item)===chatUrl);
        const selected=existing||candidates.sort((a,b)=>Number(b.state==='ready')-Number(a.state==='ready')
          ||Number(a.busy)-Number(b.busy)||a.queued-b.queued||a.lastUsed-b.lastUsed)[0];
        if(!selected) return json(res,200,{status:'warming'});
        slotId=selected.id;
        pool.assignments[chatHash]=slotId;
        pool.saveAssignments(pool.assignments);
      }
      const slot=pool.slots.get(slotId);
      const index=Number(String(slotId).match(/^browser-(\d+)$/)?.[1]);
      if(!slot||!Number.isInteger(index)||index<1||index>3) return json(res,200,{status:'unavailable'});
      const daemon=loadJsonFile(path.join(BROWSER_POOL_DIR,slotId,'.chatgpt-poc-daemon.json'),{});
      if(!Number.isInteger(daemon.port)||daemon.port<1||daemon.port>65535)
        return json(res,200,{status:'warming',slot:index});
      const base=`http://127.0.0.1:${daemon.port}`;
      let state=await fetch(`${base}/status`,{signal:AbortSignal.timeout(3000)}).then(r=>r.json());
      if(state.url!==chatUrl) {
        if(state.busy||slot.busy||slot.queued) return json(res,200,{status:'busy',slot:index});
        const focus=await fetch(`${base}/focus`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatUrl}),signal:AbortSignal.timeout(35000)});
        state=await focus.json();
      }
      return json(res,200,{status:state.url===chatUrl?'ready':'busy',slot:index});
    } catch(error) { return json(res,503,{status:'unavailable',error:error.message}); }
  }
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
    const profile = fs.existsSync(path.join(STATE_DIR, '.chatgpt-poc-profile'));
    const session = fs.existsSync(path.join(STATE_DIR, '.chatgpt-poc-session'));
    const slots=pool.snapshot();
    const permanentReady=slots.filter(slot=>slot.permanent && slot.state==='ready').length;
    return json(res, permanentReady>=BROWSER_POOL_MIN ? 200 : 503, {
      status:permanentReady>=BROWSER_POOL_MIN?'ok':'warming',
      profile,
      session,
      minimum:BROWSER_POOL_MIN,
      idleTimeoutMs:BROWSER_POOL_IDLE_MS,
      slots,
      auditor:auditor.snapshot(),
    });
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    return json(res, 200, {object:'list', data:[{id:MODEL_ID, object:'model', created:0, owned_by:'chatgpt-browser-agent'}]});
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let streamHeartbeat=null;
    let requestCallScope='';
    try {
      const body = await readJson(req);
      if(body.stream) streamHeartbeat=beginStreamHeartbeat(res);
      let prompt = '';
      
      const chatHash = conversationKey(req);
      const contextId=String(req.headers['x-a0-conversation-id']||'');
      const callScope=String(req.headers['x-a0-call-scope']||'');
      requestCallScope=callScope;
      let chatUrl = null;
      
      const answer = await pool.run(chatHash,{contextId,callScope},async slot => {
        if (chatHash) chatUrl = loadChatMap()[chatHash] || null;
        const utilityCall=/^utility(?:[:]|$)/i.test(callScope);
        const stateFile=chatHash && !utilityCall ? path.join(STATE_DIR,chatHash+'-segments.json') : null;
        let known=new Set();
        let transportState=null;
        if (chatUrl && stateFile) {
          try {
            const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));
            if(state.url===chatUrl) {
              transportState=state;
              known=new Set(state.ids);
            }
          } catch {}
        }
        if(/^main(?:[:]|$)/i.test(callScope)) console.log('[protocol-debug] '+JSON.stringify(protocolDebug(body)));
        // The media tool has already copied and exposed the files. Agent Zero
        // performs one post-tool model call solely to obtain a closing answer;
        // satisfy it locally so the browser never regenerates the same file,
        // spends another provider message, or races the user's next request.
        if(/^main(?:[:]|$)/i.test(callScope) && isMediaToolFollowup(body)) {
          prompt='[local media tool completion]';
          return JSON.stringify({
            thoughts:['O resultado real da ferramenta de mídia já foi entregue.'],
            headline:'Arquivo entregue',
            tool_name:'response',
            tool_args:{text:'Arquivo pronto e disponível na conversa.'},
          });
        }
        let requestBody=body;
        if(utilityCall && UTILITY_SINGLE_CHAT) {
          const reduced=await compactUtilityBody(body,async chunkPrompt=>{
            let result;
            for(let attempt=0;;attempt++) {
              try {
                result=await runBrowser(slot,chunkPrompt,chatUrl,{
                  timeoutMs:REQUEST_TIMEOUT_MS,
                  reloadBeforeAttempt:attempt>0,
                });
                break;
              } catch(error) {
                if(!retryProviderRejection(error,attempt,PROVIDER_429_RETRIES)) throw error;
                if(!chatUrl) chatUrl=requestChatUrlFromError(error) || latestSessionChatUrl(slot);
                if(!chatUrl) throw new Error('Utility 429 recovery refused: the dedicated chat URL is unknown');
                console.warn(`[utility-compaction] provider 429; retry ${attempt+1}/${PROVIDER_429_RETRIES} after ${PROVIDER_429_RETRY_DELAY_MS}ms`);
                await providerCooldown.wait();
              }
            }
            if(!chatUrl) {
              chatUrl=latestSessionChatUrl(slot);
              if(chatUrl && chatHash) {
                const chatMap=loadChatMap();
                chatMap[chatHash]=chatUrl;
                saveChatMap(chatMap);
              }
            }
            if(!chatUrl) throw new Error('Dedicated utility chat URL missing after context chunk');
            return result.raw;
          });
          requestBody=reduced.body;
          if(reduced.compacted) console.log(`[utility-compaction] source_chars=${reduced.inputChars} chunks=${reduced.chunks} final_chars=${JSON.stringify(requestBody.messages).length}`);
        }
        const turnTimeoutMs=isNativeMediaRequest(body)?MEDIA_REQUEST_TIMEOUT_MS:REQUEST_TIMEOUT_MS;
        const nativeMedia=isNativeMediaRequest(body) && /^main(?:[:]|$)/i.test(callScope);
        prompt=nativeMedia ? nativeMediaPrompt(body) : bridge.buildPrompt(requestBody,MAX_PROMPT_CHARS,utilityCall ? null : (chatHash ? known : null),utilityCall ? null : transportState,{browserOwnsHistory:BROWSER_OWNS_HISTORY,callScope,preserveUtilityContext:UTILITY_SINGLE_CHAT});
        const allAttachmentRefs=/^main(?:[:]|$)/i.test(callScope) ? bridge.attachmentInputs(body,transportState,{browserOwnsHistory:BROWSER_OWNS_HISTORY}) : [];
        const attachmentTurnId=bridge.attachmentTurnIdentity(body);
        const latestActualUser=[...(body.messages||[])].reverse().find(message=>message.role==='user' && bridge.isCurrentUserMessage(message));
        const latestUserHash=latestActualUser ? bridge.messageHashes({messages:[latestActualUser]})[0] : null;
        const alreadyUploaded=new Set(uploadedAttachmentsForTurn(transportState,attachmentTurnId,latestUserHash));
        const attachmentRefs=allAttachmentRefs.filter(ref=>!alreadyUploaded.has(ref));
        const uploadPaths=resolveAttachmentPaths(attachmentRefs);
        const browserUploadPaths=uploadPaths.filter(filePath=>!BROWSER_UI_UPLOAD_BLOCKED_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
        const latestUserText=latestActualUser ? bridge.extractedUserText(bridge.textContent(latestActualUser.content)) : '';
        // Merely mentioning an attached filename is not a request to create or
        // return that file.  Artifact recovery/base64 compatibility belongs
        // only to the explicit native creation/editing route.
        const expectedArtifact=nativeMedia ? requestedArtifactName(latestUserText) : '';
        if(uploadPaths.length && !nativeMedia) {
          prompt += `\n\nATTACHMENT PATH CONTRACT: The same uploaded files are available to Agent Zero tools at these exact original paths: ${JSON.stringify(uploadPaths)}. ChatGPT's UI may rename its private copy under /mnt/data; never use that private /mnt/data name in an Agent Zero tool call. When inspection or project work requires a tool, use the exact original path above. Do not reproduce, return, encode, or attach the input file unless the latest user explicitly asks for an output copy.`;
        }
        console.log(`[transport] slot=${slot.id} context=${contextId||'none'} scope=${callScope||'none'} mapped=${Boolean(chatUrl)} state=${Boolean(transportState)} prompt_chars=${prompt.length} attachments=${uploadPaths.length} browser_uploads=${browserUploadPaths.length} attachment_refs=${JSON.stringify(allAttachmentRefs)} latest_user=${JSON.stringify(latestUserText.slice(0,240))}`);
        let browserResult;
        // One wall-clock budget covers the initial browser call, one recovery,
        // and artifact-link exposure. Previously each phase received a fresh
        // full timeout, so a nominal 330-second media request could run for
        // more than twice that duration.
        const requestDeadline=Date.now()+turnTimeoutMs;
        const remainingBudget=()=>Math.max(1_000,requestDeadline-Date.now());
        // One submission per attempt. A timeout is an inconclusive result,
        // not evidence that the provider rejected the user turn. Retrying a
        // timed-out but still-running turn used to duplicate user messages.
        let promptToSend=prompt;
        const runAttempt=(reloadBeforeAttempt=false) => runBrowser(slot,promptToSend,chatUrl,{
          reloadBeforeAttempt,
          timeoutMs:remainingBudget(),
          deadline:requestDeadline,
          uploadPaths:reloadBeforeAttempt?[]:browserUploadPaths,
          expectedArtifact:nativeMedia?'':expectedArtifact,
          contextId,
        });
        let emptyRetry=0;
        for(let rateAttempt=0;;) {
          try {
            browserResult=await runAttempt(rateAttempt>0 || emptyRetry>0);
            break;
          } catch(error) {
            if(isImageUploadTimeout(error)) {
              // A failed first upload never created a ChatGPT turn. The
              // slot's global session pointer may belong to another Agent
              // Zero chat, so never bind this conversation to that pointer.
              const failedUrl=failedUploadChatUrl(chatUrl,requestChatUrlFromError(error));
              if(chatHash && failedUrl) {
                const map=loadChatMap();
                if(!map[chatHash]) {map[chatHash]=failedUrl;saveChatMap(map);}
                if(stateFile) {
                  const next={...(transportState||{}),url:failedUrl,ids:[...known],
                    // A failed upload was never accepted by ChatGPT. Keep
                    // previously completed uploads, but permit an explicit
                    // future user turn to retry this same image.
                    attachmentTurnId,uploadedAttachments:[...alreadyUploaded]};
                  saveJsonFile(stateFile,next);
                }
              }
              return JSON.stringify(imageUploadFailureAnswer());
            }
            if(/ChatGPT completed an empty assistant turn/i.test(error.message)
              && emptyRetry<1 && !nativeMedia && browserUploadPaths.length===0
              && remainingBudget()>30_000) {
              if(!chatUrl) chatUrl=requestChatUrlFromError(error);
              if(!chatUrl) throw new Error('Empty-response recovery refused: the original ChatGPT chat URL is unknown');
              emptyRetry++;
              // The prior assistant turn has a final Copy action and no
              // content. It cannot be an active generation. Retry only once
              // in this same mapped chat, without replaying the long prompt.
              promptToSend='The immediately preceding Agent Zero transport request received an empty completed assistant turn. Answer that same request now. Return exactly one complete Agent Zero JSON object inside one fenced json code block. Do not claim a tool ran unless its actual result was supplied in the transcript.';
              console.warn('[empty-response] completed blank assistant turn; reloading and retrying once in the same conversation');
              continue;
            }
            if(!retryProviderRejection(error,rateAttempt,PROVIDER_429_RETRIES)) throw error;
            if(!chatUrl) chatUrl=requestChatUrlFromError(error);
            if(!chatUrl) throw new Error('Provider 429 retry refused: the current ChatGPT chat URL is unknown');
            console.warn(`[provider-429] attempt ${rateAttempt+1}/${PROVIDER_429_RETRIES} failed; waiting ${PROVIDER_429_RETRY_DELAY_MS}ms, then reloading the same chat and retrying`);
            await providerCooldown.wait();
            rateAttempt++;
          }
        }
        if (/^main(?:[:]|$)/i.test(callScope) && chatHash) {
          const returnedUrl=browserResult.chatUrl;
          if(!returnedUrl) throw new Error('Browser did not confirm the request conversation URL; refusing to guess from another tab');
          if(chatUrl && returnedUrl!==chatUrl) throw new Error('Browser returned a different conversation URL; refusing cross-chat response');
          if(!chatUrl) {
            const chatMap=loadChatMap();
            if(chatMap[chatHash] && chatMap[chatHash]!==returnedUrl) throw new Error('Conversation binding changed during request');
            chatMap[chatHash]=returnedUrl;
            saveChatMap(chatMap);
            chatUrl=returnedUrl;
            console.log(`[chatmap] Saved new chat for hash ${chatHash}: ${returnedUrl}`);
          }
        }
        const remember=()=>{
          if(stateFile && chatUrl) {
            for(const s of bridge.systemSegments(body)) known.add(s.id);
            fs.writeFileSync(stateFile,JSON.stringify({
              url:chatUrl,
              ids:[...known],
              messageHashes:bridge.messageHashes(body),
              toolsHash:bridge.toolsHash(body),
              attachmentIdentityVersion:2,
              attachmentTurnId,
              uploadedAttachments:[...new Set([...alreadyUploaded,...allAttachmentRefs])],
            }),{mode:0o600});
          }
        };
        let raw=browserResult.raw;
        let artifacts=browserResult.artifacts||[];
        if(nativeMedia && !artifacts.length) {
          const createdPath=(raw.match(/\/mnt\/data\/[^\s)\]>'"]+/)||[])[0]||'';
          const exposePrompt=createdPath
            ? `The file already exists at ${createdPath}. Do not recreate or modify it. Return a real clickable Markdown download link exactly in this form: [Download ${createdPath.split('/').pop()}](sandbox:${createdPath}). Then add one short completion sentence.`
            : 'The requested file was not exposed as a downloadable artifact. Do not repeat unrelated work. Locate the file you just created under /mnt/data and return it as a real clickable Markdown sandbox:/mnt/data link. If it is missing, recreate it once with the exact requested filename and then expose that clickable link.';
          console.warn(`[media-recovery] No downloadable artifact in completed response; requesting one link exposure${createdPath?` for ${createdPath}`:''}`);
          if(remainingBudget()<=5_000) throw new Error('Browser request exhausted its total media budget before artifact-link recovery');
          const recovered=await runBrowser(slot,exposePrompt,chatUrl,{timeoutMs:remainingBudget(),uploadPaths:[],expectedArtifact:''});
          if(recovered.artifacts?.length) {
            raw=recovered.raw;
            artifacts=recovered.artifacts;
          } else throw new Error('ChatGPT concluiu a solicitação de mídia, mas nenhum arquivo baixável foi encontrado após a recuperação única');
        }
        try { const result=bridge.validateAnswer(raw, requestBody,{callScope}); remember(); return mediaEnvelope(result,raw,artifacts); }
        catch (error) {
          if(artifacts.length && /^main(?:[:]|$)/i.test(callScope)) { remember(); return mediaEnvelope('',raw,artifacts); }
          console.warn('Response format retry:', error.message);
          if(remainingBudget()<=5_000) throw new Error('Browser request exhausted its safety budget before format recovery');
          const retry = await runBrowser(slot,prompt+'\n\nYour previous attempt had this format error: '+error.message+'. Generate the next response again as valid JSON, preserving the latest user task.', chatUrl,{timeoutMs:remainingBudget(),uploadPaths:[],expectedArtifact:nativeMedia?'':expectedArtifact});
          const result=bridge.validateAnswer(retry.raw, requestBody,{callScope}); remember(); return mediaEnvelope(result,retry.raw,retry.artifacts||[]);
        }
      });
      if(streamHeartbeat) { clearInterval(streamHeartbeat); streamHeartbeat=null; }
      if (body.stream) return streamResponse(res, answer);
      return json(res, 200, openAiResponse(answer, prompt));
    } catch (error) {
      if(streamHeartbeat) { clearInterval(streamHeartbeat); streamHeartbeat=null; }
      // A first request may have created its ChatGPT conversation and then
      // failed while reading the response. Preserve that exact request URL so
      // the next Agent Zero retry cannot open an unrelated new conversation.
      if(/^main(?:[:]|$)/i.test(requestCallScope)) {
        const failedChatHash=conversationKey(req);
        const failedChatUrl=requestChatUrlFromError(error);
        if(failedChatHash && failedChatUrl) {
          const map=loadChatMap();
          if(!map[failedChatHash]) {
            map[failedChatHash]=failedChatUrl;
            saveChatMap(map);
            console.warn(`[chatmap] Preserved failed-request binding for ${failedChatHash}: ${failedChatUrl}`);
          }
        }
      }
      if(res.headersSent) {
        return streamError(res,error);
      }
      const rate=error.message.match(/UPLOAD_RATE_LIMIT retry_after_seconds=(\d+)/);
      if(rate) {
        res.setHeader('Retry-After',rate[1]);
        return json(res,429,{error:{message:error.message,type:'rate_limit_error'}});
      }
      if (/Messages limit reached|reached your (?:message|usage) limit|Limite de mensagens (?:atingido|alcançado)|Too many requests|temporarily limited access to your conversations/i.test(error.message)) {
        res.setHeader('Retry-After','14400');
        return json(res,429,{error:{message:'A conta ChatGPT conectada atingiu o limite de mensagens do provedor. Nenhuma mensagem foi enviada; tente novamente após o horário de reset exibido no navegador.',type:'rate_limit_error',code:'provider_message_limit'}});
      }
      if (/message you submitted was too long|Context exceeds browser bridge limit/i.test(error.message))
      {
        return json(res,400,{error:{message:'Context too large. Compact this conversation before retrying. No tool was executed by this request.',type:'invalid_request_error',code:'context_length_exceeded'}});
      }
      return json(res, 502, {error:{message:error.message, type:'browser_agent_error'}});
    }
  }
  return json(res, 404, {error:{message:'not found', type:'not_found'}});
});

async function startGateway() {
  await pool.start();
  server.listen(PORT,'0.0.0.0',()=>{
    console.log(`OpenAI-compatible browser gateway listening on ${PORT} with ${BROWSER_POOL_MIN} permanent browser instances`);
  });
}

startGateway().catch(error=>{
  console.error(`[pool] gateway startup failed: ${error.stack||error.message}`);
  process.exit(1);
});

// Finish accepted requests (including background memory) before Docker stops
// the browser. Abrupt termination used to disconnect live Utility requests.
let shuttingDown=false;
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown=true;
  console.log('Graceful shutdown: draining accepted requests');
  server.close(async()=>{
    await Promise.allSettled([pool.shutdown(),auditor.shutdown()]);
    process.exit(0);
  });
});
