#!/usr/bin/env node
/**
 * chatgpt.js — Fast persistent-browser Codex-style CLI backed by chatgpt.com
 *
 * The browser runs as a background daemon so the launch/navigation overhead
 * only happens once. Subsequent calls take ~2-5s (ChatGPT response time only).
 *
 * Setup (first time):
 *   node chatgpt.js --login
 *
 * Usage:
 *   node chatgpt.js "prompt"                              # continue last chat
 *   node chatgpt.js --new "prompt"                        # start fresh chat
 *   node chatgpt.js --code "write fizzbuzz in Go"         # extract code only
 *   node chatgpt.js --file <path> "prompt"                # attach a file
 *   node chatgpt.js --git "write a commit message"        # attach git context
 *   node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
 *   cat error.log | node chatgpt.js "what is wrong"       # pipe input
 *   node chatgpt.js --status                              # check daemon
 *   node chatgpt.js --stop                                # kill daemon
 */

const { addExtra }        = require('puppeteer-extra');
const puppeteerCore       = require('puppeteer-core');
const StealthPlugin       = require('puppeteer-extra-plugin-stealth');
const path                = require('path');
const os                  = require('os');
const fs                  = require('fs');
const http                = require('http');
const crypto              = require('crypto');
const readline            = require('readline');
const { execSync, spawn } = require('child_process');
const { activeProviderRejection } = require('./provider-rejection');
const { canCollectCompletedTurn, isDownloadTextCandidate, isCompletedEmptyTurn } = require('./completion-state');
const { imageUploadCount, imageUploadReady, imageUploadTimeoutMs } = require('./image-upload');
const { composerChunks, normalizeComposerText } = require('./composer-chunks');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROME_PATH      = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const STATE_DIR        = process.env.CHATGPT_BROWSER_STATE_DIR || os.homedir();
// Browser profiles are isolated per pool slot, while Agent Zero consumes one
// shared media outbox. Without this override an artifact is advertised from a
// slot-private directory that the Agent Zero container cannot see.
const OUTBOX_DIR       = process.env.CHATGPT_BROWSER_OUTBOX_DIR || path.join(STATE_DIR, 'outbox');
const PROFILE_DIR      = path.join(STATE_DIR, '.chatgpt-poc-profile');
const SESSION_FILE     = path.join(STATE_DIR, '.chatgpt-poc-session');
const DAEMON_FILE      = path.join(STATE_DIR, '.chatgpt-poc-daemon.json');
const DAEMON_LOG       = path.join(STATE_DIR, '.chatgpt-poc-daemon.log');
const MANUAL_LOGIN_FILE = path.join(STATE_DIR, '.manual-login-active');
const CHATGPT_URL      = 'https://chatgpt.com';
// The provider may continue a legitimate generation well beyond 130 seconds.
// The gateway/client have a 540/600-second safety ceiling, but a timeout is
// never permission to resend a user turn that ChatGPT already acknowledged.
const REQUEST_TIMEOUT        = 540_000;
const MAX_REQUEST_TIMEOUT    = 540_000;
const RESPONSE_START_TIMEOUT = 130_000;
const IMAGE_UPLOAD_TIMEOUT_MS = Math.max(1_000,Number(process.env.IMAGE_UPLOAD_TIMEOUT_MS || 180_000));

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a senior software engineer acting as a coding assistant.
Rules:
- Be concise. Code over explanation.
- Write complete, working, production-quality code.
- Match the language, style, and patterns of any provided code or context.
- When fixing code show only the corrected version, no before/after commentary.
- No disclaimers, caveats, or filler text.
- If the task is ambiguous, pick the most reasonable interpretation and go.
---
`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim() || null));
  });
}

function readFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return fs.readFileSync(abs, 'utf8');
}

function getGitContext(cwd) {
  const run = cmd => { try { return execSync(cmd, { encoding: 'utf8', cwd }).trim(); } catch { return ''; } };
  const branch = run('git branch --show-current');
  const status = run('git status --short');
  const diff   = run('git diff HEAD');
  if (!branch && !status && !diff) throw new Error('Not inside a git repo or no changes found.');
  let out = '';
  if (branch) out += `Branch: ${branch}\n`;
  if (status) out += `\nStatus:\n${status}\n`;
  if (diff)   out += `\nDiff:\n${diff}\n`;
  return out;
}

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```[\w]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trimEnd());
  return blocks.length > 0 ? blocks.join('\n\n') : text;
}

function buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData }) {
  const parts = [SYSTEM_PROMPT];
  if (contextData) parts.push(`Context:\n${contextData}\n`);
  if (gitData)     parts.push(`Git context:\n${gitData}\n`);
  if (fileData)    parts.push(`File content:\n\`\`\`\n${fileData}\n\`\`\`\n`);
  if (stdinData)   parts.push(`Input:\n\`\`\`\n${stdinData}\n\`\`\`\n`);
  parts.push(`Task: ${userPrompt}`);
  return parts.join('\n');
}

// ─── Browser helpers (daemon-side only) ───────────────────────────────────────

/**
 * Upload a local file to ChatGPT via direct CDP file-input injection.
 *
 * The ChatGPT composer always has a hidden <input id="upload-files"> in the DOM.
 * Puppeteer's uploadFile() uses the Chrome DevTools Protocol to set files on
 * the input element without needing a native file-picker dialog (which requires
 * a real user gesture and cannot be triggered programmatically in headless mode).
 * After setting the files via CDP we fire a synthetic change event so React's
 * event system picks up the new FileList and registers the attachment.
 */
async function uploadFilesToChatGPT(page, uploadPaths, log) {
  const paths=[...new Set((uploadPaths||[]).filter(Boolean).map(p=>path.resolve(p)))];
  if(!paths.length) return;
  for(const abs of paths) if (!fs.existsSync(abs)) throw new Error(`Upload file not found: ${abs}`);
  log(`Uploading ${paths.length} file(s): ${paths.map(p=>path.basename(p)).join(', ')}`);

  await page.bringToFront();

  const plus = await page.$('[data-testid="composer-plus-btn"]');
  if (plus) {
    await plus.click();
    await new Promise(r => setTimeout(r, 350));
    const status = await page.evaluate(() => document.body.innerText);
    await page.keyboard.press('Escape');
    const wait = status.match(/wait\s+(\d+)\s+minutes?\s+to upload again/i);
    if (wait) throw new Error(`UPLOAD_RATE_LIMIT retry_after_seconds=${Number(wait[1])*60}; provider upload quota exhausted`);
    if (/Get Plus for more uploads/i.test(status)) throw new Error('UPLOAD_RATE_LIMIT retry_after_seconds=1800; provider upload quota exhausted');
  }

  // Wait for the hidden file input to be present in the DOM
  const inputHandle = await page.waitForSelector('#upload-files', { timeout: 8_000 });

  // CDP-level file injection — no dialog needed
  await inputHandle.uploadFile(...paths);

  // uploadFile already dispatches input/change. A second change can clear it.

  // Give ChatGPT's React handler a moment to process the file and render a preview
  await new Promise(r => setTimeout(r, 2_000));

  // ChatGPT may show a "You've already uploaded this file" warning dialog when
  // the same file has been uploaded recently.  Dismiss it so the flow continues.
  // An enabled send button does not prove that an image finished uploading.
  // In a failed upload the preview can stay broken/spinning while the button
  // looks enabled. Image readiness is checked separately before submission.
  log('Files injected; image previews will be verified before submission.');
}

async function notifyImageUpload(contextId, message, log) {
  const url=process.env.AGENT_ZERO_NOTICE_URL;
  const token=process.env.AGENT_ZERO_NOTICE_TOKEN;
  if(!contextId || !url || !token) return;
  try {
    const response=await fetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Browser-Pool-Token':token},
      body:JSON.stringify({context_id:contextId,message}),
      signal:AbortSignal.timeout(3_000),
    });
    if(!response.ok) log(`Image upload progress notice failed: HTTP ${response.status}`);
  } catch(error) { log(`Image upload progress notice failed: ${error.message}`); }
}

async function imageComposerState(page) {
  return page.evaluate(() => {
    const editor=document.querySelector('#prompt-textarea');
    const scope=editor?.closest('form') || editor?.parentElement?.parentElement?.parentElement;
    const previews=[...(scope?.querySelectorAll('img')||[])].filter(img=>{
      const rect=img.getBoundingClientRect();
      return rect.width>=48 && rect.height>=48;
    });
    const pending=[...(scope?.querySelectorAll('[role="progressbar"],[aria-busy="true"],[class*="animate-spin"],[class*="loading-spinner"]')||[])]
      .filter(el=>{
        const rect=el.getBoundingClientRect();
        return rect.width>0 && rect.height>0;
      });
    const button=document.querySelector('button[data-testid="send-button"]');
    return {
      previewCount:previews.length,
      loadedCount:previews.filter(img=>img.complete && img.naturalWidth>0).length,
      pendingCount:pending.length,
      sendEnabled:Boolean(button && !button.disabled),
    };
  });
}

async function clearFailedImageUpload(page, log) {
  // Reload only on a failed upload; keep the mapped conversation URL intact.
  await page.reload({waitUntil:'domcontentloaded',timeout:30_000}).catch(error=>
    log(`Image cleanup reload failed: ${error.message}`));
  await page.waitForSelector('#prompt-textarea',{timeout:15_000}).catch(()=>{});
  await page.evaluate(() => {
    for(const button of document.querySelectorAll(
      'button[aria-label^="Remove file"],button[aria-label^="Remove image"],button[aria-label^="Remover arquivo"],button[aria-label^="Remover imagem"]'
    )) button.click();
  }).catch(()=>{});
  if(await page.$('#prompt-textarea')) {
    await page.focus('#prompt-textarea').catch(()=>{});
    await page.keyboard.down('Control').catch(()=>{});
    await page.keyboard.press('a').catch(()=>{});
    await page.keyboard.up('Control').catch(()=>{});
    await page.keyboard.press('Backspace').catch(()=>{});
  }
  const chars=await page.$eval('#prompt-textarea',el=>String(el.value??el.innerText??'').trim().length).catch(()=>-1);
  log(`Failed image upload cleared from mapped chat; remaining draft chars=${chars}`);
}

async function waitForImageUploads(page, count, contextId, deadline, log) {
  if(!count) return;
  await notifyImageUpload(contextId,'image_upload_wait',log);
  log(`Waiting for ${count} image preview(s), up to ${Math.round((deadline-Date.now())/1000)}s`);
  let stable=0;
  let lastState=null;
  while(Date.now()<deadline) {
    const rejection=await readProviderRejection(page);
    if(rejection) throw new Error(`ChatGPT rejected the image upload: ${rejection}`);
    lastState=await imageComposerState(page);
    stable=imageUploadReady(lastState,count) ? stable+1 : 0;
    if(stable>=2) {
      log(`Image preview ready: ${JSON.stringify(lastState)}`);
      await notifyImageUpload(contextId,'image_upload_done',log);
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,1_000));
  }
  log(`Image preview timed out: ${JSON.stringify(lastState)}`);
  await page.screenshot({path:path.join(STATE_DIR,'submission-failure.png'),fullPage:false}).catch(()=>{});
  await clearFailedImageUpload(page,log);
  await notifyImageUpload(contextId,'image_upload_failed',log);
  throw new Error('IMAGE_UPLOAD_TIMEOUT: a imagem não carregou');
}

