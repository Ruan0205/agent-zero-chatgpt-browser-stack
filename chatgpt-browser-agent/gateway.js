'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bridge = require('./bridge-core');

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
const REQUEST_TIMEOUT_MS = Number(process.env.BROWSER_REQUEST_TIMEOUT_MS || 130000);
const PROVIDER_429_RETRIES = Math.max(0, Number(process.env.PROVIDER_429_RETRIES || 2));
const PROVIDER_429_RETRY_DELAY_MS = Math.max(0, Number(process.env.PROVIDER_429_RETRY_DELAY_MS || 30000));
const CHATMAP_FILE = path.join(STATE_DIR, '.chatgpt-poc-chatmap.json');
const UPLOAD_COOLDOWN_FILE = path.join(STATE_DIR, '.upload-cooldown.json');
let queueTail = Promise.resolve();
let queued = 0;
let active = false;
let recycleTimer = null;

function loadChatMap() {
  try {
    const raw = fs.readFileSync(CHATMAP_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveChatMap(map) {
  fs.writeFileSync(CHATMAP_FILE, JSON.stringify(map, null, 2), {mode: 0o600});
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isProviderMessageLimit(error) {
  return /Messages limit reached|reached your (?:message|usage) limit|Limite de mensagens (?:atingido|alcançado)|provider_message_limit/i.test(String(error?.message || error || ''));
}

function requestChatUrlFromError(error) {
  return String(error?.message || '').match(/CHATGPT_REQUEST_URL=(https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+)/)?.[1] || null;
}

function latestSessionChatUrl() {
  try {
    const value=fs.readFileSync(path.join(STATE_DIR, '.chatgpt-poc-session'), 'utf8').trim();
    return /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function conversationKey(req) {
  const id=req.headers['x-a0-conversation-id'];
  const scope=req.headers['x-a0-call-scope'];
  if (!id || !scope) return null;
  if (!/^[\w:-]{1,160}$/.test(id) || !/^[\w:-]{1,160}$/.test(scope)) throw new Error('Invalid conversation identifier');
  return 'v2-'+crypto.createHash('sha256').update(JSON.stringify([id,scope])).digest('hex');
}

function cancelRecycle() {
  if (recycleTimer) clearTimeout(recycleTimer);
  recycleTimer = null;
}

function scheduleRecycle() {
  cancelRecycle();
  if (IDLE_RECYCLE_MS <= 0) return;
  recycleTimer = setTimeout(() => {
    recycleTimer = null;
    if (active || queued > 0) return;
    const child = spawn(process.execPath, [SCRIPT, '--stop'], {
      cwd: __dirname,
      env: process.env,
      stdio: 'ignore',
    });
    child.unref();
  }, IDLE_RECYCLE_MS);
  recycleTimer.unref();
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

function runBrowser(prompt, chatUrl, options={}) {
  return new Promise((resolve, reject) => {
    const timeoutMs=Math.max(1_000,Number(options.timeoutMs)||REQUEST_TIMEOUT_MS);
    let contextFile=null;
    const args=[SCRIPT];
    if (chatUrl) {
      args.push('--chat-url', chatUrl);
    } else {
      args.push('--new');
    }
    args.push('--raw-stdin');
    if(prompt.length>UPLOAD_THRESHOLD_CHARS) {
      let until=0;
      try { until=JSON.parse(fs.readFileSync(UPLOAD_COOLDOWN_FILE,'utf8')).until || 0; } catch {}
      if (until>Date.now()) return reject(new Error(`UPLOAD_RATE_LIMIT retry_after_seconds=${Math.ceil((until-Date.now())/1000)}; provider upload quota exhausted`));
      contextFile=path.join(STATE_DIR,`context-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(contextFile,prompt,{mode:0o600});
      args.push('--upload',contextFile);
    }
    const child = spawn(process.execPath, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        BROWSER_RECOVERY_RELOAD: options.reloadBeforeAttempt ? '1' : '0',
        BROWSER_REQUEST_TIMEOUT_MS: String(timeoutMs),
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
        const limit=message.match(/UPLOAD_RATE_LIMIT retry_after_seconds=(\d+)/);
        if(limit) fs.writeFileSync(UPLOAD_COOLDOWN_FILE,JSON.stringify({until:Date.now()+Number(limit[1])*1000}),{mode:0o600});
        return reject(new Error(message));
      }
      const match = stdout.match(/--- RESPONSE ---\s*([\s\S]*?)\s*--- END ---/);
      if (!match) return reject(new Error('Could not parse browser response'));
      resolve(match[1].trim());
    });
  });
}

function enqueue(work) {
  cancelRecycle();
  queued += 1;
  const run = queueTail.then(async () => {
    queued -= 1;
    active = true;
    try { return await work(); }
    finally { active = false; scheduleRecycle(); }
  }, async () => {
    queued -= 1;
    active = true;
    try { return await work(); }
    finally { active = false; scheduleRecycle(); }
  });
  queueTail = run.catch(() => {});
  return run;
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
  res.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'});
  res.write(`data: ${JSON.stringify({id, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model:MODEL_ID, choices:[{index:0, delta:{role:'assistant', content:answer}, finish_reason:null}]})}\n\n`);
  res.write(`data: ${JSON.stringify({id, object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model:MODEL_ID, choices:[{index:0, delta:{}, finish_reason:'stop'}]})}\n\n`);
  res.end('data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
    const profile = fs.existsSync(path.join(STATE_DIR, '.chatgpt-poc-profile'));
    const session = fs.existsSync(path.join(STATE_DIR, '.chatgpt-poc-session'));
    return json(res, 200, {status:'ok', profile, session, active, queued});
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    return json(res, 200, {object:'list', data:[{id:MODEL_ID, object:'model', created:0, owned_by:'chatgpt-browser-agent'}]});
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    try {
      const body = await readJson(req);
      let prompt = '';
      
      const chatHash = conversationKey(req);
      let chatUrl = null;
      
      const answer = await enqueue(async () => {
        if (chatHash) chatUrl = loadChatMap()[chatHash] || null;
        const stateFile=chatHash ? path.join(STATE_DIR,chatHash+'-segments.json') : null;
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
        prompt=bridge.buildPrompt(body,MAX_PROMPT_CHARS,chatHash ? known : null,transportState,{browserOwnsHistory:BROWSER_OWNS_HISTORY,callScope:req.headers['x-a0-call-scope']});
        console.log(`[transport] context=${String(req.headers['x-a0-conversation-id']||'none')} scope=${String(req.headers['x-a0-call-scope']||'none')} mapped=${Boolean(chatUrl)} state=${Boolean(transportState)} prompt_chars=${prompt.length}`);
        let raw;
        const runAttempt=async (reloadBeforeAttempt=false) => {
          const requestDeadline=Date.now()+REQUEST_TIMEOUT_MS;
          const remainingBudget=()=>Math.max(1_000,requestDeadline-Date.now());
          try {
            return await runBrowser(prompt,chatUrl,{reloadBeforeAttempt,timeoutMs:remainingBudget()});
          } catch(error) {
            const responseNeverStarted=/Timed out waiting for ChatGPT to start responding/i.test(error.message);
            if(!responseNeverStarted || remainingBudget()<=5_000) throw error;

            // Exactly one startup recovery inside this attempt. Provider 429
            // retries are handled by the outer loop with their own fresh budget.
            if(!chatUrl) chatUrl=requestChatUrlFromError(error) || latestSessionChatUrl();
            if(!chatUrl) throw new Error('Recovery refused: the current request chat URL was not returned by the browser');
            console.warn(`[recovery] No response began within 60s; reloading once and retrying with ${remainingBudget()}ms left`);
            return runBrowser(prompt,chatUrl,{
              reloadBeforeAttempt:true,
              timeoutMs:remainingBudget(),
            });
          }
        };
        for(let rateAttempt=0;;rateAttempt++) {
          try {
            raw=await runAttempt(rateAttempt>0);
            break;
          } catch(error) {
            if(!isProviderMessageLimit(error) || rateAttempt>=PROVIDER_429_RETRIES) throw error;
            if(!chatUrl) chatUrl=requestChatUrlFromError(error) || latestSessionChatUrl();
            if(!chatUrl) throw new Error('Provider 429 retry refused: the current ChatGPT chat URL is unknown');
            console.warn(`[provider-429] attempt ${rateAttempt+1}/${PROVIDER_429_RETRIES} failed; waiting ${PROVIDER_429_RETRY_DELAY_MS}ms, then reloading the same chat and retrying`);
            await sleep(PROVIDER_429_RETRY_DELAY_MS);
          }
        }
        const requestDeadline=Date.now()+REQUEST_TIMEOUT_MS;
        const remainingBudget=()=>Math.max(1_000,requestDeadline-Date.now());
        if (!chatUrl && chatHash) {
          try {
            const sessionFile = path.join(STATE_DIR, '.chatgpt-poc-session');
            if (fs.existsSync(sessionFile)) {
              const newChatUrl = fs.readFileSync(sessionFile, 'utf8').trim();
              if (/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(newChatUrl)) {
                const chatMap = loadChatMap();
                chatMap[chatHash] = newChatUrl;
                saveChatMap(chatMap);
                chatUrl = newChatUrl;
                console.log(`[chatmap] Saved new chat for hash ${chatHash}: ${newChatUrl}`);
              }
            }
          } catch(e) {
            console.warn(`[chatmap] Failed to save chat URL: ${e.message}`);
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
            }),{mode:0o600});
          }
        };
        try { const result=bridge.validateAnswer(raw, body,{callScope:req.headers['x-a0-call-scope']}); remember(); return result; }
        catch (error) {
          console.warn('Response format retry:', error.message);
          if(remainingBudget()<=5_000) throw new Error('Browser request exhausted its 130-second budget before format recovery');
          const retry = await runBrowser(prompt+'\n\nYour previous attempt had this format error: '+error.message+'. Generate the next response again as valid JSON, preserving the latest user task.', chatUrl,{timeoutMs:remainingBudget()});
          const result=bridge.validateAnswer(retry, body,{callScope:req.headers['x-a0-call-scope']}); remember(); return result;
        }
      });
      if (body.stream) return streamResponse(res, answer);
      return json(res, 200, openAiResponse(answer, prompt));
    } catch (error) {
      const rate=error.message.match(/UPLOAD_RATE_LIMIT retry_after_seconds=(\d+)/);
      if(rate) {
        res.setHeader('Retry-After',rate[1]);
        return json(res,429,{error:{message:error.message,type:'rate_limit_error'}});
      }
      if (/Messages limit reached|reached your (?:message|usage) limit|Limite de mensagens (?:atingido|alcançado)/i.test(error.message)) {
        res.setHeader('Retry-After','14400');
        return json(res,429,{error:{message:'A conta ChatGPT conectada atingiu o limite de mensagens do provedor. Nenhuma mensagem foi enviada; tente novamente após o horário de reset exibido no navegador.',type:'rate_limit_error',code:'provider_message_limit'}});
      }
      if (/message you submitted was too long|Context exceeds browser bridge limit/i.test(error.message))
        return json(res,400,{error:{message:'Context too large. Compact this conversation before retrying. No tool was executed by this request.',type:'invalid_request_error',code:'context_length_exceeded'}});
      return json(res, 502, {error:{message:error.message, type:'browser_agent_error'}});
    }
  }
  return json(res, 404, {error:{message:'not found', type:'not_found'}});
});

server.listen(PORT, '0.0.0.0', () => console.log(`OpenAI-compatible browser gateway listening on ${PORT}`));

// Finish accepted requests (including background memory) before Docker stops
// the browser. Abrupt termination used to disconnect live Utility requests.
let shuttingDown=false;
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown=true;
  cancelRecycle();
  console.log('Graceful shutdown: draining accepted requests');
  server.close(() => process.exit(0));
});