async function streamBrowserArtifact(page, url, target) {
  const metadata=await page.evaluate(async source=>{
    const response=await fetch(source,{credentials:'include'});
    if(!response.ok || !response.body) throw new Error(`artifact fetch HTTP ${response.status}`);
    window.__a0ArtifactReader=response.body.getReader();
    return {mime:(response.headers.get('content-type')||'application/octet-stream').split(';')[0]};
  },url);
  const descriptor=fs.openSync(target,'w',0o600);
  let bytes=0;
  try {
    for(;;) {
      const encoded=await page.evaluate(async()=>{
        const pieces=[];
        let total=0;
        while(total<256*1024) {
          const {value,done}=await window.__a0ArtifactReader.read();
          if(done) break;
          pieces.push(value);
          total+=value.length;
        }
        if(!total) return null;
        const joined=new Uint8Array(total);
        let offset=0;
        for(const piece of pieces) { joined.set(piece,offset); offset+=piece.length; }
        let binary='';
        for(let i=0;i<joined.length;i+=0x8000)
          binary+=String.fromCharCode(...joined.subarray(i,i+0x8000));
        return btoa(binary);
      });
      if(encoded===null) break;
      const chunk=Buffer.from(encoded,'base64');
      let offset=0;
      while(offset<chunk.length) {
        const written=fs.writeSync(descriptor,chunk,offset,chunk.length-offset);
        if(written<=0) throw new Error('artifact stream stopped writing');
        offset+=written;
      }
      bytes+=chunk.length;
    }
  } catch(error) {
    fs.closeSync(descriptor);
    fs.rmSync(target,{force:true});
    await page.evaluate(()=>{ window.__a0ArtifactReader?.cancel(); delete window.__a0ArtifactReader; }).catch(()=>{});
    throw error;
  }
  fs.closeSync(descriptor);
  await page.evaluate(()=>{ delete window.__a0ArtifactReader; }).catch(()=>{});
  if(!bytes) { fs.rmSync(target,{force:true}); throw new Error('empty artifact response'); }
  return {...metadata,bytes};
}

async function collectAssistantArtifacts(page, log, responseTurnId=null) {
  // Keep this list aligned with every artifact type the Agent Zero bridge is
  // expected to return. ChatGPT often renders generated files as buttons
  // whose only useful signal is the filename, rather than as normal links.
  const downloadableExtensionPattern='\\.(?:png|jpe?g|webp|gif|pdf|docx?|xlsx?|xls|pptx?|csv|tsv|txt|md|json|xml|ya?ml|html?|svg|py|js|ts|jsx|tsx|java|c|cpp|h|hpp|cs|go|rs|php|rb|sh|ps1|bat|sql|css|toml|ini|cfg|conf|log|ipynb|zip|7z|rar|tar|tar\\.gz|tgz|gz|bz2|xz|sqlite|db|parquet|feather|npy|npz|h5|hdf5|mat|stl|obj|ply|gltf|glb|dae|dxf|wav|mp3|flac|ogg|opus|aac|mp4|mov|mkv|avi|webm|iso|bin|exe|dll|so|apk|jar)\\b';
  const downloadDir=path.join(STATE_DIR,`downloads-${crypto.randomUUID()}`);
  fs.mkdirSync(downloadDir,{recursive:true,mode:0o700});
  const candidates=await page.evaluate((targetTurnId) => {
    const turns=[...document.querySelectorAll('[data-testid^="conversation-turn-"]')].filter(turn=>!turn.querySelector('[data-message-author-role="user"]'));
    const assistant=[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);
    const root=(targetTurnId ? document.querySelector(`[data-testid="${CSS.escape(targetTurnId)}"]`) : null)
      || (!targetTurnId ? turns.at(-1) : null)
      || (!targetTurnId ? assistant?.closest('[data-testid^="conversation-turn-"]') : null)
      || (!targetTurnId ? assistant : null);
    if(!root) return [];
    const candidates=[];
    // File links use Chromium's disk-backed download below. Fetching an
    // archive into this page would allocate the entire file twice before the
    // provider's download control gets a chance to stream it to disk.
    for(const img of root.querySelectorAll('img[src]')) {
      const r=img.getBoundingClientRect();
      if((img.naturalWidth||r.width)<128 || (img.naturalHeight||r.height)<128) continue;
      if(/avatar|profile|emoji|icon/i.test(`${img.alt||''} ${img.className||''}`)) continue;
      candidates.push({url:img.currentSrc||img.src,name:img.alt||''});
    }
    const seen=new Set();
    return candidates.filter(candidate=>{
      if(!candidate.url || seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    });
  },responseTurnId);
  const found=[];
  for(const candidate of candidates) {
    const target=path.join(downloadDir,`image-${crypto.randomUUID()}`);
    try {
      const captured=await streamBrowserArtifact(page,candidate.url,target);
      found.push({path:target,mime:captured.mime,name:candidate.name,url:candidate.url});
    } catch(error) { log(`Image artifact fetch skipped: ${error.message}`); }
  }
  let client=null;
  try {
    client=await page.target().createCDPSession();
    await client.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadDir,eventsEnabled:true});
    await client.send('Network.enable').catch(()=>{});
    const downloadEvents=[];
    const networkEvents=[];
    client.on('Browser.downloadWillBegin',event=>downloadEvents.push({type:'willBegin',guid:event.guid,url:event.url,suggestedFilename:event.suggestedFilename}));
    client.on('Browser.downloadProgress',event=>{
      if(event.state!=='inProgress') downloadEvents.push({type:'progress',guid:event.guid,state:event.state,receivedBytes:event.receivedBytes,totalBytes:event.totalBytes});
    });
    client.on('Network.requestWillBeSent',event=>{
      const url=event.request?.url||'';
      if(/sandbox:|\/mnt\/data|backend-api|estuary|download|files\//i.test(url))
        networkEvents.push({requestId:event.requestId,url,method:event.request?.method||'',type:event.type||'',documentURL:event.documentURL||''});
      if(networkEvents.length>50) networkEvents.shift();
    });
    client.on('Network.responseReceived',event=>{
      const item=networkEvents.find(candidate=>candidate.requestId===event.requestId);
      if(item) {
        item.status=event.response?.status||0;
        item.mimeType=event.response?.mimeType||'';
      }
    });
    // Do not call Network.getResponseBody here. CDP materializes the whole
    // response in RAM, which is unsafe for a large generated artifact.
    const roots=responseTurnId
      ? [await page.$(`[data-testid="${responseTurnId.replace(/[^A-Za-z0-9_-]/g,'')}"]`)].filter(Boolean)
      : await page.$$('[data-testid^="conversation-turn-"]');
    let responseRoot=null;
    for(let i=roots.length-1;i>=0;i--) {
      const isUser=await roots[i].$('[data-message-author-role="user"]');
      if(isUser) continue;
      // A base64 compatibility envelope is itself sufficient evidence that
      // this assistant turn owns an artifact. ChatGPT may deliberately strip
      // file:// links from rendered controls, leaving no button or anchor for
      // the older control-only detector even though the exact bytes are in the
      // response text.
      const hasEnvelope=await roots[i].evaluate(el=>{
        const text=el.innerText||el.textContent||'';
        return text.includes('A0_ARTIFACT_BASE64_BEGIN')&&text.includes('A0_ARTIFACT_BASE64_END');
      }).catch(()=>false);
      if(hasEnvelope) { responseRoot=roots[i]; break; }
      const elements=await roots[i].$$('button,a[href]');
      let hasDownload=false;
      for(const element of elements) {
        hasDownload=await element.evaluate((el,pattern)=>{
          const label=`${el.getAttribute('aria-label')||''} ${el.getAttribute('download')||''} ${el.innerText||el.textContent||''} ${el.getAttribute('href')||''}`;
          const ext=new RegExp(pattern,'i');
          return /download file|baixar|download|sandbox:\/|\/mnt\/data/i.test(label)||ext.test(label);
        },downloadableExtensionPattern).catch(()=>false);
        if(hasDownload) break;
      }
      if(hasDownload) { responseRoot=roots[i]; break; }
    }
    if(responseRoot) {
      // ChatGPT's Estuary service can reject active text/code extensions
      // (for example .js) with HTTP 415 even though the file was created.
      // In that case the prompt asks for the exact bytes in a compact base64
      // envelope. Materialize only that explicit, model-authored envelope.
      const envelope=await responseRoot.evaluate(el=>{
        const rendered=el.innerText||el.textContent||'';
        const candidates=[];
        // Agent responses are displayed as a JSON code block. In the DOM the
        // newlines inside tool_args.text are escaped as literal "\\n", so
        // parse the outer JSON before looking for the binary envelope.
        try {
          const start=rendered.indexOf('{'), end=rendered.lastIndexOf('}');
          if(start>=0&&end>start) {
            const parsed=JSON.parse(rendered.slice(start,end+1));
            if(typeof parsed?.tool_args?.text==='string') candidates.push(parsed.tool_args.text);
          }
        } catch {}
        candidates.push(rendered);
        for(const text of candidates) {
          const match=text.match(/A0_ARTIFACT_BASE64_BEGIN\s+([^\s]+)\s+([A-Za-z0-9+/=\r\n]+?)\s+A0_ARTIFACT_BASE64_END/i);
          if(match) return {name:match[1],data:match[2].replace(/\s+/g,'')};
        }
        return null;
      }).catch(()=>null);
      if(envelope&&/^[A-Za-z0-9._-]+$/.test(envelope.name)) {
        try {
          const buffer=Buffer.from(envelope.data,'base64');
          if(buffer.length&&buffer.length<=100*1024*1024) {
            found.push({data:buffer.toString('base64'),mime:'application/octet-stream',name:envelope.name,url:'browser-text-envelope'});
            log(`Collected model-authored artifact envelope: ${envelope.name} (${buffer.length} bytes)`);
          }
        } catch(error) { log(`Artifact envelope decode warning: ${error.message}`); }
      }
      const elements=found.length ? [] : await responseRoot.$$('button,a[href]');
      const buttons=[];
      for(const element of elements) {
        const downloadLike=await element.evaluate((el,pattern)=>{
          const label=`${el.getAttribute('aria-label')||''} ${el.getAttribute('download')||''} ${el.innerText||el.textContent||''} ${el.getAttribute('href')||''}`;
          const ext=new RegExp(pattern,'i');
          return /download file|baixar|download/i.test(label)||ext.test(label);
        },downloadableExtensionPattern).catch(()=>false);
        if(downloadLike) {
          const priority=await element.evaluate(el=>/download file|baixar|download/i.test(`${el.getAttribute('aria-label')||''} ${el.innerText||el.textContent||''}`)?0:1).catch(()=>1);
          buttons.push({element,priority});
        }
      }
      buttons.sort((a,b)=>a.priority-b.priority);
      for(const entry of buttons) {
        const button=entry.element;
        const buttonLabel=await button.evaluate(el=>`${el.getAttribute('aria-label')||''} ${el.getAttribute('download')||''} ${el.innerText||el.textContent||''} ${el.getAttribute('href')||''}`.trim().slice(0,500)).catch(()=>'<unreadable>');
        const buttonDetails=await button.evaluate(el=>({
          outerHTML:el.outerHTML.slice(0,2000),disabled:Boolean(el.disabled),
          rect:(()=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})(),
          visible:Boolean(el.offsetWidth||el.offsetHeight||el.getClientRects().length),
        })).catch(error=>({error:error.message}));
        log(`Trying artifact control: ${buttonLabel}; details=${JSON.stringify(buttonDetails)}`);
        const sourceToken=crypto.randomUUID();
        await button.evaluate((el,token)=>el.setAttribute('data-a0-download-source',token),sourceToken).catch(()=>{});
        const before=new Set(fs.readdirSync(downloadDir));
        const networkBefore=networkEvents.length;
        await button.click().catch(()=>{});
        let saved=''; let previousSize=-1;
        for(let i=0;i<12;i++) {
          await new Promise(r=>setTimeout(r,500));
          const candidates=fs.readdirSync(downloadDir).filter(n=>!before.has(n)&&!n.endsWith('.crdownload'));
          if(candidates.length) {
            const candidate=candidates[0], size=fs.statSync(path.join(downloadDir,candidate)).size;
            if(size>0 && size===previousSize) { saved=candidate; break; }
            previousSize=size;
          }
        }
        if(!saved) {
          const postClick=await page.evaluate(()=>({
            url:location.href,
            dialogs:[...document.querySelectorAll('[role="dialog"],dialog')].map(el=>(el.innerText||el.textContent||'').trim().slice(0,800)),
            downloads:[...document.querySelectorAll('button,a[href],[role="button"]')].filter(el=>/download file|baixar arquivo|download/i.test(`${el.getAttribute('aria-label')||''} ${el.innerText||el.textContent||''}`)).slice(-20).map(el=>({tag:el.tagName,text:(el.innerText||el.textContent||'').trim().slice(0,200),aria:el.getAttribute('aria-label'),href:el.getAttribute('href'),visible:Boolean(el.offsetWidth||el.offsetHeight||el.getClientRects().length)})),
          })).catch(error=>({error:error.message}));
          log(`Artifact click produced no file after 6s; events=${JSON.stringify(downloadEvents)}; state=${JSON.stringify(postClick)}`);

          // Some generated code/document downloads are issued as a signed
          // Estuary fetch and then incorrectly navigated by Chrome as a
          // document, producing chrome-error://chromewebdata instead of a
          // Browser.download event. Recover only the URL triggered by this
          // exact click and fetch its original bytes with the logged-in cookie.
          // The ChatGPT UI no longer adds `cd=attachment` (or even `fn=`) to
          // every generated-file response.  The response is still safe to
          // associate here because it must have been emitted *after* the exact
          // control from this assistant turn was activated.  Requiring the
          // optional query parameter made valid image/file responses visible
          // in the browser but impossible to return to Agent Zero.
          const triggeredEstuary=networkEvents.slice(networkBefore).reverse()
            .find(event=>/\/backend-api\/estuary\/content\?/i.test(event.url));
          if(triggeredEstuary) {
            try {
              if(!triggeredEstuary.status||triggeredEstuary.status<400) {
                const parsed=new URL(triggeredEstuary.url);
                const recoveredName=parsed.searchParams.get('fn')||buttonLabel.replace(/^.*?Download\s+/i,'').trim();
                const target=path.join(downloadDir,`estuary-${crypto.randomUUID()}`);
                const captured=await streamBrowserArtifact(page,triggeredEstuary.url,target);
                const mime=triggeredEstuary.mimeType||captured.mime;
                found.push({path:target,mime,name:recoveredName,url:triggeredEstuary.url});
                log(`Collected Chromium Estuary response: ${recoveredName} (${captured.bytes} bytes; HTTP ${triggeredEstuary.status||'unknown'}; ${mime})`);
                if(page.url().startsWith('chrome-error://')&&fs.existsSync(SESSION_FILE)) {
                  const restore=fs.readFileSync(SESSION_FILE,'utf8').trim();
                  await page.goto(restore,{waitUntil:'domcontentloaded',timeout:60_000}).catch(()=>{});
                  log(`Restored mapped chat after intercepted download navigation: ${restore}`);
                }
                break;
              }
              log(`Chromium Estuary response was empty or failed: HTTP ${triggeredEstuary.status||'unknown'}`);
            } catch(error) { log(`Chromium Estuary response recovery warning: ${error.message}`); }
          }

          // Image artifacts are rendered by the current ChatGPT lightbox from
          // an authenticated Estuary URL and intentionally expose no download
          // button. Copy the exact bytes shown in that active preview using the
          // browser session's credentials. This preserves the provider output
          // byte-for-byte instead of taking a screenshot or re-encoding it.
          const previewImage=await page.evaluate(exactName=>{
            const dialogs=[...document.querySelectorAll('[role="dialog"],dialog,[aria-modal="true"]')]
              .filter(el=>Boolean(el.offsetWidth||el.offsetHeight||el.getClientRects().length)).reverse();
            for(const dialog of dialogs) {
              const images=[...dialog.querySelectorAll('img[src]')];
              const image=images.find(img=>(img.alt||'').trim()===exactName)||images.at(-1);
              if(!image?.src) continue;
              return {name:exactName.replace(/^Download\s+/i,''),url:image.currentSrc||image.src};
            }
            return null;
          },buttonLabel.trim()).catch(()=>null);
          if(previewImage) {
            const target=path.join(downloadDir,`preview-${crypto.randomUUID()}`);
            try {
              const captured=await streamBrowserArtifact(page,previewImage.url,target);
              found.push({path:target,mime:captured.mime,name:previewImage.name,url:previewImage.url});
              log(`Collected authenticated preview image: ${previewImage.name} (${captured.bytes} bytes; ${captured.mime})`);
              await page.keyboard.press('Escape').catch(()=>{});
              await page.evaluate(token=>document.querySelector(`[data-a0-download-source="${CSS.escape(token)}"]`)?.removeAttribute('data-a0-download-source'),sourceToken).catch(()=>{});
              break;
            } catch(error) { log(`Authenticated preview stream warning: ${error.message}`); }
          }

          // Generated-file pills can open a preview dialog instead of directly
          // downloading. Activate the dialog's own download control, scoped to
          // the newest visible dialog so an older file cannot be selected.
          let activatedSecondary=false;
          // The current ChatGPT file preview renders two controls with the
          // exact filename inside its modal: the first is the preview title and
          // the last is the actual download action.  Resolve and activate that
          // last duplicate in one DOM evaluation so detached ElementHandles or
          // unrelated global controls (for example "Download apps") can never
          // be selected.
          const dialogActivation=await page.evaluate(({exactName,sourceToken})=>{
            const visible=el=>Boolean(el.offsetWidth||el.offsetHeight||el.getClientRects().length);
            const dialogs=[...document.querySelectorAll('[role="dialog"],dialog,[aria-modal="true"]')]
              .filter(visible).reverse();
            for(const dialog of dialogs) {
              const controls=[...dialog.querySelectorAll('button,a[href],[role="button"]')]
                .filter(el=>visible(el)&&!el.disabled&&el.getAttribute('data-a0-download-source')!==sourceToken)
                .filter(el=>(el.innerText||el.textContent||'').trim()===exactName);
              if(!controls.length) continue;
              const target=controls.at(-1);
              const detail={count:controls.length,text:(target.innerText||target.textContent||'').trim(),
                aria:target.getAttribute('aria-label'),href:target.getAttribute('href'),
                outerHTML:target.outerHTML.slice(0,1200)};
              target.click();
              return {activated:true,detail};
            }
            return {activated:false,dialogs:dialogs.map(dialog=>({
              text:(dialog.innerText||dialog.textContent||'').trim().slice(0,500),
              outerHTML:dialog.outerHTML.slice(0,8000),
              controls:[...dialog.querySelectorAll('button,a[href],[role="button"]')].map(el=>({
                text:(el.innerText||el.textContent||'').trim().slice(0,200),aria:el.getAttribute('aria-label'),
                visible:visible(el),disabled:Boolean(el.disabled)
              })).slice(0,30)
            }))};
          },{exactName:buttonLabel.trim(),sourceToken}).catch(error=>({activated:false,error:error.message}));
          if(dialogActivation.activated) {
            log(`Activating preview-dialog download: ${JSON.stringify(dialogActivation.detail)}`);
            activatedSecondary=true;
          } else {
            log(`No exact preview-dialog download control: ${JSON.stringify(dialogActivation)}`);
          }
          if(!activatedSecondary) {
            // Some ChatGPT builds render the file preview in a portal without
            // dialog semantics. Select the newly exposed, on-screen duplicate
            // of the exact filename, never an older off-screen conversation
            // pill and never the original control itself.
            const globalControls=await page.$$('button,a[href],[role="button"]');
            const portalCandidates=[];
            const exactName=buttonLabel.replace(/^\s+|\s+$/g,'');
            for(let index=0;index<globalControls.length;index++) {
              const control=globalControls[index];
              const detail=await control.evaluate((el,token)=>{
                 const r=el.getBoundingClientRect();
                 const text=(el.innerText||el.textContent||'').trim();
                 const aria=(el.getAttribute('aria-label')||'').trim();
                 const label=(text||aria).trim();
                 const cx=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2));
                 const cy=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2));
                 const hit=document.elementFromPoint(cx,cy);
                 return {same:el.getAttribute('data-a0-download-source')===token,label,disabled:Boolean(el.disabled),
                   onScreen:r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth,
                   topmost:Boolean(hit&&(hit===el||el.contains(hit))),
                   modal:Boolean(el.closest('[role="dialog"],dialog,[aria-modal="true"],[data-state="open"]')),
                   rect:{x:r.x,y:r.y,width:r.width,height:r.height},outerHTML:el.outerHTML.slice(0,1200)};
               },sourceToken).catch(()=>null);
               if(detail && !detail.same && !detail.disabled && detail.onScreen && detail.topmost
                 && detail.label===exactName) {
                 portalCandidates.push({control,detail,index});
               }
            }
            portalCandidates.sort((a,b)=>Number(a.detail.modal)-Number(b.detail.modal)||a.index-b.index);
             if(portalCandidates.length) {
               const secondary=portalCandidates.at(-1);
               log(`Activating portal download: ${JSON.stringify(secondary.detail)}`);
               await secondary.control.click().catch(()=>{});
               activatedSecondary=true;
             } else {
               const exactDiagnostics=[];
               for(let index=0;index<globalControls.length;index++) {
                 const detail=await globalControls[index].evaluate((el,name,token)=>{
                   const text=(el.innerText||el.textContent||'').trim();
                   const aria=(el.getAttribute('aria-label')||'').trim();
                   if((text||aria).trim()!==name) return null;
                   const r=el.getBoundingClientRect();
                   const cx=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2));
                   const cy=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2));
                   const hit=document.elementFromPoint(cx,cy);
                   return {same:el.getAttribute('data-a0-download-source')===token,
                     visible:Boolean(el.offsetWidth||el.offsetHeight||el.getClientRects().length),
                     onScreen:r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth,
                     topmost:Boolean(hit&&(hit===el||el.contains(hit))),hit:hit?.outerHTML?.slice(0,300)||null,
                     rect:{x:r.x,y:r.y,width:r.width,height:r.height},outerHTML:el.outerHTML.slice(0,500)};
                 },exactName,sourceToken).catch(()=>null);
                 if(detail) exactDiagnostics.push(detail);
               }
               log(`No topmost portal download control: ${JSON.stringify(exactDiagnostics)}`);
             }
          }
          if(!activatedSecondary) {
            // React occasionally ignores a pointer activation even though the
            // pill is visible. One keyboard activation is a trusted fallback.
            await button.focus().catch(()=>{});
            await page.keyboard.press('Enter').catch(()=>{});
          }
          await page.evaluate(token=>document.querySelector(`[data-a0-download-source="${CSS.escape(token)}"]`)?.removeAttribute('data-a0-download-source'),sourceToken).catch(()=>{});
          for(let i=0;i<48;i++) {
            await new Promise(r=>setTimeout(r,500));
            const candidates=fs.readdirSync(downloadDir).filter(n=>!before.has(n)&&!n.endsWith('.crdownload'));
            if(candidates.length) {
              const candidate=candidates[0], size=fs.statSync(path.join(downloadDir,candidate)).size;
              if(size>0 && size===previousSize) { saved=candidate; break; }
              previousSize=size;
            }
          }
        }
        if(saved) {
          const sourcePath=path.join(downloadDir,saved);
          const ext=path.extname(saved).toLowerCase();
          const mime={'.pdf':'application/pdf','.zip':'application/zip','.txt':'text/plain','.json':'application/json','.csv':'text/csv'}[ext]||'application/octet-stream';
          found.push({path:sourcePath,mime,name:saved,url:'browser-download'});
          log(`Artifact control downloaded: ${saved} (${fs.statSync(sourcePath).size} bytes)`);
          break;
        }
        log(`Artifact control exhausted without a file; events=${JSON.stringify(downloadEvents)}; network=${JSON.stringify(networkEvents.slice(-12))}`);
      }
    }
  } catch(error) { log(`Download-button collection warning: ${error.message}`); }
  finally {
    if(client) await client.detach().catch(()=>{});
  }
  const outDir=OUTBOX_DIR;
  fs.mkdirSync(outDir,{recursive:true,mode:0o755});
  const artifacts=[];
  const seenHashes=new Set();
  const sniffImageMime=buffer=>{
    if(buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return 'image/png';
    if(buffer.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))) return 'image/jpeg';
    if(buffer.subarray(0,4).toString('ascii')==='GIF8') return 'image/gif';
    if(buffer.subarray(0,4).toString('ascii')==='RIFF'&&buffer.subarray(8,12).toString('ascii')==='WEBP') return 'image/webp';
    return '';
  };
  const extFor=mime=>({
    'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif',
    'application/pdf':'.pdf','application/zip':'.zip','text/plain':'.txt',
  }[mime]||'');
  const mimeForName=name=>({
    '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif',
    '.txt':'text/plain','.md':'text/markdown','.json':'application/json','.xml':'application/xml',
    '.yaml':'application/yaml','.yml':'application/yaml','.html':'text/html','.htm':'text/html',
    '.svg':'image/svg+xml','.py':'text/x-python','.js':'text/javascript','.ts':'text/typescript',
    '.jsx':'text/jsx','.tsx':'text/tsx','.java':'text/x-java-source','.c':'text/x-c',
    '.cpp':'text/x-c++src','.h':'text/x-c','.hpp':'text/x-c++hdr','.cs':'text/x-csharp',
    '.go':'text/x-go','.rs':'text/x-rust','.php':'application/x-httpd-php','.rb':'text/x-ruby',
    '.sh':'application/x-sh','.ps1':'text/plain','.bat':'text/plain','.sql':'application/sql',
    '.css':'text/css','.toml':'application/toml','.ini':'text/plain','.cfg':'text/plain',
    '.conf':'text/plain','.log':'text/plain','.gltf':'model/gltf+json','.obj':'model/obj',
    '.ply':'model/ply','.stl':'model/stl','.dae':'model/vnd.collada+xml','.dxf':'image/vnd.dxf',
  }[path.extname(String(name||'')).toLowerCase()]||'');
  for(const item of found) {
    const sourcePath=item.path || null;
    const buffer=sourcePath ? null : Buffer.from(item.data,'base64');
    const hash=sourcePath
      ? await new Promise((resolve,reject)=>{
          const digest=crypto.createHash('sha256');
          const stream=fs.createReadStream(sourcePath);
          stream.on('data',chunk=>digest.update(chunk));
          stream.on('end',()=>resolve(digest.digest('hex')));
          stream.on('error',reject);
        })
      : crypto.createHash('sha256').update(buffer).digest('hex');
    if(seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    let header=buffer;
    if(sourcePath) {
      header=Buffer.alloc(12);
      const descriptor=fs.openSync(sourcePath,'r');
      try { fs.readSync(descriptor,header,0,12,0); }
      finally { fs.closeSync(descriptor); }
    }
    const detectedMime=sniffImageMime(header);
    let original=String(item.name||'').replace(/[\\/:*?"<>|\r\n]/g,' ').trim();
    if(!original || original.length>120) original=`chatgpt-file${extFor(detectedMime||item.mime)}`;
    else if(!path.extname(original)) original+=extFor(detectedMime||item.mime);
    let ext=path.extname(original).slice(0,12);
    if(!ext) ext=extFor(item.mime);
    const filename=`chatgpt-${crypto.randomUUID()}${ext}`;
    const destination=path.join(outDir,filename);
    if(sourcePath) fs.copyFileSync(sourcePath,destination);
    else fs.writeFileSync(destination,buffer,{mode:0o644});
    const mime=detectedMime || ((item.mime&&item.mime!=='application/octet-stream') ? item.mime : (mimeForName(original)||item.mime||'application/octet-stream'));
    artifacts.push({filename,originalName:original,mime,size:sourcePath?fs.statSync(sourcePath).size:buffer.length,sha256:hash});
  }
  fs.rmSync(downloadDir,{recursive:true,force:true});
  if(artifacts.length) log(`Collected ${artifacts.length} assistant artifact(s): ${artifacts.map(a=>a.originalName).join(', ')}`);
  else {
    const diagnostics=await page.evaluate((targetTurnId)=>{
      const root=(targetTurnId ? document.querySelector(`[data-testid="${CSS.escape(targetTurnId)}"]`) : null)
        || [...document.querySelectorAll('[data-testid^="conversation-turn-"]')].filter(turn=>!turn.querySelector('[data-message-author-role="user"]')).at(-1);
      const summarize=el=>({
        tag:el.tagName,
        text:String(el.innerText||el.textContent||'').trim().slice(0,240),
        aria:el.getAttribute('aria-label'),
        href:el.getAttribute('href'),
        download:el.getAttribute('download'),
        testid:el.getAttribute('data-testid'),
        role:el.getAttribute('role'),
      });
      return {
        targetTurnId,
        rootFound:Boolean(root),
        rootText:String(root?.innerText||root?.textContent||'').trim().slice(0,1200),
        controls:root?[...root.querySelectorAll('a[href],button,[role="button"]')].slice(0,80).map(summarize):[],
        pageFilenameMatches:[...document.querySelectorAll('a[href],button,[role="button"]')]
          .filter(el=>/\.[a-z0-9.]{1,10}\b/i.test(`${el.innerText||el.textContent||''} ${el.getAttribute('aria-label')||''}`))
          .slice(-40).map(summarize),
      };
    },responseTurnId).catch(error=>({diagnosticError:error.message}));
    log(`No artifact collected; DOM summary=${JSON.stringify(diagnostics)}`);
  }
  return artifacts;
}

function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    headless: false,
    // Google rejects sign-in when Puppeteer's default automation marker is
    // present. Keep the normal browser arguments, but remove that marker and
    // use the DevTools pipe instead of exposing a debugging port.
    ignoreDefaultArgs: ['--enable-automation'],
    pipe: true,
    args: [
      ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: null,
  });
}

// Short prompts use one DOM insertion. Large first-turn prompts use bounded
// browser input events: one huge execCommand transaction could freeze Chrome
// and exhaust host memory before the message was ever submitted.
async function dismissBlockingOverlays(page, log) {
  for (let pass=0; pass<4; pass++) {
    const action=await page.evaluate(() => {
      const visible=el=>{
        const r=el.getBoundingClientRect();
        const s=getComputedStyle(el);
        return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none';
      };
      const composer=document.querySelector('#prompt-textarea');
      const send=document.querySelector('button[data-testid="send-button"]');
      const candidates=[...document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"], [data-state="open"]')]
        .filter(visible)
        // ChatGPT marks its ordinary navigation sidebar as a dialog. It does
        // not cover the composer and must never be mistaken for a popup.
        .filter(el=>!el.querySelector('[data-testid="close-sidebar-button"]'));
      const labels=/^(close|dismiss|not now|maybe later|continue|got it|okay|ok|fechar|dispensar|agora não|talvez depois|continuar|entendi)$/i;
      for (const modal of candidates) {
        const button=[...modal.querySelectorAll('button')].find(b=>visible(b) && labels.test((b.getAttribute('aria-label')||b.innerText||b.title||'').trim()));
        if(button) { button.click(); return {kind:'button',label:(button.getAttribute('aria-label')||button.innerText||button.title||'').trim()}; }
      }
      if(candidates.length) return {kind:'blocked',tag:'MODAL',text:'visible dialog without a labelled close control'};
      if(send && visible(send)) {
        const r=send.getBoundingClientRect();
        const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        if(top && !send.contains(top)) return {kind:'blocked',tag:top.tagName,text:(top.innerText||top.getAttribute?.('aria-label')||'').trim().slice(0,120)};
      }
      return {kind:'clear',composer:!!composer};
    });
    if(action.kind==='clear') return;
    if(action.kind==='button') {
      log(`Dismissed blocking popup control: ${action.label}`);
      await new Promise(r=>setTimeout(r,350));
      continue;
    }
    // Escape is a safe fallback for a transient popover intercepting the send
    // control. It does not submit or modify composer text.
    log(`Composer obstructed by ${action.tag}: ${action.text || 'unnamed overlay'}; dismissing with Escape`);
    await page.keyboard.press('Escape');
    await new Promise(r=>setTimeout(r,350));
  }
  const blocked=await page.evaluate(()=>{
    const send=document.querySelector('button[data-testid="send-button"]');
    if(!send) return 'send button missing';
    const r=send.getBoundingClientRect(); const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return top && !send.contains(top) ? `${top.tagName}: ${(top.innerText||'').trim().slice(0,120)}` : '';
  });
  if(blocked) throw new Error(`A popup is still blocking the ChatGPT composer (${blocked})`);
}

async function fillTextarea(page, text, log=()=>{}) {
  await page.bringToFront();
  await page.waitForFunction(()=>{
    const el=document.querySelector('#prompt-textarea');
    return el && el.getBoundingClientRect().height>0 && (el.isContentEditable || el.tagName==='TEXTAREA');
  },{timeout:60000});
  const normalized=normalizeComposerText;
  const longPrompt=text.length>8_000;
  const chunks=longPrompt ? composerChunks(text,1024) : [];
  if(longPrompt) log(`Filling large composer with ${chunks.length} bounded input events (${text.length} characters)`);
  for(let attempt=0;attempt<3;attempt++) {
    // The composer can be replaced once or twice while a newly opened ChatGPT
    // page finishes hydrating.  Inserting immediately into the old node looks
    // successful to CDP but React then discards the whole draft.  Require the
    // exact element to remain mounted for a short stability window first.
    await page.waitForFunction(async()=>{
      const first=document.querySelector('#prompt-textarea');
      if(!first || first.getBoundingClientRect().height<=0) return false;
      await new Promise(resolve=>setTimeout(resolve,600));
      return document.querySelector('#prompt-textarea')===first && first.isConnected;
    },{timeout:15_000,polling:250});

    await page.focus('#prompt-textarea');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');

    // Each chunk uses the editor's normal input pathway. Verify each prefix
    // after the editor has had time to commit it: under load ProseMirror can
    // silently discard one complete Input.insertText event while accepting
    // later chunks, which a final-only check cannot recover efficiently.
    if(longPrompt) {
      let prefix='';
      let prefixFailed=false;
      for(let i=0;i<chunks.length;i++) {
        // ProseMirror may replace the editor node between input events and
        // leave the selection inside the preceding chunk. Explicitly anchor
        // each continuation at the end so no bytes are reordered or lost.
        await page.$eval('#prompt-textarea',el=>{
          el.focus();
          if(el.tagName==='TEXTAREA') {
            el.setSelectionRange(el.value.length,el.value.length);
          } else {
            const range=document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const selection=window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }
        });
        await page.keyboard.sendCharacter(chunks[i]);
        const previous=prefix;
        prefix+=chunks[i];
        let actual='';
        let matched=false;
        for(let poll=0;poll<10;poll++) {
          await new Promise(r=>setTimeout(r,120));
          actual=await page.$eval('#prompt-textarea',el=>el.value ?? el.innerText).catch(()=>'');
          if(normalized(actual)===normalized(prefix)) { matched=true; break; }
        }
        if(!matched && normalized(actual)===normalized(previous)) {
          log(`Composer discarded chunk ${i+1}; reinserting it once`);
          await page.$eval('#prompt-textarea',el=>{
            el.focus();
            if(el.tagName==='TEXTAREA') el.setSelectionRange(el.value.length,el.value.length);
            else {
              const range=document.createRange();
              range.selectNodeContents(el);
              range.collapse(false);
              const selection=window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            }
          });
          await page.keyboard.sendCharacter(chunks[i]);
          for(let poll=0;poll<10;poll++) {
            await new Promise(r=>setTimeout(r,120));
            actual=await page.$eval('#prompt-textarea',el=>el.value ?? el.innerText).catch(()=>'');
            if(normalized(actual)===normalized(prefix)) { matched=true; break; }
          }
        }
        if(!matched && normalized(actual)===normalized(previous)) {
          // CDP Input.insertText can be ignored by an already-hydrated
          // contenteditable. Try its native edit transaction for this one
          // bounded chunk before restarting the whole draft.
          const inserted=await page.$eval('#prompt-textarea',(el,value)=>{
            el.focus();
            if(el.tagName==='TEXTAREA') {
              const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
              setter?.call(el,el.value+value);
              el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
              return true;
            }
            const range=document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const selection=window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return document.execCommand('insertText',false,value);
          },chunks[i]);
          log(`Composer fallback insert for chunk ${i+1}: ${inserted}`);
          for(let poll=0;poll<10;poll++) {
            await new Promise(r=>setTimeout(r,120));
            actual=await page.$eval('#prompt-textarea',el=>el.value ?? el.innerText).catch(()=>'');
            if(normalized(actual)===normalized(prefix)) { matched=true; break; }
          }
        }
        if(!matched) {
          const a=normalized(actual), b=normalized(prefix);
          let offset=0; while(offset<Math.min(a.length,b.length)&&a[offset]===b[offset]) offset++;
          const codes=s=>[...s.slice(Math.max(0,offset-6),offset+12)].map(ch=>ch.codePointAt(0));
          const controls=[...chunks[i]].map((ch,j)=>({code:ch.codePointAt(0),at:j})).filter(x=>x.code<32 && ![9,10,13].includes(x.code)).slice(0,12);
          log(`Composer prefix mismatch after chunk ${i+1}/${chunks.length}: actual=${a.length} expected=${b.length} offset=${offset} actual_codes=${JSON.stringify(codes(a))} expected_codes=${JSON.stringify(codes(b))} control_codes=${JSON.stringify(controls)}; restarting from an empty draft`);
          prefixFailed=true;
          break;
        }
        if(i===0 || (i+1)%4===0 || i===chunks.length-1)
          log(`Large composer input ${i+1}/${chunks.length} attempt ${attempt+1}`);
      }
      if(prefixFailed) continue;
    } else {
      const inserted=await page.$eval('#prompt-textarea',(el,value)=>{
        el.focus();
        if(el.tagName==='TEXTAREA') {
          const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
          setter?.call(el,value);
          el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
          return true;
        }
        document.execCommand('selectAll',false,null);
        return document.execCommand('insertText',false,value);
      },text);
      if(!inserted) await page.keyboard.sendCharacter(text);
    }
    await new Promise(r=>setTimeout(r,500+attempt*500));
    const actual=await page.$eval('#prompt-textarea',el=>el.value ?? el.innerText).catch(()=>"");
    if(normalized(actual)===normalized(text)) return;
    const a=normalized(actual), b=normalized(text);
    let offset=0; while(offset<Math.min(a.length,b.length)&&a[offset]===b[offset]) offset++;
    const codes=s=>[...s.slice(Math.max(0,offset-6),offset+12)].map(ch=>ch.codePointAt(0));
    log(`Composer verification failed on attempt ${attempt+1}: raw=${actual.length}/${text.length} normalized=${a.length}/${b.length} offset=${offset} actual_codes=${JSON.stringify(codes(a))} expected_codes=${JSON.stringify(codes(b))}`);
  }
  throw new Error('Composer failed verified insertion after 3 attempts; nothing submitted');
}

async function resetNewChatComposer(page, log) {
  await page.waitForFunction(()=>{
    const el=document.querySelector('#prompt-textarea');
    return el && el.getBoundingClientRect().height>0;
  },{timeout:60000});
  // Failed large submissions are persisted by ChatGPT as drafts. Remove only
  // those unsent attachments and text before starting the next mapped chat.
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button[aria-label^="Remove file "]')) button.click();
  });
  await page.focus('#prompt-textarea');
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await new Promise(r=>setTimeout(r,400));
  log('New-chat composer reset and verified ready.');
}

async function enableTemporaryChat(page, log) {
  const readControl=()=>page.waitForFunction(()=>{
    const nodes=[...document.querySelectorAll('button,[role="button"]')];
    const button=nodes.find(el=>/temporary chat|chat tempor[aá]rio/i.test(
      `${el.getAttribute('aria-label')||''} ${el.innerText||''} ${el.title||''}`
    ));
    if(!button) return null;
    return {label:(button.getAttribute('aria-label')||button.innerText||button.title||'').trim()};
  },{timeout:30_000,polling:250}).then(handle=>handle.jsonValue());
  let control=await readControl();
  for(let attempt=0;attempt<3 && !/^turn off temporary chat$|^desativar (?:o )?chat tempor[aá]rio$/i.test(control.label);attempt++) {
    await page.evaluate(()=>{
      const nodes=[...document.querySelectorAll('button,[role="button"]')];
      const button=nodes.find(el=>/temporary chat|chat tempor[aá]rio/i.test(
        `${el.getAttribute('aria-label')||''} ${el.innerText||''} ${el.title||''}`
      ));
      if(!button) throw new Error('Temporary chat control disappeared');
      button.click();
    });
    const active=await page.waitForFunction(()=>{
      const nodes=[...document.querySelectorAll('button,[role="button"]')];
      return nodes.some(el=>/^turn off temporary chat$|^desativar (?:o )?chat tempor[aá]rio$/i.test(
        (el.getAttribute('aria-label')||el.innerText||el.title||'').trim()
      ));
    },{timeout:4_000,polling:250}).then(()=>true).catch(()=>false);
    if(active) break;
    control=await readControl();
  }
  control=await readControl();
  if(!/^turn off temporary chat$|^desativar (?:o )?chat tempor[aá]rio$/i.test(control.label))
    throw new Error(`Temporary chat mode did not activate; current control label: ${control.label||'unknown'}`);
  log('Temporary ChatGPT mode verified active.');
}

async function readProviderRejection(page) {
  return page.evaluate(activeProviderRejection).catch(()=> '');
}

async function waitForStreamingDone(page, log, beforeTurnId, requestDeadline, submittedUserTurnId=null) {
  // The previous assistant turn identity must be measured BEFORE submission.
  // A count is unsafe because ChatGPT virtualizes old turns and can keep the
  // count unchanged while replacing the visible DOM nodes.
  if (beforeTurnId === undefined) {
    beforeTurnId = await page.evaluate(() =>
      [...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1)
        ?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || null
    );
  }
  log(`waitForStreamingDone: beforeTurnId=${beforeTurnId || '<none>'} submittedUserTurnId=${submittedUserTurnId || '<none>'}`);

  // Phase 1 — wait for a new assistant turn, while recognizing provider-side
  // rejection banners immediately instead of converting them into a 5-minute
  // timeout.
  let responseTurnId = null;
  try {
    const initialStartDeadline=Math.min(
      requestDeadline,
      Date.now()+RESPONSE_START_TIMEOUT
    );
    let activityObserved=false;
    let emptyCompletedSince=0;
    while(Date.now()<(activityObserved?requestDeadline:initialStartDeadline)) {
      const rejection=await readProviderRejection(page);
      if(rejection) throw new Error(`ChatGPT rejected the request: ${rejection}`);
      const phase=await page.evaluate(({before,submittedUser}) => {
        const turns=[...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
        const userIndex=submittedUser ? turns.findIndex(turn=>turn.getAttribute('data-testid')===submittedUser) : -1;
        const eligible=userIndex>=0 ? turns.slice(userIndex+1) : turns;
        // Native ChatGPT image turns may contain large generated images but no
        // [data-message-author-role="assistant"] node at all. They are still
        // the answer to this submitted user turn, not a timeout.
        const hasGeneratedMedia=turn=>[...turn.querySelectorAll('img[src],a[href]')].some(el=>
          el.tagName==='IMG' ? (el.naturalWidth||0)>=128 && (el.naturalHeight||0)>=128
            : el.hasAttribute('download') || /\/mnt\/data|oaiusercontent|download|files\//i.test(el.href||''));
        const latestTurn=eligible.filter(turn=>!turn.querySelector('[data-message-author-role="user"]')
          && (turn.querySelector('[data-message-author-role="assistant"]')||hasGeneratedMedia(turn))).at(-1);
        const currentAssistant=latestTurn?.querySelector('[data-message-author-role="assistant"]');
        const turn=latestTurn?.getAttribute('data-testid');
        const text=(currentAssistant?.innerText||'').trim();
        const progressOnly=/^(?:analyzing|thinking|working|generating|processing|stopping thinking)(?:\.{0,3}|\s+\d+%)?$/i.test(text);
        const media=[...(latestTurn?.querySelectorAll('img[src],a[href]')||[])].some(el=>{
          if(el.tagName==='IMG') return (el.naturalWidth||0)>=128 && (el.naturalHeight||0)>=128;
          return el.hasAttribute('download') || /\/mnt\/data|oaiusercontent|download|files\//i.test(el.href||'');
        });
        const started=!!turn && turn!==before && ((!progressOnly&&text)||media) ? {turn,text:(!progressOnly&&text)||'[media started]'} : null;
        const busy=!!document.querySelector('button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop answering"],button[aria-label^="Parar "],[data-is-streaming="true"]');
        const completedEmpty=!!turn && turn!==before && !!currentAssistant
          && !text && !media && !busy
          && !!latestTurn?.querySelector('button[data-testid="copy-turn-action-button"]');
        return {started,busy,completedEmpty};
      },{before:beforeTurnId,submittedUser:submittedUserTurnId}).catch(()=>null);
      if(phase?.busy&&!activityObserved) {
        activityObserved=true;
        log('Visible ChatGPT processing detected before assistant turn; preserving the active generation until the request deadline');
      }
      const started=phase?.started;
      if(phase?.completedEmpty) {
        if(!emptyCompletedSince) emptyCompletedSince=Date.now();
        if(Date.now()-emptyCompletedSince>=8_000) {
          const error=new Error('ChatGPT completed an empty assistant turn');
          error.code='CHATGPT_COMPLETED_EMPTY_TURN';
          throw error;
        }
      } else emptyCompletedSince=0;
      if(started) {
        responseTurnId=started.turn;
        if(/message you submitted was too long|please edit it and resubmit|request is too large/i.test(started.text))
          throw new Error(`ChatGPT rejected the request: ${started.text.slice(0,500)}`);
        break;
      }
      await new Promise(r=>setTimeout(r,1000));
    }
    if(Date.now()>=(activityObserved?requestDeadline:initialStartDeadline)) {
      const error=new Error(activityObserved
        ? 'Timed out waiting for ChatGPT to publish its assistant turn after visible processing'
        : 'Timed out waiting for ChatGPT to start responding');
      error.code='CHATGPT_RESPONSE_START_TIMEOUT';
      throw error;
    }
  } catch(err) {
    // On timeout, dump the DOM state to the log for debugging
    const dump = await page.evaluate(() => {
      const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
        .map(el => el.innerText.trim().slice(0, 100));
      const allRoles = [...document.querySelectorAll('[data-message-author-role]')]
        .map(el => `${el.getAttribute('data-message-author-role')}: ${(el.innerText||'').trim().slice(0,80)}`);
      const buttons = [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim().slice(0,30)).filter(Boolean);
      const url = location.href;
      return { assistants, allRoles, buttons: buttons.slice(0,15), url };
    }).catch(() => ({ error: 'page.evaluate failed' }));
    log(`waitForStreamingDone TIMEOUT dump: ${JSON.stringify(dump)}`);
    throw err;
  }

  // A pause in token output is NOT completion. The response must belong to
  // this submitted turn and have a final action or an idle generation control.
  // The deadline is a safety failure, never a signal to resubmit the prompt.
  let lastText = '';
  let stableCount = 0;
  let stableEnvelope = '';
  let envelopeSince = 0;
  let stablePlainText = '';
  let plainTextSince = 0;
  let stableMedia = '';
  let mediaSince = 0;
  let stableDownloadText = '';
  let downloadTextSince = 0;
  const deadline = requestDeadline;
  while (stableCount < 3) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for final response; partial text not returned');
    const rejection=await readProviderRejection(page);
    if(rejection) throw new Error(`ChatGPT rejected the request: ${rejection}`);
    await new Promise(r => setTimeout(r, 1000));
    const state = await page.evaluate(expectedTurnId => {
      const turn = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')].filter(turn=>!turn.querySelector('[data-message-author-role="user"]')).at(-1);
      const turnId=turn?.getAttribute('data-testid') || null;
      const last = turn?.querySelector('[data-message-author-role="assistant"]');
      const codes=last?.querySelectorAll('pre code');
      let envelope='';
      if(codes?.length===1) {
        const raw=codes[0].textContent.trim();
        try {
          const obj=JSON.parse(raw);
          if(obj && Array.isArray(obj.thoughts) && typeof obj.headline==='string'
            && typeof obj.tool_name==='string' && obj.tool_args && typeof obj.tool_args==='object'
            && (obj.tool_name!=='response' || typeof obj.tool_args.text==='string')) envelope=raw;
          if(obj && Object.keys(obj).length===1 && typeof obj.browser_utility_text==='string') envelope=raw;
        } catch {}
      }
      const media=[...(turn?.querySelectorAll('img[src],a[href]')||[])].flatMap(el=>{
        if(el.tagName==='IMG') return (el.naturalWidth||0)>=128 && (el.naturalHeight||0)>=128 ? [`img:${el.currentSrc||el.src}:${el.naturalWidth}x${el.naturalHeight}`] : [];
        return el.hasAttribute('download') || /\/mnt\/data|oaiusercontent|download|files\//i.test(el.href||'') ? [`file:${el.href}`] : [];
      }).sort().join('|');
      return {turnId,expectedTurnId,isExpected:turnId===expectedTurnId,text:last?.innerText || '',envelope,media,
        hasCodeBlock:!!codes?.length,
        failed:!!turn?.querySelector('button[data-testid="regenerate-thread-error-button"]'),
        busy:!!document.querySelector('button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop answering"],button[aria-label^="Parar "],[data-is-streaming="true"]'),
        final:!!turn?.querySelector('button[data-testid="copy-turn-action-button"],button[data-testid="good-response-turn-action-button"],button[data-testid="bad-response-turn-action-button"]')};
    },responseTurnId);
    if(!state.isExpected) continue;
    if(state.failed) throw new Error('ChatGPT rejected the request: '+state.text.slice(0,180));
    if (!state.busy && state.final && state.text && state.text === lastText) stableCount++;
    else stableCount = 0;
    if(Date.now()>deadline-1500) log(`final timeout state: ${JSON.stringify(state).slice(0,4000)}`);
    lastText = state.text;
    // A fenced Agent Zero JSON tool call can contain installer URLs and the
    // word "Download" inside its code string. It is never a downloadable-file
    // answer. Let the envelope branch below return the verbatim code instead
    // of rendered Markdown (which begins with the UI label "JSON").
    const downloadText=isDownloadTextCandidate(state) ? state.text : '';
    if(downloadText && downloadText===stableDownloadText) {
      if(!downloadTextSince) downloadTextSince=Date.now();
      if(canCollectCompletedTurn(state,Date.now()-downloadTextSince,2000)) {
        if (/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(page.url()))
          fs.writeFileSync(SESSION_FILE, page.url(), 'utf8');
        log('Completed downloadable-file response; collecting artifacts');
        return state.text;
      }
    } else { stableDownloadText=downloadText; downloadTextSince=downloadText?Date.now():0; }
    if(state.media && state.media===stableMedia) {
      if(!mediaSince) mediaSince=Date.now();
      if(canCollectCompletedTurn(state,Date.now()-mediaSince,2000)) {
        log('Completed native media response; collecting artifacts');
        return state.text || 'Mídia pronta.';
      }
    } else { stableMedia=state.media||''; mediaSince=state.media?Date.now():0; }
    if(state.envelope && state.envelope===stableEnvelope) {
      if(canCollectCompletedTurn(state,Date.now()-envelopeSince,2000)) {
        // A complete machine envelope is the entire A0 response, but do not
        // cancel a still-active model merely because its text paused.
        const current=await extractLastAssistantMessage(page);
        if(current!==state.envelope) throw new Error('Response changed while recovering stalled generation');
        if (/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(page.url()))
          fs.writeFileSync(SESSION_FILE, page.url(), 'utf8');
        log('Completed JSON envelope; mapped chat kept visible');
        return state.envelope;
      }
    } else {stableEnvelope=state.envelope;envelopeSince=Date.now();}
    // A complete plain response may lack a Copy action. Require an idle
    // generation control; do not click Stop just because the text paused.
    if(!state.envelope && state.text?.trim() && !/^(?:analyzing|thinking|working|generating|processing)(?:\.{0,3}|\s+\d+%)?$/i.test(state.text.trim())) {
      if(state.text===stablePlainText) {
        if(canCollectCompletedTurn(state,Date.now()-plainTextSince,3000)) {
          // Read the rendered text and the transport value from the SAME turn
          // in one DOM snapshot. A fenced JSON response renders with a code
          // block label, while the transport correctly extracts raw code;
          // comparing those two different representations falsely reported a
          // changed response and made Agent Zero see an empty model turn.
          const current=await page.evaluate(expectedTurnId => {
            const turn=[...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
              .filter(el=>!el.querySelector('[data-message-author-role="user"]')).at(-1);
            if(turn?.getAttribute('data-testid')!==expectedTurnId) return null;
            const last=turn.querySelector('[data-message-author-role="assistant"]');
            if(!last) return null;
            const rendered=last.innerText.trim();
            const blocks=last.querySelectorAll('pre code');
            let raw=rendered;
            if(blocks.length===1) {
              const code=blocks[0].textContent.trim();
              try { if(JSON.parse(code)!==null) raw=code; } catch {}
            }
            return {rendered,raw};
          },responseTurnId);
          if(!current || current.rendered!==state.text.trim() || !current.raw.trim()) {
            stablePlainText=''; plainTextSince=0;
            continue;
          }
          log('Completed plain response; mapped chat kept visible');
          return current.raw;
        }
      } else { stablePlainText=state.text; plainTextSince=Date.now(); }
    } else { stablePlainText=''; plainTextSince=0; }
  }
}

async function extractLastAssistantMessage(page) {
  return page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      const blocks = last.querySelectorAll('pre code');
      // Machine JSON must be read verbatim, not from rendered Markdown.
      if (blocks.length === 1) {
        const code = blocks[0].textContent.trim();
        try {
          const parsed = JSON.parse(code);
          if (parsed !== null && typeof parsed === 'object') return code;
        } catch { /* preserve visible response for bounded format retry */ }
      }
      return last.innerText.trim();
    }
    // Never fall back to arbitrary prose from another turn/page.
    return null;
  });
}

// ─── Daemon process ───────────────────────────────────────────────────────────

async function startDaemonProcess() {
  const logStream = fs.createWriteStream(DAEMON_LOG, { flags: 'a' });
  const log = msg => logStream.write(`[${new Date().toISOString()}] ${msg}\n`);

  log('Daemon starting...');

  let browser, page;
  try {
    browser = await launchBrowser();
    page    = await browser.newPage();

    const initUrl = fs.existsSync(SESSION_FILE)
      ? fs.readFileSync(SESSION_FILE, 'utf8').trim()
      : CHATGPT_URL;

    log(`Navigating to ${initUrl}`);
    await page.goto(
      initUrl.startsWith('https://chatgpt.com') ? initUrl : CHATGPT_URL,
      { waitUntil: 'domcontentloaded', timeout: 60_000 }
    );

    const loggedOut = await page.evaluate(() => {
      const hasLoginBtn = [...document.querySelectorAll('button, a')]
        .some(el => ['Log in', 'Sign in'].includes(el.textContent.trim()));
      const hasInput = !!document.querySelector('#prompt-textarea');
      return hasLoginBtn && !hasInput;
    });

    if (loggedOut) {
      log('ERROR: Not logged in. Run: node chatgpt.js --login');
      await browser.close();
      process.exit(1);
    }

    log('Browser ready and logged in.');
  } catch (err) {
    log(`Startup error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }

  // Serialize requests — ChatGPT is one-at-a-time.
  let busy = false;

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/status') {
      return send(200, { ok: true, pid: process.pid, busy, url: page.url().split('?')[0] });
    }

    if (req.method === 'POST' && req.url === '/focus') {
      if (busy) return send(409, {ok:false, busy:true, url:page.url().split('?')[0]});
      let body='';
      req.on('data', chunk => { body += chunk; if(body.length>4096) req.destroy(); });
      req.on('end', async()=>{
        let target;
        try { target=JSON.parse(body).chatUrl; } catch { return send(400,{ok:false}); }
        if(!/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(target)) return send(400,{ok:false});
        busy=true;
        try {
          if(page.url().split('?')[0]!==target) await page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
          send(200,{ok:true,url:page.url().split('?')[0]});
        } catch(error) { send(503,{ok:false,error:error.message}); }
        finally { busy=false; }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/diagnostics') {
      const browserState=await page.evaluate(() => ({
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        languages: navigator.languages,
        hasChromeObject: Boolean(globalThis.chrome),
        url: location.href,
        lastAssistant: ([...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1)?.innerText||'').slice(0,2000),
        lastMedia: [...([...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1)?.querySelectorAll('img[src],a[href]')||[])].map(el=>({tag:el.tagName,src:el.currentSrc||el.src||el.href||'',w:el.naturalWidth||0,h:el.naturalHeight||0,download:el.getAttribute('download')})).slice(-20),
        turnSummary: [...document.querySelectorAll('[data-testid^="conversation-turn-"]')].slice(-8).map(turn=>({
          id:turn.getAttribute('data-testid'),
          roles:[...turn.querySelectorAll('[data-message-author-role]')].map(el=>el.getAttribute('data-message-author-role')),
          text:(turn.innerText||'').slice(0,500),
          media:[...turn.querySelectorAll('img[src],a[href]')].map(el=>({tag:el.tagName,src:el.currentSrc||el.src||el.href||'',w:el.naturalWidth||0,h:el.naturalHeight||0})).filter(item=>item.tag==='A'||item.w>=128||item.h>=128).slice(-12),
          controls:[...turn.querySelectorAll('button')].map(el=>el.getAttribute('aria-label')||el.getAttribute('data-testid')||el.innerText).filter(Boolean).slice(-12),
        })),
        busy: !!document.querySelector('button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop answering"],button[aria-label^="Parar "],[data-is-streaming="true"]'),
        bodyTail: (document.body?.innerText||'').slice(-5000),
        controls: [...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')||b.getAttribute('data-testid')||b.innerText).filter(Boolean).slice(-50),
        downloadHtml: [...document.querySelectorAll('button')].filter(b=>(b.getAttribute('aria-label')||b.innerText||'').includes('Download file')).slice(-10).map(b=>b.outerHTML.slice(0,2000)),
      }));
      browserState.activeProviderRejection=await readProviderRejection(page);
      browserState.composerImageUpload=await imageComposerState(page);
      browserState.largeImages=await page.evaluate(()=>[...document.querySelectorAll('img')]
        .filter(img=>{const r=img.getBoundingClientRect();return r.width>=48 && r.height>=48;})
        .slice(-8).map(img=>({complete:img.complete,width:img.naturalWidth,height:img.naturalHeight,
          inForm:Boolean(img.closest('form')),testid:img.closest('[data-testid]')?.getAttribute('data-testid')||''})));
      return send(200, { ok: true, browser: browserState });
    }

    if (req.method === 'POST' && req.url === '/collect-artifacts') {
      try { return send(200,{ok:true,artifacts:await collectAssistantArtifacts(page,log)}); }
      catch(error) { return send(500,{ok:false,error:error.message}); }
    }

    if (req.method === 'POST' && req.url === '/stop') {
      send(200, { ok: true });
      log('Shutting down...');
      server.close();
      await browser.close().catch(() => {});
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      process.exit(0);
    }

    if (req.method === 'POST' && req.url === '/ask') {
      if (busy) return send(503, { ok: false, error: 'Daemon busy — try again in a moment.' });
      busy = true;

      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        const {
          fullPrompt, codeOnly, newChat, temporaryChat=false, uploadPath, uploadPaths, chatUrl, expectedArtifact, contextId='',
          reloadBeforeAttempt=false, requestTimeoutMs=REQUEST_TIMEOUT,
        } = JSON.parse(body);
        const boundedRequestTimeout=Math.max(
          1_000,
          Math.min(MAX_REQUEST_TIMEOUT, Number(requestTimeoutMs) || REQUEST_TIMEOUT)
        );
        const requestDeadline=Date.now()+boundedRequestTimeout;
        const remainingTimeout=(cap=60_000)=>Math.max(
          1_000,
          Math.min(cap, requestDeadline-Date.now())
        );
        const requestUploads=[...new Set([...(Array.isArray(uploadPaths)?uploadPaths:[]),...(uploadPath?[uploadPath]:[])])];
        const safeExpected=typeof expectedArtifact==='string' && /^[A-Za-z0-9._-]+$/.test(expectedArtifact)
          ? expectedArtifact : '';
        const textArtifactMatches=[...fullPrompt.matchAll(/\b([A-Za-z0-9._-]+\.(?:txt|md|json|xml|ya?ml|html?|svg|py|js|ts|jsx|tsx|java|c|cpp|h|hpp|cs|go|rs|php|rb|sh|ps1|bat|sql|css|toml|ini|cfg|conf|log|gltf|obj|ply|stl|dae|dxf|feather))\b/ig)];
        // Prefer the filename explicitly derived by the gateway from the
        // latest real user turn. Searching the whole protocol transcript used
        // to select stale filenames embedded in old tool output.
        const textArtifactMatch=safeExpected
          ? [safeExpected,safeExpected]
          : (/\b(?:crie|criar|create|generate|gere|arquivo|file|anexo|attachment|download|baix[aá]vel)\b/i.test(fullPrompt)
              ? textArtifactMatches.at(-1) : null);
        const artifactEnvelopeInstruction=textArtifactMatch
          ? `\n\nCompatibility requirement: also include the exact bytes of ${textArtifactMatch[1]} as standard base64 using exactly this envelope (in addition to the normal attachment):\nA0_ARTIFACT_BASE64_BEGIN ${textArtifactMatch[1]}\n<base64 without commentary>\nA0_ARTIFACT_BASE64_END`
          : '';
        const promptToSend=fullPrompt+artifactEnvelopeInstruction;
        log(`ask: newChat=${newChat} reload=${reloadBeforeAttempt} budgetMs=${boundedRequestTimeout} codeOnly=${codeOnly} uploads=${requestUploads.map(p=>path.basename(p)).join(',')||'none'} chatUrl=${chatUrl||'none'} len=${promptToSend.length}`);

        try {
          if (reloadBeforeAttempt) {
            log('Recovery attempt: reloading the current ChatGPT page once');
            await page.reload({
              waitUntil:'domcontentloaded',
              timeout:remainingTimeout(),
            });
            await page.waitForSelector('#prompt-textarea', {
              timeout:remainingTimeout(),
            });
          }

          const currentUrl = page.url().split('?')[0];

          if (chatUrl) {
            if (!/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(chatUrl)) throw new Error('Invalid conversation URL');
            if (currentUrl !== chatUrl) {
              log(`Switching to mapped chat URL: ${chatUrl}`);
              await page.goto(chatUrl, {
                waitUntil:'domcontentloaded',
                timeout:remainingTimeout(),
              });
              await page.waitForSelector('#prompt-textarea', {
                timeout:remainingTimeout(),
              });
            } else {
              log(`Reusing mapped chat without reload: ${chatUrl}`);
            }
            if (page.url().split('?')[0] !== chatUrl) throw new Error('Conversation not accessible; refusing another chat');
          } else if (newChat) {
            log('Starting new chat with one fresh page load...');
            await page.goto(CHATGPT_URL, {
              waitUntil:'domcontentloaded',
              timeout:remainingTimeout(),
            });
            if(temporaryChat) await enableTemporaryChat(page,log);
            await resetNewChatComposer(page, log);
            await page.waitForFunction(() => !document.querySelector('[data-message-author-role="assistant"]')
              && !!document.querySelector('#prompt-textarea'), {timeout:remainingTimeout()});
          } else if (!currentUrl.startsWith('https://chatgpt.com')) {
            // Tab drifted (e.g. browser opened a link) — restore
            const sessionUrl = fs.existsSync(SESSION_FILE)
              ? fs.readFileSync(SESSION_FILE, 'utf8').trim()
              : CHATGPT_URL;
            log(`Restoring tab to ${sessionUrl}`);
            await page.goto(sessionUrl, {
              waitUntil:'domcontentloaded',
              timeout:remainingTimeout(),
            });
            await page.waitForSelector('#prompt-textarea', {
              timeout:remainingTimeout(),
            });
          }
          // else: already on the right chat page, skip navigation entirely

          // Requests are serialized. Therefore a stop-generation control that
          // is already present before this request starts cannot belong to the
          // new request; it is a stale UI remnant from the completed previous
          // turn. Quiesce it and reload this same mapped chat once so the next
          // prompt can actually be submitted.
          if(chatUrl) {
            const staleStop=await page.$('button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop answering"],button[aria-label^="Parar "]');
            if(staleStop) {
              log('Stale generation control detected before submission; stopping it and reloading the same mapped chat');
              await staleStop.click().catch(()=>{});
              await new Promise(r=>setTimeout(r,500));
              await page.reload({waitUntil:'domcontentloaded',timeout:remainingTimeout()});
              await page.waitForSelector('#prompt-textarea',{timeout:remainingTimeout()});
              if(page.url().split('?')[0]!==chatUrl) throw new Error('Stale-generation recovery left the mapped conversation');
            }
          }

          // A generated-file preview or a partially hydrated ChatGPT route can
          // leave the mapped conversation visible but remove/hide the composer.
          // Do not spend the entire response-start budget waiting on that
          // broken page. First dismiss overlays, then reload this same chat once
          // only when the composer is still unavailable after a bounded probe.
          await dismissBlockingOverlays(page, log);
          const composerReady=await page.waitForFunction(()=>{
            const el=document.querySelector('#prompt-textarea');
            return el && el.getBoundingClientRect().height>0 && (el.isContentEditable || el.tagName==='TEXTAREA');
          },{timeout:8_000,polling:250}).then(()=>true).catch(()=>false);
          if(!composerReady) {
            if(!chatUrl) throw new Error('ChatGPT composer unavailable on the new-chat page');
            log('Mapped chat has no usable composer after 8s; reloading this same conversation once');
            await page.reload({waitUntil:'domcontentloaded',timeout:remainingTimeout()});
            await page.waitForFunction(()=>{
              const el=document.querySelector('#prompt-textarea');
              return el && el.getBoundingClientRect().height>0 && (el.isContentEditable || el.tagName==='TEXTAREA');
            },{timeout:remainingTimeout(),polling:250});
            if(page.url().split('?')[0]!==chatUrl) throw new Error('Composer recovery left the mapped conversation');
            await dismissBlockingOverlays(page, log);
          }

          // Attach first. Uploading causes ChatGPT to re-render the composer;
          // text inserted before that re-render can remain visible in the DOM
          // while being absent from React's submission state.
          if (requestUploads.length) {
            await uploadFilesToChatGPT(page, requestUploads, log);
          }
          const imageCount=imageUploadCount(requestUploads);
          const imageUploadDeadline=imageCount
            ? Math.min(requestDeadline,Date.now()+imageUploadTimeoutMs(imageCount,IMAGE_UPLOAD_TIMEOUT_MS))
            : 0;

          await dismissBlockingOverlays(page, log);
          await fillTextarea(page, promptToSend, log);
          const inserted = await page.$eval('#prompt-textarea', el => el.value ?? el.innerText);
          // ProseMirror renders paragraphs as doubled line breaks in innerText.
          // JSON transcript newlines are escaped, so normalize only DOM line
          // separators, not spaces/indentation inside transcript values.
          const normalizeComposer = normalizeComposerText;
          if (normalizeComposer(inserted) !== normalizeComposer(promptToSend)) {
            const a=normalizeComposer(inserted), b=normalizeComposer(promptToSend);
            let at=0; while(at<Math.min(a.length,b.length)&&a[at]===b[at]) at++;
            log(`Composer mismatch lengths=${a.length}/${b.length} offset=${at} codepoints=${a.charCodeAt(at)}/${b.charCodeAt(at)}`);
            throw new Error('Composer did not preserve the complete prompt; refusing to send partial context');
          }

          // If a file was uploaded, wait until the send button is enabled.
          // ChatGPT uploads the file to its servers in the background; the send
          // button stays disabled until that upload finishes.  Clicking a disabled
          // button does nothing, which is what caused the previous silent failures.
          const submitStartPath = new URL(page.url()).pathname;
          if (requestUploads.length) {
            if(imageCount) await waitForImageUploads(page,imageCount,contextId,imageUploadDeadline,log);
            else {
              log('Waiting for send button to become enabled (file upload in progress)...');
              await page.waitForFunction(
                () => {
                  const btn = document.querySelector('button[data-testid="send-button"]');
                  return btn && !btn.disabled;
                },
                { timeout: 60_000 }
              );
              log('Send button is now enabled.');
            }
          }

          // Track stable turn identity, never the virtualized message count.
          const beforeTurn = await page.evaluate(() => ({
            assistant:[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1)?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || null,
            user:[...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || null,
          }));

          // Uploaded attachments can steal the ProseMirror focus. In that state
          // Enter may be accepted without submitting anything, leaving a blank
          // ChatGPT home page until the response timeout. Use the enabled send
          // button for uploads and Enter for ordinary text, then require evidence
          // that the composer was actually submitted before waiting for a reply.
          // Clicking the enabled send control is more reliable than synthesizing
          // Enter on long-lived chats: after a provider rejection the editor can
          // look focused while ProseMirror consumes Enter as an edit operation.
          await page.waitForFunction(() => {
            const button=document.querySelector('button[data-testid="send-button"]');
            return button && !button.disabled;
          },{timeout:15000,polling:250});
          const capacityRejection=await readProviderRejection(page);
          if(capacityRejection) throw new Error(`ChatGPT rejected the request: ${capacityRejection}`);
          await dismissBlockingOverlays(page, log);
          await page.click('button[data-testid="send-button"]');
          log(requestUploads.length
            ? 'Submitted via DOM send action after attachment and composer refresh'
            : 'Submitted via verified DOM send action');
          const waitForSubmissionAck=()=>page.waitForFunction(
            ({startPath,beforeUser,temporaryChat}) => {
              const editor = document.querySelector('#prompt-textarea');
              const text = (editor?.value ?? editor?.innerText ?? '').trim();
              const currentUser=[...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || null;
              // Composer clearing alone is insufficient: a popup may consume a
              // click while React transiently redraws it. Require a new user
              // turn (or a new-chat navigation plus a user turn) as evidence.
              return !text && currentUser && currentUser!==beforeUser
                && (temporaryChat || startPath!=='/' || location.pathname.startsWith('/c/'));
            },
            { timeout: 15_000, polling: 250 },
            {startPath:submitStartPath,beforeUser:beforeTurn.user,temporaryChat}
          ).then(()=>true).catch(()=>false);
          let acknowledged=await waitForSubmissionAck();
          if(!acknowledged) {
            const retryState=await page.evaluate(beforeUser=>{
              const editor=document.querySelector('#prompt-textarea');
              const currentUser=[...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || null;
              return {composerChars:String(editor?.value ?? editor?.innerText ?? '').trim().length,currentUser,beforeUser};
            },beforeTurn.user).catch(()=>({composerChars:0,currentUser:null,beforeUser:beforeTurn.user}));
            // A long-lived ChatGPT tab can occasionally ignore a pointer click
            // even though its send button is enabled. Only retry when the full
            // draft is still present and no new user turn exists, which makes
            // the fallback idempotent and avoids duplicate messages.
            if(retryState.composerChars>0 && retryState.currentUser===retryState.beforeUser) {
              log(`Send click was ignored with ${retryState.composerChars} draft chars; retrying once via focused Enter`);
              await dismissBlockingOverlays(page,log);
              await page.focus('#prompt-textarea');
              await page.keyboard.press('Enter');
              acknowledged=await waitForSubmissionAck();
            }
          }
          if(!acknowledged && imageCount) {
            const state=await imageComposerState(page);
            if(!imageUploadReady(state,imageCount)) {
              log('Image preview became pending after send; waiting for it before one final send attempt');
              await waitForImageUploads(page,imageCount,contextId,imageUploadDeadline,log);
              await page.click('button[data-testid="send-button"]');
              acknowledged=await waitForSubmissionAck();
            }
          }
          if(!acknowledged) {
            await page.screenshot({path: path.join(STATE_DIR, 'submission-failure.png'), fullPage: false}).catch(() => {});
            const delayedRejection=await readProviderRejection(page);
            if(delayedRejection) throw new Error(`ChatGPT rejected the request: ${delayedRejection}`);
            const state = await page.evaluate(() => {
              const editor = document.querySelector('#prompt-textarea');
              const sendButton = document.querySelector('button[data-testid="send-button"]');
              return {
                path: location.pathname,
                composerChars: String(editor?.value ?? editor?.innerText ?? '').length,
                sendDisabled: sendButton?.disabled ?? null,
                sendLabel: sendButton?.getAttribute('aria-label') ?? null,
                files: [...document.querySelectorAll('[data-testid*="file"], [class*="attachment"]')].length,
                alerts: [...document.querySelectorAll('[role="alert"]')].map(el => el.innerText.trim()).filter(Boolean).slice(-3),
                capacityText: (document.body?.innerText||'').match(/(?:Messages limit reached|You(?:'|’)ve reached your (?:message|usage) limit|Limite de mensagens (?:atingido|alcançado)|Too many requests|temporarily limited access to your conversations)[^\n]*/i)?.[0]||'',
                buttons: [...document.querySelectorAll('button')].map(el => ({
                  testid: el.getAttribute('data-testid'),
                  label: el.getAttribute('aria-label'),
                  title: el.getAttribute('title'),
                })).filter(item => item.testid || item.label || item.title).slice(-20),
              };
            });
            if(state.capacityText) throw new Error(`ChatGPT rejected the request: ${state.capacityText}`);
            log(`Submission not acknowledged: ${JSON.stringify(state)}`);
            throw new Error('Prompt submission was not acknowledged');
          }
          const submittedUserTurnId=await page.evaluate(()=>
            [...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)
              ?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || null
          );
          if(!submittedUserTurnId || submittedUserTurnId===beforeTurn.user)
            throw new Error('Submitted user turn identity could not be verified');

          const immediateRejection=await readProviderRejection(page);
          if(immediateRejection) throw new Error(`ChatGPT rejected the request: ${immediateRejection}`);

          // Persist the conversation as soon as ChatGPT acknowledges the user
          // turn. If response startup stalls, the bounded recovery attempt can
          // reload and retry in this same conversation instead of opening a
          // second unrelated chat.
          const submittedUrl=page.url().split('?')[0];
          if (!temporaryChat && /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(submittedUrl)) {
            fs.writeFileSync(SESSION_FILE, submittedUrl, 'utf8');
          }

          log('Prompt sent, waiting for response...');
          const recovered = await waitForStreamingDone(
            page,
            log,
            beforeTurn.assistant,
            requestDeadline,
            submittedUserTurnId
          );

          const finalUrl = page.url();
          if (!temporaryChat && finalUrl.startsWith('https://chatgpt.com/c/')) {
            fs.writeFileSync(SESSION_FILE, finalUrl, 'utf8');
          }

          const raw = recovered || await extractLastAssistantMessage(page);
          if (!raw) throw new Error('Could not extract response from page');

          const output = codeOnly ? extractCodeBlocks(raw) : raw;
          log(`Done: ${output.length} chars; preview=${String(output).replace(/\s+/g,' ').slice(0,500)}`);
          const responseTurnId=await page.evaluate(()=>[...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
            .filter(turn=>!turn.querySelector('[data-message-author-role="user"]')).at(-1)?.getAttribute('data-testid')||null);
          const artifacts=await collectAssistantArtifacts(page,log,responseTurnId);
          if(artifacts.length) {
            const stillBusy=await page.evaluate(()=>!!document.querySelector('button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop answering"],button[aria-label^="Parar "],[data-is-streaming="true"]')).catch(()=>false);
            if(stillBusy) {
              const current=page.url().split('?')[0];
              if(/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(current)) fs.writeFileSync(SESSION_FILE,current,'utf8');
              const stop=await page.$('button[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop answering"],button[aria-label^="Parar "]');
              if(stop) await stop.click().catch(()=>{});
              log('Stopped stale generation control after artifact collection; mapped chat kept visible');
            }
          }
          if(temporaryChat) {
            await page.goto('about:blank',{waitUntil:'domcontentloaded',timeout:10_000}).catch(()=>{});
            if(fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
            log('Temporary audit tab closed and session pointer removed.');
          }
          const completedChatUrl = page.url().split('?')[0];
          send(200, { ok: true, response: output, artifacts, temporary:temporaryChat,
            chatUrl: /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(completedChatUrl) ? completedChatUrl : null });
        } catch (err) {
          log(`Error: ${err.message}`);
          // Return the URL owned by this exact request.  The global session
          // file can already point at another Agent Zero conversation when a
          // recovery starts, which used to mix chats during the retry.
          const currentChatUrl = page.url().split('?')[0];
          const requestChatUrl = /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(currentChatUrl)
            ? currentChatUrl
            : null;
          if(temporaryChat) {
            await page.goto('about:blank',{waitUntil:'domcontentloaded',timeout:10_000}).catch(()=>{});
            if(fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
            log('Failed temporary audit tab closed and session pointer removed.');
          }
          send(500, { ok: false, error: err.message, chatUrl: requestChatUrl });
        } finally {
          busy = false;
        }
      });
      return;
    }

    send(404, { ok: false, error: 'Not found' });
  });

  server.on('error', err => {
    log(`HTTP server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    log(`HTTP server listening on 127.0.0.1:${port}`);
    fs.writeFileSync(DAEMON_FILE, JSON.stringify({ port, pid: process.pid }), 'utf8');
    log('Daemon ready.');
  });

  const shutdown = async signal => {
    log(`${signal} received, shutting down`);
    if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  // never returns — stays alive as the server
}

// ─── Client helpers ───────────────────────────────────────────────────────────

function readDaemonState() {
  if (!fs.existsSync(DAEMON_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
    process.kill(state.pid, 0); // throws if PID is dead
    return state;
  } catch {
    return null;
  }
}

function httpPost(port, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error('Invalid JSON from daemon')); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function probeDaemon(port, timeoutMs=1_500) {
  return new Promise(resolve => {
    const req=http.get({hostname:'127.0.0.1',port,path:'/status'},res=>{
      let raw='';
      res.on('data',chunk=>(raw+=chunk));
      res.on('end',()=>{
        try { resolve(res.statusCode===200 && JSON.parse(raw).ok===true); }
        catch { resolve(false); }
      });
    });
    req.setTimeout(timeoutMs,()=>req.destroy());
    req.on('error',()=>resolve(false));
  });
}

async function ensureDaemon() {
  let state = readDaemonState();
  if (state && await probeDaemon(state.port)) return state.port;

  // The state directory survives Docker recreation. A PID can be reused by an
  // unrelated process in the new container, so PID liveness alone cannot
  // validate an old ephemeral port. Require the daemon's own /status response.
  if(state) process.stderr.write(`[*] Discarding stale daemon endpoint on port ${state.port}.\n`);

  if (fs.existsSync(MANUAL_LOGIN_FILE)) {
    throw new Error('Manual ChatGPT login is active in VNC. Finish the login and close the manual Chrome window before using this model.');
  }

  if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE); // clean stale file

  process.stderr.write('[*] Starting browser daemon (first time ~15s)...\n');

  const child = spawn(process.execPath, [__filename, '--daemon-internal'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1_000));
    state = readDaemonState();
    if (state) {
      await new Promise(r => setTimeout(r, 300)); // let HTTP server bind
      process.stderr.write('[*] Daemon ready.\n');
      return state.port;
    }
  }

  throw new Error('Daemon did not start. Check: cat ~/.chatgpt-poc-daemon.log');
}

// ─── Login (one-time setup, no daemon) ───────────────────────────────────────

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function login() {
  console.log('[*] Opening Chrome for login...');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('');
  console.log('  Log in to chatgpt.com in the Chrome window that opened.');
  console.log('  When fully logged in and the chat interface is visible,');
  await waitForEnter('  press Enter here to save the session: ');
  await browser.close();
  console.log('[*] Done. Run: node chatgpt.js "your prompt here"');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    login: false, codeOnly: false, file: null, upload: [], save: null,
    git: false, context: null, newChat: false, temporaryChat: false, chatUrl: null, stop: false, status: false,
    warm: false, daemonInternal: false, cwd: null, prompt: [], rawStdin: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--login':           opts.login          = true;  break;
      case '--code':            opts.codeOnly       = true;  break;
      case '--git':             opts.git            = true;  break;
      case '--new':             opts.newChat        = true;  break;
      case '--temporary':       opts.temporaryChat  = true; opts.newChat = true; break;
      case '--chat-url':          opts.chatUrl   = args[++i];    break;
      case '--raw-stdin':       opts.rawStdin       = true;  break;
      case '--stop':            opts.stop           = true;  break;
      case '--status':          opts.status         = true;  break;
      case '--warm':            opts.warm           = true;  break;
      case '--daemon-internal': opts.daemonInternal = true;  break;
      case '--file':            opts.file    = args[++i];    break;
      case '--upload':          opts.upload.push(args[++i]); break;
      case '--save':            opts.save    = args[++i];    break;
      case '--context':         opts.context = args[++i];    break;
      case '--cwd':             opts.cwd     = args[++i];    break;
      default:                  opts.prompt.push(args[i]);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage:
  node chatgpt.js --login                               # first-time setup
  node chatgpt.js "prompt"                              # continue last chat (daemon auto-starts)
  node chatgpt.js --new "prompt"                        # force a new chat
  node chatgpt.js --temporary "prompt"                  # isolated ChatGPT temporary chat
  node chatgpt.js --code "write fizzbuzz in Go"         # extract code blocks only
  node chatgpt.js --file <path> "prompt"                # paste file content as text in prompt
  node chatgpt.js --upload <path> "prompt"              # upload file via ChatGPT attachment button
  node chatgpt.js --save <path> "prompt"                # save response to a file
  node chatgpt.js --git "write a commit message"        # attach git diff/status
  node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
  cat error.log | node chatgpt.js "what is wrong"       # pipe input
  node chatgpt.js --status                              # check if daemon is running
  node chatgpt.js --warm                                # start/check daemon without sending a prompt
  node chatgpt.js --stop                                # shut down the daemon
`);
}

(async () => {
  const opts = parseArgs(process.argv);

  if (opts.daemonInternal) {
    await startDaemonProcess(); // never returns
    return;
  }

  if (opts.login) {
    await login().catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
    return;
  }

  if (opts.stop) {
    const state = readDaemonState();
    if (!state) { console.log('[*] No daemon running.'); return; }
    try {
      await httpPost(state.port, '/stop', {});
      console.log('[*] Daemon stopped.');
    } catch {
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      console.log('[*] Daemon stopped.');
    }
    return;
  }

  if (opts.status) {
    const state = readDaemonState();
    if (!state) { console.log('[*] Daemon not running.'); return; }
    console.log(`[*] Daemon running — PID ${state.pid}, port ${state.port}`);
    return;
  }

  if (opts.warm) {
    const port=await ensureDaemon();
    console.log(`[*] Daemon ready on port ${port}.`);
    return;
  }

  if (opts.prompt.length === 0 && !opts.rawStdin) {
    printHelp();
    process.exit(1);
  }

  const userPrompt  = opts.prompt.join(' ');
  const stdinData   = await readStdin();
  const fileData    = opts.file    ? readFile(opts.file)  : null;
  const gitData     = opts.git     ? getGitContext(opts.cwd || process.cwd()) : null;
  const contextData = opts.context || null;

  const fullPrompt = opts.rawStdin ? stdinData : buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData });
  if (!fullPrompt) throw new Error('Empty prompt');

  try {
    let port = await ensureDaemon();
    const askBody = {
      fullPrompt, codeOnly: opts.codeOnly, newChat: opts.newChat, temporaryChat:opts.temporaryChat, chatUrl: opts.chatUrl,
      uploadPaths: opts.upload,
      contextId: process.env.A0_CONTEXT_ID || '',
      reloadBeforeAttempt: process.env.BROWSER_RECOVERY_RELOAD === '1',
      requestTimeoutMs: Number(process.env.BROWSER_REQUEST_TIMEOUT_MS || REQUEST_TIMEOUT),
      expectedArtifact: process.env.BROWSER_EXPECTED_ARTIFACT || '',
    };
    let result;
    try {
      result=await httpPost(port,'/ask',askBody);
    } catch(error) {
      if(!['ECONNREFUSED','ECONNRESET','EPIPE'].includes(error.code)) throw error;
      // The daemon can disappear between the readiness probe and POST. Recover
      // once in-process so Agent Zero never sees a transient stale-port error.
      if(fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      process.stderr.write(`[*] Daemon connection ${error.code}; reconnecting once.\n`);
      port=await ensureDaemon();
      result=await httpPost(port,'/ask',askBody);
    }
    if (!result.ok) {
      const chatUrlMarker = result.chatUrl ? ` CHATGPT_REQUEST_URL=${result.chatUrl}` : '';
      throw new Error((result.error || 'Daemon returned an error') + chatUrlMarker);
    }
    console.log('\n--- RESPONSE ---');
    console.log(result.response);
    console.log('--- END ---\n');
    console.log('--- ARTIFACTS ---');
    console.log(JSON.stringify(result.artifacts||[]));
    console.log('--- END ARTIFACTS ---');
    console.log('--- CHAT URL ---');
    console.log(result.chatUrl || '');
    console.log('--- END CHAT URL ---');
    if (opts.save) {
      fs.writeFileSync(path.resolve(opts.save), result.response, 'utf8');
      console.error(`[*] Response saved to: ${path.resolve(opts.save)}`);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exit(1);
  }
})();
